'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { EventEmitter } = require('events');
const projects = require('../projects');

const MAX_CHANGES = 100;
// Earlier contents kept in memory for undo; beyond this the oldest changes lose theirs.
const MAX_KEPT_BYTES = 32 * 1024 * 1024;
// Deleted entries are copied before they go to the Recycle Bin, up to this size.
const MAX_BACKUP_BYTES = 20 * 1024 * 1024;

const revisionOf = (content) => createHash('sha256').update(content).digest('hex');

function sizeOf(entry, limit) {
  let total = 0;
  const visit = (file) => {
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file)) {
        visit(path.join(file, name));
        if (total > limit)
          return;
      }
    } else {
      total += stat.size;
    }
  };
  visit(entry);
  return total;
}

function samePath(a, b) {
  return process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The file changes AI clients made through the MCP tools in this session, and
 * their undo. An undo applies only while the file is as the change left it, so
 * it never overwrites later work by the user or the AI.
 *
 * Events: 'change' whenever a change is recorded or undone.
 */
class ChangeLog extends EventEmitter {
  /** @param {{ folder: string }} options folder: where deleted entries are copied; emptied now */
  constructor({ folder }) {
    super();
    this.folder = folder;
    this.changes = [];
    this.nextId = 1;
    fs.rmSync(folder, { recursive: true, force: true });
  }

  /** A file written with `content`; `before` is its earlier text, null when it was created. */
  wrote(root, relative, before, content, tool) {
    this._add({
      root,
      tool,
      kind: before === null ? 'create' : 'update',
      path: relative,
      before,
      after: revisionOf(Buffer.from(content, 'utf8')),
    });
  }

  /**
   * Copies an entry about to be deleted, so undo can put it back.
   * @returns {string | null} the copy, null when it is too large or cannot be copied
   */
  backup(entry) {
    try {
      if (sizeOf(entry, MAX_BACKUP_BYTES) > MAX_BACKUP_BYTES)
        return null;
      const copy = path.join(this.folder, String(this.nextId), path.basename(entry));
      fs.mkdirSync(path.dirname(copy), { recursive: true });
      fs.cpSync(entry, copy, { recursive: true, verbatimSymlinks: true });
      return copy;
    } catch {
      return null;
    }
  }

  deleted(root, relative, backup, tool) {
    this._add({ root, tool, kind: 'delete', path: relative, backup });
  }

  renamed(root, relative, to, tool) {
    this._add({ root, tool, kind: 'rename', path: relative, to });
  }

  /** The changes of the project at `root`, newest first, without their contents. */
  list(root) {
    return this.changes
      .filter((change) => !root || samePath(change.root, root))
      .map((change) => ({
        id: change.id, at: change.at, tool: change.tool, kind: change.kind,
        path: change.path, to: change.to || null, undone: change.undone, ...this._undoable(change),
      }))
      .reverse();
  }

  /**
   * Reverses a change.
   * @param {{ dirtyPaths: string[], trash: (entry: string) => Promise<void> }} context
   * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
   */
  async undo(id, { dirtyPaths, trash }) {
    const change = this.changes.find((item) => item.id === id);
    if (!change)
      return { ok: false, error: 'This change is no longer in the list.' };
    const { undoable, reason } = this._undoable(change);
    if (!undoable)
      return { ok: false, error: reason };
    const touched = [change.path, change.to].filter(Boolean);
    const dirty = dirtyPaths.filter((file) => touched.some((item) => samePath(file, item) || samePath(file.slice(0, item.length + 1), `${item}/`)));
    if (dirty.length)
      return { ok: false, error: `${dirty.join(', ')} ${dirty.length === 1 ? 'has' : 'have'} unsaved changes in the editor. Save or discard them first.` };
    try {
      const target = projects.resolveInProject(change.root, change.path);
      switch (change.kind) {
        case 'create':
          await trash(projects.projectEntry(change.root, change.path).entry);
          break;
        case 'update': {
          const result = projects.writeProjectFile(change.root, change.path, change.before, change.after);
          if (!result.ok)
            return { ok: false, error: `${change.path} changed while it was being restored.` };
          break;
        }
        case 'delete':
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.cpSync(change.backup, target, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
          break;
        case 'rename':
          fs.renameSync(projects.projectEntry(change.root, change.to).entry, target);
          break;
      }
    } catch (error) {
      return { ok: false, error: error.message };
    }
    change.undone = true;
    change.before = null;
    this.emit('change');
    return { ok: true };
  }

  /** Whether the change can still be undone: the disk must be as the change left it. */
  _undoable(change) {
    const no = (reason) => ({ undoable: false, reason });
    if (change.undone)
      return no('Already undone.');
    let target;
    try {
      target = projects.resolveInProject(change.root, change.path);
    } catch (error) {
      return no(error.message);
    }
    const exists = (file) => !!fs.lstatSync(file, { throwIfNoEntry: false });
    switch (change.kind) {
      case 'create':
      case 'update': {
        if (change.kind === 'update' && change.before === null)
          return no('Too old: its earlier content is no longer kept.');
        let current;
        try {
          current = revisionOf(fs.readFileSync(target));
        } catch {
          return no(`${change.path} no longer exists.`);
        }
        return current === change.after ? { undoable: true } : no(`${change.path} has changed since.`);
      }
      case 'delete':
        if (!change.backup || !exists(change.backup))
          return no('Too large to keep a copy: restore it from the Recycle Bin.');
        return exists(target) ? no(`${change.path} exists again.`) : { undoable: true };
      case 'rename': {
        let renamed;
        try {
          renamed = projects.resolveInProject(change.root, change.to);
        } catch (error) {
          return no(error.message);
        }
        if (!exists(renamed))
          return no(`${change.to} no longer exists.`);
        const caseOnly = samePath(change.path, change.to);
        return !caseOnly && exists(target) ? no(`${change.path} exists again.`) : { undoable: true };
      }
      default:
        return no('Unknown change.');
    }
  }

  _add(change) {
    this.changes.push({ id: this.nextId++, at: new Date().toISOString(), undone: false, ...change });
    if (this.changes.length > MAX_CHANGES) {
      const [oldest] = this.changes.splice(0, this.changes.length - MAX_CHANGES);
      if (oldest?.backup)
        fs.rmSync(path.dirname(oldest.backup), { recursive: true, force: true });
    }
    let kept = 0;
    for (let index = this.changes.length - 1; index >= 0; index--) {
      const item = this.changes[index];
      if (typeof item.before !== 'string')
        continue;
      kept += Buffer.byteLength(item.before);
      if (kept > MAX_KEPT_BYTES)
        item.before = null;
    }
    this.emit('change');
  }
}

module.exports = { ChangeLog };
