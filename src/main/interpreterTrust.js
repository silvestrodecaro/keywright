'use strict';

// Interpreters outside the project folder, configured in keywright.json: Keywright runs
// them by itself (keywords, checks), so the user confirms each one once per project.
// The answers are kept in trusted-interpreters.json in the user's profile:
// { "<project root>": "<interpreter>" }, roots folded to lower case on Windows.

const path = require('path');
const projects = require('./projects');
const { readJson, writeJsonAtomic } = require('./jsonFile');

function projectKey(root) {
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(a, b) {
  return projectKey(a) === projectKey(b);
}

class InterpreterTrust {
  /**
   * @param {{ file: string, env?: Record<string, string | undefined>,
   *           ask: (interpreter: string) => Promise<boolean> }} options
   *   ask: shows the question; true to use the interpreter
   */
  constructor({ file, env = process.env, ask }) {
    this._file = file;
    this._env = env;
    this._ask = ask;
  }

  /** The project without its interpreter when that is outside the folder and not confirmed. */
  apply(project) {
    const external = projects.externalInterpreter(project);
    return external && !this._trusted(project, external) ? { ...project, python: null } : project;
  }

  /** Asks about an interpreter outside the project the first time; the answer "use" is kept. */
  async confirm(project) {
    const external = projects.externalInterpreter(project);
    if (!external || this._trusted(project, external))
      return project;
    if (!await this._ask(external))
      return { ...project, python: null };
    this.trust(project.root, external);
    return project;
  }

  /** Remembers that the user accepted, or chose, this interpreter for this project. */
  trust(root, python) {
    try {
      const stored = readJson(this._file);
      const value = stored.status === 'ok' && stored.value && typeof stored.value === 'object' ? stored.value : {};
      writeJsonAtomic(this._file, { ...value, [projectKey(root)]: python }, { space: 2 });
    } catch (error) {
      console.error(`Could not remember the interpreter: ${error.message}`); // asked again next time
    }
  }

  _trusted(project, python) {
    // Set by the user's environment, as the UI tests do for the repository's Python.
    if (this._env.KEYWRIGHT_TRUSTED_PYTHON && samePath(this._env.KEYWRIGHT_TRUSTED_PYTHON, python))
      return true;
    try {
      const stored = readJson(this._file);
      const trusted = stored.status === 'ok' && stored.value ? stored.value[projectKey(project.root)] : null;
      return typeof trusted === 'string' && samePath(trusted, python);
    } catch {
      return false;
    }
  }
}

module.exports = { InterpreterTrust };
