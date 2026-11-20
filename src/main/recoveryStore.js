'use strict';

const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic, retrying } = require('./jsonFile');

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
    let stored;
    try {
      stored = readJson(this._file(root)); // a damaged file is kept aside, so the next save cannot delete it
    } catch (error) {
      console.error(`Could not read the recovery copies: ${error.message}`);
      return [];
    }
    const data = stored.status === 'ok' ? stored.value : null;
    if (!data || normalize(data.root) !== normalize(root) || !Array.isArray(data.files))
      return [];
    return data.files.filter((entry) => entry && typeof entry.path === 'string' && typeof entry.content === 'string'
      && (typeof entry.revision === 'string' || entry.revision === null))
      .map(({ path: file, content, revision }) => ({ path: file, content, revision }));
  }

  /** Replaces the stored buffers of a project; an empty list removes its file. */
  write(root, entries) {
    if (!entries.length)
      return this.clear(root);
    const files = entries.map(({ path: file, content, revision }) => ({ path: file, content, revision: revision ?? null }));
    writeJsonAtomic(this._file(root), { root: path.resolve(root), savedAt: new Date().toISOString(), files });
  }

  clear(root) {
    retrying(() => fs.rmSync(this._file(root), { force: true }));
  }

  /** Removes temporary files left by writes that a crash interrupted. */
  removeLeftovers() {
    let names;
    try {
      names = fs.readdirSync(this._folder);
    } catch {
      return;
    }
    for (const name of names.filter((item) => item.endsWith('.tmp')))
      fs.rmSync(path.join(this._folder, name), { force: true });
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
