'use strict';

// Watch mode: which watched tests to re-run after files changed. Loaded as a
// classic script in the renderer (window.RFWatch) and as a module by the tests.
(function (factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory();
  else
    window.RFWatch = factory();
})(function () {
  // Files that can change the outcome of a test. Other files (README.md, ...) are ignored.
  const RELEVANT = /\.(robot|resource|py|yaml|yml|json|txt|csv)$/i;

  /**
   * @param {object} options
   * @param {string[]} options.paths     changed project-relative paths
   * @param {{ id: string, source: string, suites: string[] }[]} options.tests  discovered tests
   * @param {Set<string>} options.watched  watched test and suite ids
   * @param {boolean} options.watchAll
   * @returns {string[]} ids of the watched tests to run, in discovery order
   */
  function affectedTests({ paths, tests, watched, watchAll }) {
    const relevant = paths.filter((path) => RELEVANT.test(path));
    if (!relevant.length)
      return [];
    const isWatched = (test) => watchAll || watched.has(test.id) || test.suites.some((suite) => watched.has(suite));
    const suiteFiles = new Set(tests.map((test) => test.source));
    // A changed suite file re-runs its own watched tests; any other relevant file
    // (resource, library, variables, ...) may be used by every test.
    const dependencyChanged = relevant.some((path) => !suiteFiles.has(path));
    const changed = new Set(relevant);
    return tests
      .filter((test) => isWatched(test) && (dependencyChanged || changed.has(test.source)))
      .map((test) => test.id);
  }

  return { affectedTests, RELEVANT };
});
