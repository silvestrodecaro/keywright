'use strict';

// Comparison of two test runs from the run history. Only tests present in both
// runs are compared, so running a single test does not report the others as gone.
// Loaded as a classic script in the renderer (window.RFRunDiff) and as a module by the tests.
(function (factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory();
  else
    window.RFRunDiff = factory();
})(function () {
  const SLOWER_RATIO = 1.5;
  const SLOWER_SECONDS = 0.5;

  /**
   * @param {{ tests: Record<string, { status: string, elapsed?: number, message?: string }> }} run
   * @param {object | null} previous the run before it (null for the first one)
   * @returns {{ newFailures: string[], fixed: string[], stillFailing: string[], added: string[],
   *             slower: { id: string, before: number, after: number }[] }} test ids
   */
  function compareRuns(run, previous) {
    const result = { newFailures: [], fixed: [], stillFailing: [], added: [], slower: [] };
    for (const [id, test] of Object.entries(run.tests)) {
      const before = previous && previous.tests[id];
      if (!before) {
        if (previous)
          result.added.push(id);
        if (test.status === 'FAIL')
          (previous ? result.newFailures : result.stillFailing).push(id);
        continue;
      }
      if (test.status === 'FAIL')
        (before.status === 'FAIL' ? result.stillFailing : result.newFailures).push(id);
      else if (test.status === 'PASS' && before.status === 'FAIL')
        result.fixed.push(id);
      if (test.status === 'PASS' && before.status === 'PASS' && test.elapsed != null && before.elapsed != null
          && test.elapsed > before.elapsed * SLOWER_RATIO && test.elapsed - before.elapsed > SLOWER_SECONDS)
        result.slower.push({ id, before: before.elapsed, after: test.elapsed });
    }
    for (const list of [result.newFailures, result.fixed, result.stillFailing, result.added])
      list.sort();
    result.slower.sort((a, b) => (b.after - b.before) - (a.after - a.before));
    return result;
  }

  /** Counts of a run: { PASS, FAIL, SKIP, total }. */
  function counts(run) {
    const result = { PASS: 0, FAIL: 0, SKIP: 0, total: 0 };
    for (const test of Object.values(run.tests)) {
      result.total++;
      if (test.status in result)
        result[test.status]++;
    }
    return result;
  }

  /** The statuses of a test in the runs (newest first), oldest first, for a trend: ['PASS', 'FAIL', ...]. */
  function trend(runs, testId, max = 10) {
    return runs.filter((run) => run.tests[testId]).slice(0, max).map((run) => run.tests[testId].status).reverse();
  }

  return { compareRuns, counts, trend };
});
