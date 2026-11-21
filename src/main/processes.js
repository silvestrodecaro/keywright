'use strict';

const { execFile } = require('child_process');

/**
 * Kills a process and all its children (the Browser library starts Node and browsers).
 * @returns {Promise<void>} resolves when the kill has been carried out or has failed
 */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, (error) => {
      // taskkill also fails when the process has exited meanwhile.
      if (error && child.exitCode === null && child.signalCode === null) {
        console.error(`Could not stop process ${child.pid}: ${error.message.trim()}`);
        child.kill();
      }
      resolve();
    });
  });
}

/** Child processes that must not outlive the application. */
class ChildProcesses {
  constructor() {
    this._children = new Set();
  }

  get size() {
    return this._children.size;
  }

  /** Remembers `child` until it exits. @returns the same child */
  track(child) {
    if (child.exitCode !== null || child.signalCode !== null)
      return child;
    this._children.add(child);
    child.once('exit', () => this._children.delete(child));
    child.once('error', () => this._children.delete(child));
    return child;
  }

  /** Kills every tracked process tree. */
  async killAll() {
    const children = [...this._children];
    this._children.clear();
    await Promise.all(children.map((child) => killTree(child)));
  }
}

/** The application's processes that have no owner to stop them, such as setup and installs. */
const childProcesses = new ChildProcesses();

module.exports = { ChildProcesses, childProcesses, killTree };
