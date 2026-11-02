'use strict';

const { spawn } = require('child_process');
const { HELPER, pythonEnv } = require('./pythonHelper');

const REQUEST_TIMEOUT = 15_000;

/**
 * A long-running `rfide_runner.py serve` process in the project's Python, so
 * the editor can check unsaved content without paying Robot's import time on
 * every keystroke. Started lazily and restarted after a crash.
 */
class LanguageWorker {
  /** @param {string} python  @param {string} cwd */
  constructor(python, cwd) {
    this._python = python;
    this._cwd = cwd;
    this._child = null;
    this._buffer = '';
    this._nextId = 1;
    /** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
    this._pending = new Map();
    this._disposed = false;
  }

  /** The Python executable this worker runs with. */
  get python() {
    return this._python;
  }

  /**
   * @param {string} command
   * @param {object} params
   * @returns {Promise<object>} the response fields (without id/ok)
   */
  request(command, params = {}) {
    if (this._disposed)
      return Promise.reject(new Error('The language worker was stopped.'));
    const child = this._ensureStarted();
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`No answer to "${command}" from the Python helper.`));
      }, REQUEST_TIMEOUT);
      this._pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, command, ...params }) + '\n');
    });
  }

  dispose() {
    this._disposed = true;
    if (this._child)
      this._child.kill();
    this._failAll(new Error('The language worker was stopped.'));
  }

  _ensureStarted() {
    if (this._child)
      return this._child;
    const child = spawn(this._python, [HELPER, 'serve'], { cwd: this._cwd, env: pythonEnv(), windowsHide: true });
    this._child = child;
    this._buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onData(chunk));
    child.stderr.on('data', () => {}); // library import noise
    child.stdin.on('error', () => {});
    const onExit = () => {
      if (this._child === child)
        this._child = null;
      this._failAll(new Error('The Python helper stopped unexpectedly.'));
    };
    child.on('exit', onExit);
    child.on('error', onExit);
    return child;
  }

  _onData(chunk) {
    this._buffer += chunk;
    let newline;
    while ((newline = this._buffer.indexOf('\n')) >= 0) {
      const line = this._buffer.slice(0, newline).trim();
      this._buffer = this._buffer.slice(newline + 1);
      if (!line)
        continue;
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        continue; // not a response (e.g. a library printing to stdout)
      }
      const pending = this._pending.get(response.id);
      if (!pending)
        continue;
      this._pending.delete(response.id);
      clearTimeout(pending.timer);
      const { id, ok, error, ...result } = response;
      if (ok)
        pending.resolve(result);
      else
        pending.reject(new Error(error));
    }
  }

  _failAll(error) {
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this._pending.clear();
  }
}

module.exports = { LanguageWorker };
