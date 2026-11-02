'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// Never reported: tool folders, caches, and files written while tests run.
const IGNORED_DIRS = new Set(['.git', '.venv', 'venv', 'node_modules', '__pycache__', '.pytest_cache', '.idea', '.vscode']);
const IGNORED_FILES = /(\.pyc|~|\.swp|\.tmp)$|^(log|report)\.html$|^output\.xml$|^playwright-log\.txt$/i;

/**
 * Watches a project folder and reports changed files (project-relative, `/`
 * separated), debounced so that a save or a `git checkout` is one event.
 *
 * Events: 'changes' (paths: string[])
 */
class ProjectWatcher extends EventEmitter {
  /**
   * @param {string} root
   * @param {{ ignore?: string[], delay?: number }} [options]
   *   ignore: extra project-relative folders (e.g. the results folder)
   */
  constructor(root, { ignore = [], delay = 300 } = {}) {
    super();
    this._root = root;
    this._ignore = ignore.map((dir) => dir.replace(/\\/g, '/').replace(/\/+$/, '')).filter(Boolean);
    this._delay = delay;
    this._pending = new Set();
    this._timer = null;
    this._watcher = null;
    this._watchedRoot = root;
  }

  start() {
    if (this._watcher)
      return;
    // Windows: watching an 8.3 short path (C:\Users\ABCDEF~1\...) aborts the
    // process on a libuv assertion, so watch the long form of the path.
    let root = this._root;
    try {
      root = fs.realpathSync.native(root);
    } catch {
      // keep the given path; fs.watch reports the error below
    }
    this._watchedRoot = root;
    this._watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (filename)
        this._record(filename.toString());
    });
    this._watcher.on('error', () => this.stop()); // e.g. the project folder was deleted
  }

  stop() {
    clearTimeout(this._timer);
    this._pending.clear();
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
  }

  /** True when `relative` is reported (not inside an ignored folder or file). */
  accepts(relative) {
    const parts = relative.split('/');
    if (parts.some((part) => IGNORED_DIRS.has(part)) || IGNORED_FILES.test(parts[parts.length - 1]))
      return false;
    return !this._ignore.some((dir) => relative === dir || relative.startsWith(dir + '/'));
  }

  _record(filename) {
    const relative = filename.split(path.sep).join('/');
    if (!this.accepts(relative))
      return;
    // A folder is reported when its content changes: only its files matter.
    try {
      if (fs.statSync(path.join(this._watchedRoot, filename)).isDirectory())
        return;
    } catch {
      // deleted: report it
    }
    this._pending.add(relative);
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      const paths = [...this._pending].sort();
      this._pending.clear();
      this.emit('changes', paths);
    }, this._delay);
  }
}

module.exports = { ProjectWatcher };
