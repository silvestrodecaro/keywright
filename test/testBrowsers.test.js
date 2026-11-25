'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { create, findMissing, noticeText } = require('../src/renderer/testBrowsers');
const { testBrowserCommands } = require('../src/main/projects');

const missing = (build) => `Error: browserType.launch: Executable doesn't exist at C:\\cache\\${build}\\win\\x.exe\n`;

test('missing browsers are read from the messages of a run', () => {
  assert.deepEqual(findMissing(missing('chromium_headless_shell-1248') + missing('chromium-1248') + missing('firefox-1555')),
    { browsers: ['chromium', 'firefox'], dependencies: false });
  assert.deepEqual(findMissing("Parent suite setup failed:\nError: browserType.launchPersistentContext: Executable doesn't exist at /home/u/ms-playwright/webkit-2370/pw_run.sh"),
    { browsers: ['webkit'], dependencies: false });
  assert.deepEqual(findMissing('#  RF-Browser dependencies not found in installation path!  #'.replaceAll(' ', '\u00a0')), { browsers: [], dependencies: true });
  // Not downloaded by Playwright, or not about browsers.
  assert.equal(findMissing("Error: browserType.launch: Chromium distribution 'msedge' is not found at C:\\msedge.exe"), null);
  assert.equal(findMissing("Executable doesn't exist at C:\\app\\chromium-1\\x"), null);
  assert.match(noticeText({ browsers: ['chromium', 'firefox'], dependencies: false }), /no chromium and firefox for its version/);
  assert.match(noticeText({ browsers: [], dependencies: true }), /not initialized/);
});

test('the project\'s Browser library installs them, with or without BrowserBatteries', () => {
  assert.deepEqual(testBrowserCommands(['chromium', 'firefox'], false), [['-m', 'Browser.entry', 'init', 'chromium', 'firefox']]);
  assert.deepEqual(testBrowserCommands(['chromium', 'firefox'], true),
    [['-m', 'Browser.entry', 'install', 'chromium'], ['-m', 'Browser.entry', 'install', 'firefox']]);
  assert.throws(() => testBrowserCommands(['chromium', '--with-deps'], false), /Unknown browser/);
  assert.throws(() => testBrowserCommands([], false), /Unknown browser/);
});

function harness(installTestBrowsers) {
  const node = () => ({ listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } });
  const box = { hidden: true, children: [], replaceChildren(...children) { this.children = children; } };
  const state = { installing: false, idle: true };
  const view = create({
    api: { installTestBrowsers, onTestBrowsersLog: () => () => {} },
    box,
    idle: () => state.idle,
    setInstalling: (value) => { state.installing = value; },
    doc: { createElement: node },
  });
  return { view, box, state, text: () => box.children[0].textContent, click: () => box.children[1].listeners.click() };
}

test('an installation keeps tests from starting, and can be tried again when it fails', async () => {
  const results = [{ ok: false, error: 'no network' }, { ok: true }];
  const asked = [];
  const f = harness(async (names) => { asked.push(names); return results.shift(); });
  f.view.finished('All tests passed');
  assert.equal(f.box.hidden, true);
  f.view.note(missing('firefox-1555'));
  f.view.finished('');
  f.state.idle = false;
  await f.click();
  assert.deepEqual(asked, [], 'not while tests run');
  f.state.idle = true;
  const first = f.click();
  assert.equal(f.state.installing, true);
  await first;
  assert.equal(f.state.installing, false);
  assert.equal(f.text(), 'no network');
  await f.click();
  assert.deepEqual(asked, [['firefox'], ['firefox']]);
  assert.match(f.text(), /Installed firefox\. Run the tests again/);
  f.view.reset();
  f.view.finished(''); // the next run: the earlier failures no longer count
  assert.equal(f.box.hidden, true);
});

test('an installation that ends after another project opened changes nothing there', async () => {
  let finish;
  const f = harness(() => new Promise((resolve) => { finish = resolve; }));
  f.view.finished('RF-Browser dependencies not found in installation path!');
  const installing = f.click();
  f.view.reset();
  assert.equal(f.state.installing, false);
  finish({ ok: true });
  await installing;
  assert.equal(f.box.hidden, true);
});
