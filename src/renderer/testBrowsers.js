'use strict';

// Browsers of the project's Browser library: when tests fail because a browser, or the
// library's own dependencies, are missing, the Testing panel offers to install them.
// tests.js passes the messages of the run and stops tests from starting meanwhile.
(function (factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory();
  else
    window.RFTestBrowsers = factory();
})(function () {
  // Playwright's message when the build it launches is not in the browser storage.
  const MISSING = /browserType\.\w+: Executable doesn't exist at [^\r\n]*[\\/](chromium|chromium_headless_shell|firefox|webkit)-\d+[\\/]/g;
  // Browser library's message after an installation or update without `rfbrowser init`,
  // written with non-breaking spaces.
  const DEPENDENCIES = /RF-Browser\sdependencies\snot\sfound\sin\sinstallation\spath/;

  /** @returns {null | { browsers: string[], dependencies: boolean }} what the messages of a run miss */
  function findMissing(text) {
    const browsers = new Set([...text.matchAll(MISSING)].map(([, name]) => (name === 'chromium_headless_shell' ? 'chromium' : name)));
    const dependencies = DEPENDENCIES.test(text);
    return browsers.size || dependencies ? { browsers: [...browsers].sort(), dependencies } : null;
  }

  function noticeText({ browsers, dependencies }) {
    return dependencies
      ? "The project's Browser library is not initialized, so its tests cannot start a browser."
      : `The project's Browser library has no ${browsers.join(' and ')} for its version, so tests could not start it.`;
  }

  /**
   * @param {{ api: object, box: HTMLElement, idle: () => boolean, setInstalling: (installing: boolean) => void }} deps
   *   idle: nothing runs or is about to; setInstalling: keeps tests from starting
   */
  function create({ api, box, idle, setInstalling, doc = document }) {
    let request = 0;
    let installing = false;
    let messages = []; // of the tests that failed in this run

    /** A new run or project. */
    function reset() {
      request++;
      messages = [];
      box.hidden = true;
      if (installing) {
        installing = false;
        setInstalling(false);
      }
    }

    function show(text, button) {
      const message = doc.createElement('span');
      message.textContent = text;
      box.replaceChildren(message, ...(button ? [button] : []));
      box.hidden = false;
    }

    function offer(missing, text) {
      // The dependencies are installed with a browser: Chromium, unless tests tried others.
      const names = missing.browsers.length ? missing.browsers : ['chromium'];
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-sm btn-primary';
      button.textContent = `Install ${names.join(' and ')}`;
      button.addEventListener('click', () => install(missing, names));
      show(text, button);
    }

    async function install(missing, names) {
      if (!idle())
        return;
      const own = ++request;
      installing = true;
      setInstalling(true);
      show(`Installing ${names.join(' and ')} for the project's Browser library…`);
      const unsubscribe = api.onTestBrowsersLog((text) => {
        const line = text.split(/[\r\n]+/).filter((part) => part.trim()).at(-1);
        if (own === request && line)
          show(`Installing ${names.join(' and ')}: ${line.trim().slice(0, 200)}`);
      });
      let result;
      try {
        result = await api.installTestBrowsers(names);
      } catch (error) {
        result = { ok: false, error: error.message };
      } finally {
        unsubscribe();
      }
      if (own !== request) // another project is open
        return;
      installing = false;
      setInstalling(false);
      if (result.ok)
        show(`Installed ${names.join(' and ')}. Run the tests again.`);
      else
        offer(missing, result.error);
    }

    /** The message of a test that failed. */
    function note(message) {
      if (message)
        messages.push(message);
    }

    /** After a run: offers what its messages and console output miss. */
    function finished(output) {
      const missing = findMissing([...messages, output].join('\n'));
      if (missing)
        offer(missing, noticeText(missing));
    }

    return { reset, note, finished };
  }

  return { create, findMissing, noticeText };
});
