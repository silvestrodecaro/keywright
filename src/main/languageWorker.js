'use strict';

const { spawn } = require('child_process');
const { HELPER, pythonEnv } = require('./pythonHelper');
const { childProcesses, killTree } = require('./processes');

const REQUEST_TIMEOUT = 15_000;
// The end of the helper's error output, kept to explain why it stopped.
const STDERR_TAIL = 2000;

/**
 * A long-running `keywright_runner.py serve` process in the project's Python, so
 * the editor can check unsaved content without paying Robot's import time on
 * every keystroke. Started lazily, and started again after it exits or stops
 * answering.
 */
class LanguageWorker {
  /**
   * @param {string} python  @param {string} cwd
   * @param {{ timeoutMs?: number }} [options]
   */
  constructor(python, cwd, { timeoutMs = REQUEST_TIMEOUT } = {}) {
    this._python = python;
    this._cwd = cwd;
    this._timeoutMs = timeoutMs;
    this._child = null;
    this._buffer = '';
    this._stderr = '';
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
        reject(new Error(`No answer to "${command}" from the Python helper.${this._stderrNote()}`));
        // A helper that does not answer is stuck (often in a library import): the
        // next request starts a new one.
        if (this._child === child) {
          this._child = null;
          killTree(child);
        }
      }, this._timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, command, ...params }) + '\n');
    });
  }

  dispose() {
    this._disposed = true;
    if (this._child)
      killTree(this._child);
    this._child = null;
    this._failAll(new Error('The language worker was stopped.'));
  }

  _ensureStarted() {
    if (this._child)
      return this._child;
    const child = childProcesses.track(spawn(this._python, [HELPER, 'serve'], { cwd: this._cwd, env: pythonEnv(), windowsHide: true }));
    this._child = child;
    this._buffer = '';
    this._stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onData(chunk));
    child.stderr.on('data', (chunk) => {
      if (this._child === child)
        this._stderr = (this._stderr + chunk).slice(-STDERR_TAIL);
    });
    child.stdin.on('error', () => {});
    let ended = false;
    const onEnd = (reason) => {
      if (ended)
        return;
      ended = true;
      const current = this._child === child;
      if (current)
        this._child = null;
      if (current && !this._disposed)
        this._failAll(new Error(`The Python helper stopped unexpectedly${reason}.${this._stderrNote()}`));
    };
    // 'close' comes after the output has been read, so the error output is complete.
    child.on('close', () => onEnd(''));
    child.on('error', (error) => onEnd(`: ${error.message}`));
    return child;
  }

  _stderrNote() {
    const text = this._stderr.trim();
    return text ? `\n${text}` : '';
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
      if (!response || typeof response !== 'object')
        continue; // JSON, but not a response either
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
