'use strict';

const { runHelper } = require('./pythonHelper');
const fs = require('fs/promises');
const path = require('path');

// Builds of one request when the cache keeps being invalidated meanwhile.
const MAX_ATTEMPTS = 3;

async function sourceStamp(source) {
  if (!source)
    return null;
  try {
    const stat = await fs.stat(source, { bigint: true });
    return `${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}:${stat.ino}`;
  } catch {
    return null;
  }
}

/**
 * Keywords available in a project, for editor completion and hover: the user
 * keywords of every .robot/.resource file plus the keywords of the imported
 * libraries. Library documentation (libdoc) is slow to build, so it is cached
 * per project, Python executable and library import, while its source is unchanged.
 */
class KeywordIndex {
  constructor() {
    /** @type {Map<string, { library: object, stamp: string|null }>} */
    this._libraries = new Map();
    this._generation = 0;
  }

  /**
   * @param {{ root: string, python: string|null }} project
   * @returns {Promise<{ ok: boolean, error?: string, keywords: object[], errors: object[] }>}
   */
  /**
   * A request made while a build of the same project runs waits for it, then runs one
   * new build shared by every request made meanwhile: the running build may have read
   * the files before they changed. A cache invalidated during a build starts it again,
   * a few times at most (a generator writing modules without pause would otherwise
   * keep Python busy for ever).
   */
  build(project) {
    const key = JSON.stringify([path.resolve(project.root), project.python]);
    const running = this._building;
    if (running?.key === key) {
      running.next ??= running.promise.catch(() => {}).then(() => this._start(project, key));
      return running.next;
    }
    return this._start(project, key);
  }

  _start(project, key) {
    const promise = this._build(project).finally(() => {
      if (this._building?.promise === promise)
        this._building = null;
    });
    this._building = { key, promise, next: null };
    return promise;
  }

  async _build(project, attempt = 1) {
    if (!project.python)
      return { ok: false, error: 'No virtual environment (.venv): keyword completion is not available.', keywords: [], errors: [] };
    const generation = this._generation;
    const index = await runHelper(project.python, ['index', project.root], { cwd: project.root });
    if (!index.ok)
      return { ok: false, error: index.error, keywords: [], errors: [] };

    const key = (name) => JSON.stringify([path.resolve(project.root), project.python, name]);
    await Promise.all(index.libraries.map(async (name) => {
      const cached = this._libraries.get(key(name));
      if (cached && (!cached.stamp || cached.stamp !== await sourceStamp(cached.library.source)))
        this._libraries.delete(key(name));
    }));
    const missing = index.libraries.filter((name) => !this._libraries.has(key(name)));
    const errors = [...index.errors];
    if (missing.length) {
      const docs = await runHelper(project.python, ['libdoc', ...missing], { cwd: project.root });
      if (!docs.ok)
        return { ok: false, error: docs.error || 'Could not load library documentation.', keywords: [], errors };
      const loaded = await Promise.all((docs.libraries || []).map(async (library) => ({ library, stamp: await sourceStamp(library.source) })));
      // A watcher may invalidate the cache while Python is still documenting a library.
      if (generation !== this._generation && attempt < MAX_ATTEMPTS)
        return this._build(project, attempt + 1);
      for (const cached of loaded)
        this._libraries.set(key(cached.library.import), cached);
      errors.push(...(docs.errors || []));
    }
    if (generation !== this._generation && attempt < MAX_ATTEMPTS)
      return this._build(project, attempt + 1);

    const keywords = [...index.keywords.map((kw) => ({ ...kw, docFormat: 'ROBOT', user: true }))];
    for (const name of index.libraries) {
      const library = this._libraries.get(key(name))?.library;
      if (library)
        keywords.push(...library.keywords.map((kw) => ({ ...kw, docFormat: library.docFormat })));
    }
    return { ok: true, keywords, errors };
  }

  /** Forgets cached libraries, e.g. after installing packages in the project. */
  clear() {
    this._generation++;
    this._libraries.clear();
  }
}

module.exports = { KeywordIndex };
