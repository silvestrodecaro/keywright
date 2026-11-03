'use strict';

const { createHash, randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Unsaved editor buffers kept in the IDE's data folder, one JSON file per project,
 * so they can be offered again after a crash or a forced close. Each entry records
 * the disk revision the edits started from: a file that changed meanwhile then
 * goes through the normal save conflict.
 */
class RecoveryStore {
  /** @param {string} folder e.g. path.join(app.getPath('userData'), 'recovery') */
  constructor(folder) {
    this._folder = folder;
  }

  /** @returns {{ path: string, content: string, revision: string|null }[]} */
  read(root) {
    try {
      const data = JSON.parse(fs.readFileSync(this._file(root), 'utf8'));
      if (!data || normalize(data.root) !== normalize(root) || !Array.isArray(data.files))
        return [];
      return data.files.filter((entry) => entry && typeof entry.path === 'string' && typeof entry.content === 'string'
        && (typeof entry.revision === 'string' || entry.revision === null))
        .map(({ path: file, content, revision }) => ({ path: file, content, revision }));
    } catch {
      return [];
    }
  }

  /** Replaces the stored buffers of a project; an empty list removes its file. */
  write(root, entries) {
    if (!entries.length)
      return this.clear(root);
    fs.mkdirSync(this._folder, { recursive: true });
    const target = this._file(root);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const files = entries.map(({ path: file, content, revision }) => ({ path: file, content, revision: revision ?? null }));
    fs.writeFileSync(temporary, JSON.stringify({ root: path.resolve(root), savedAt: new Date().toISOString(), files }));
    fs.renameSync(temporary, target);
  }

  clear(root) {
    fs.rmSync(this._file(root), { force: true });
  }

  _file(root) {
    return path.join(this._folder, createHash('sha256').update(normalize(root)).digest('hex').slice(0, 24) + '.json');
  }
}

function normalize(root) {
  if (typeof root !== 'string')
    return null;
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

module.exports = { RecoveryStore };
