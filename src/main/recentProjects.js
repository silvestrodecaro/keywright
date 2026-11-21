'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic } = require('./jsonFile');

const MAX_RECENT = 12;

/** Recently opened projects, persisted as JSON in the IDE's own data folder. */
class RecentProjects {
  /** @param {string} file JSON file path (e.g. in app.getPath('userData')) */
  constructor(file) {
    this._file = file;
  }

  /** @returns {{ root: string, name: string, openedAt: string }[]} existing projects, most recent first */
  list() {
    return this._read().filter((entry) => fs.existsSync(entry.root));
  }

  add(root) {
    const entries = this._read().filter((entry) => !samePath(entry.root, root));
    entries.unshift({ root, name: path.basename(root), openedAt: new Date().toISOString() });
    this._write(entries.slice(0, MAX_RECENT));
  }

  remove(root) {
    this._write(this._read().filter((entry) => !samePath(entry.root, root)));
  }

  /** A damaged list is kept aside (readJson) and starts again empty. */
  _read() {
    const stored = readJson(this._file);
    const data = stored.status === 'ok' ? stored.value : [];
    return Array.isArray(data) ? data.filter((entry) => entry && typeof entry.root === 'string') : [];
  }

  _write(entries) {
    writeJsonAtomic(this._file, entries, { space: 2 });
  }
}

function samePath(a, b) {
  const normalize = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return normalize(a) === normalize(b);
}

module.exports = { RecentProjects };
