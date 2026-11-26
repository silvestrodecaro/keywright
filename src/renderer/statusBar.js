'use strict';

// Activity in the status bar. The recorder and the test runner each report their
// state; the bar shows the one that matters most: a paused run waits for the user,
// then a recording, then a running test.
(function (factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory();
  else
    window.RFStatusBar = factory();
})(function () {
  const PAUSED = { breakpoint: 'Paused at breakpoint', failure: 'Paused on failure' };

  /**
   * @param {{ recorder?: { busy?: boolean, recording?: boolean },
   *           tests?: { running?: boolean, paused?: { reason?: string } | null } }} sources
   * @returns {{ text: string, kind: 'idle'|'running'|'paused'|'recording' }}
   */
  function describeActivity({ recorder = {}, tests = {} } = {}) {
    if (tests.running && tests.paused)
      return { text: PAUSED[tests.paused.reason] || 'Paused', kind: 'paused' };
    if (recorder.busy)
      return { text: 'Launching browser…', kind: 'running' };
    if (recorder.recording)
      return { text: 'Recording', kind: 'recording' };
    if (tests.running)
      return { text: 'Running tests…', kind: 'running' };
    return { text: 'Idle', kind: 'idle' };
  }

  const sources = {};

  /** Records the state of one source ('recorder' or 'tests') and redraws the bar. */
  function set(source, state) {
    sources[source] = state;
    const status = document.querySelector('#status');
    if (!status)
      return;
    const { text, kind } = describeActivity(sources);
    status.dataset.activity = kind;
    status.querySelector('.status-text').textContent = text;
  }

  return { describeActivity, set };
});
