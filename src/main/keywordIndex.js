'use strict';

const { runHelper } = require('./pythonHelper');

/**
 * Keywords available in a project, for editor completion and hover: the user
 * keywords of every .robot/.resource file plus the keywords of the imported
 * libraries. Library documentation (libdoc) is slow to build, so it is cached
 * per Python executable and library import.
 */
class KeywordIndex {
  constructor() {
    /** @type {Map<string, object>} `${python}|${import}` -> libdoc result */
    this._libraries = new Map();
    /** @type {Map<string, string>} `${python}|${import}` -> error */
    this._failures = new Map();
  }

  /**
   * @param {{ root: string, python: string|null }} project
   * @returns {Promise<{ ok: boolean, error?: string, keywords: object[], errors: object[] }>}
   */
  async build(project) {
    if (!project.python)
      return { ok: false, error: 'No virtual environment (.venv): keyword completion is not available.', keywords: [], errors: [] };
    const index = await runHelper(project.python, ['index', project.root], { cwd: project.root });
    if (!index.ok)
      return { ok: false, error: index.error, keywords: [], errors: [] };

    const key = (name) => `${project.python}|${name}`;
    const missing = index.libraries.filter((name) => !this._libraries.has(key(name)) && !this._failures.has(key(name)));
    if (missing.length) {
      const docs = await runHelper(project.python, ['libdoc', ...missing], { cwd: project.root });
      for (const library of docs.libraries || [])
        this._libraries.set(key(library.import), library);
      for (const failure of docs.errors || [])
        this._failures.set(key(failure.import), failure.error);
    }

    const keywords = [...index.keywords.map((kw) => ({ ...kw, docFormat: 'ROBOT', user: true }))];
    const errors = [...index.errors];
    for (const name of index.libraries) {
      const library = this._libraries.get(key(name));
      if (library)
        keywords.push(...library.keywords.map((kw) => ({ ...kw, docFormat: library.docFormat })));
      else if (this._failures.has(key(name)))
        errors.push({ import: name, error: this._failures.get(key(name)) });
    }
    return { ok: true, keywords, errors };
  }

  /** Forgets cached libraries, e.g. after installing packages in the project. */
  clear() {
    this._libraries.clear();
    this._failures.clear();
  }
}

module.exports = { KeywordIndex };
