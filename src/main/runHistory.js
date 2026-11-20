'use strict';

// History of test runs, kept in the project's results folder (.keywright-history.json):
// for each run its options and the status and time of every test that ran.

const path = require('path');
const { readJson, writeJsonAtomic } = require('./jsonFile');

const FILE_NAME = '.keywright-history.json';
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

  /** Forgets the run being recorded, which did not start. */
  cancel() {
    this._current = null;
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
    try {
      // A history that cannot be read is not replaced by this one run.
      const runs = [run, ...this._saved(path.dirname(this._file))].slice(0, MAX_RUNS);
      writeJsonAtomic(this._file, runs);
    } catch (error) {
      // the results folder is not writable: the history is lost, the run is not
      console.error(`Could not save the run history to ${this._file}: ${error.message}`);
    }
    return run;
  }

  /** Saved runs, newest first; none when the file cannot be read. */
  list(outputDir) {
    try {
      return this._saved(outputDir);
    } catch (error) {
      console.error(`Could not read the run history: ${error.message}`);
      return [];
    }
  }

  /** Saved runs; a damaged file is kept aside (readJson), an unreadable one throws. */
  _saved(outputDir) {
    const stored = readJson(path.join(outputDir, FILE_NAME));
    return stored.status === 'ok' && Array.isArray(stored.value) ? stored.value : [];
  }
}

module.exports = { RunHistory, FILE_NAME, MAX_RUNS };
