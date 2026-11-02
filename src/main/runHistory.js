'use strict';

// History of test runs, kept in the project's results folder (.rfide-history.json):
// for each run its options and the status and time of every test that ran.

const fs = require('fs');
const path = require('path');

const FILE_NAME = '.rfide-history.json';
const MAX_RUNS = 30;
const MAX_MESSAGE = 300;

class RunHistory {
  constructor() {
    this._current = null;
    this._file = null;
  }

  /**
   * @param {string} outputDir the project's results folder
   * @param {{ select?: string[], include?: string[], exclude?: string[], dryrun?: boolean, debug?: boolean }} options
   */
  start(outputDir, options = {}) {
    this._file = path.join(outputDir, FILE_NAME);
    this._current = {
      id: `${Date.now().toString(36)}`,
      startedAt: new Date().toISOString(),
      options: {
        select: options.select || [],
        include: options.include || [],
        exclude: options.exclude || [],
        dryrun: !!options.dryrun,
        debug: !!options.debug,
      },
      tests: {},
    };
  }

  /** Listener events: keeps the last status of each test (a failing suite teardown sends it again). */
  record(event) {
    if (!this._current || event.type !== 'test-end')
      return;
    const message = String(event.message || '');
    this._current.tests[event.id] = {
      status: event.status,
      elapsed: event.elapsed ?? null,
      ...(message ? { message: message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)} …` : message } : {}),
    };
  }

  /** Saves the run (when some test ran) and returns it, or null. */
  finish({ exitCode, stopped }) {
    const run = this._current;
    this._current = null;
    if (!run || !Object.keys(run.tests).length)
      return null;
    run.duration = (Date.now() - Date.parse(run.startedAt)) / 1000;
    run.exitCode = exitCode;
    run.stopped = !!stopped;
    const runs = [run, ...this.list(path.dirname(this._file))].slice(0, MAX_RUNS);
    try {
      fs.mkdirSync(path.dirname(this._file), { recursive: true });
      fs.writeFileSync(this._file, JSON.stringify(runs));
    } catch {
      // the results folder is not writable: the history is lost, the run is not
    }
    return run;
  }

  /** Saved runs, newest first. */
  list(outputDir) {
    try {
      const runs = JSON.parse(fs.readFileSync(path.join(outputDir, FILE_NAME), 'utf8'));
      return Array.isArray(runs) ? runs : [];
    } catch {
      return [];
    }
  }
}

module.exports = { RunHistory, FILE_NAME, MAX_RUNS };
