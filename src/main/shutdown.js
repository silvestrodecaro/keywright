'use strict';

// Quitting: every way of quitting (closing the window, Quit after a crash, the system)
// goes through before-quit, which stops the services and processes first.

/**
 * Stops the services together, each within `timeoutMs`: one that hangs or fails is
 * logged and left behind, so the app still quits.
 * @param {[string, () => unknown][]} steps name and stop function
 * @param {{ timeoutMs?: number, log?: (message: string) => void }} [options]
 */
function stopAll(steps, { timeoutMs = 5000, log = console.error } = {}) {
  const step = async ([name, stop]) => {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
    try {
      if (await Promise.race([Promise.resolve().then(stop), timeout]) === 'timeout')
        log(`Shutdown: ${name} did not stop within ${timeoutMs / 1000} seconds`);
    } catch (error) {
      log(`Shutdown: ${name}: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }
  };
  return Promise.all(steps.map(step));
}

/**
 * Holds the first quit until `stop` has finished, then quits; quitting again meanwhile
 * does not stop the services twice.
 * @param {{ on: Function, quit: () => void }} app
 * @param {{ stop: () => Promise<unknown>, enabled?: boolean }} options
 *   enabled: false for a second instance that hands over to the first and owns nothing
 */
function handleQuit(app, { stop, enabled = true }) {
  let stopping = null;
  let stopped = false;
  app.on('before-quit', (event) => {
    if (stopped || !enabled)
      return;
    event.preventDefault();
    if (stopping)
      return;
    let result;
    try {
      result = stop();
    } catch (error) {
      result = Promise.reject(error);
    }
    // The app quits whatever happened: a service that cannot stop must not keep it open.
    stopping = Promise.resolve(result).catch((error) => console.error(`Shutdown: ${error.message}`)).finally(() => {
      stopped = true;
      app.quit();
    });
  });
}

module.exports = { stopAll, handleQuit };
