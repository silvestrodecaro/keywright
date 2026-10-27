'use strict';

const fs = require('fs');
const path = require('path');

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

  _read() {
    try {
      const data = JSON.parse(fs.readFileSync(this._file, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  _write(entries) {
    fs.mkdirSync(path.dirname(this._file), { recursive: true });
    fs.writeFileSync(this._file, JSON.stringify(entries, null, 2));
  }
}

function samePath(a, b) {
  const normalize = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return normalize(a) === normalize(b);
}

module.exports = { RecentProjects };
