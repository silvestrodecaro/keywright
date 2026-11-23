'use strict';

// The Test Generator's part of the main process: recording, locator picking and saving
// the generated test, over fake recorder sessions.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createGeneratorIpc, explainLaunchError, BROWSERS } = require('../src/main/ipc/generator');

function fakeSession({ fail = null, selector = 'internal:role=button[name="Save"i]' } = {}) {
  return Object.assign(new EventEmitter(), {
    recording: false,
    actions: [],
    started: [],
    async start(options) {
      this.started.push(options);
      if (fail)
        throw new Error(fail);
      this.recording = true;
    },
    async pickLocator() { return selector; },
    async cancelPick() { this.cancelled = true; },
  });
}

function setup(options = {}) {
  const handlers = new Map();
  const sent = [];
  const saves = [];
  const session = options.session || fakeSession();
  const pickerSession = options.pickerSession || fakeSession();
  const generator = createGeneratorIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    send: (channel, payload) => sent.push([channel, payload]),
    session,
    pickerSession,
    project: () => options.project || null,
    documentsPath: () => 'C:/Users/me/Documents',
    showSaveDialog: async (dialogOptions) => { saves.push(dialogOptions); return { canceled: true }; },
    showWindow: () => {},
    note: () => {},
    install: async () => {},
  });
  const call = (channel, ...args) => handlers.get(channel)({}, ...args);
  return { generator, handlers, sent, saves, session, pickerSession, call };
}

test('recording starts in the chosen browser and reports its state', async () => {
  const f = setup();
  assert.deepEqual(await f.call('recorder:start', { browser: 'msedge', url: 'example.com', viewport: null }), { ok: true });
  assert.deepEqual(f.session.started[0], { ...BROWSERS.msedge, url: 'example.com', viewport: null });
  assert.deepEqual(f.sent.find(([channel]) => channel === 'recorder:state')[1], { recording: true });
});

test('a browser that is not installed is explained, with the download it needs', async () => {
  const f = setup({ session: fakeSession({ fail: "browserType.launch: Executable doesn't exist at C:\\x\\chrome.exe" }) });
  const result = await f.call('recorder:start', { browser: 'chromium' });
  assert.equal(result.ok, false);
  assert.equal(result.install, 'chromium');
  assert.match(explainLaunchError(new Error("Executable doesn't exist at x"), 'msedge').error, /does not seem to be installed/);
});

test('picking without a recording opens the picking browser and returns the selector as a cell', async () => {
  const f = setup();
  const result = await f.call('locator:pick', { browser: 'chromium', url: 'example.com' });
  assert.equal(result.ok, true);
  assert.equal(result.selector, 'role=button[name="Save"i]');
  assert.equal(f.pickerSession.started[0].record, false);
  assert.equal(f.session.started.length, 0);
  const states = f.sent.filter(([channel]) => channel === 'locator:state').map(([, state]) => state.picking);
  assert.deepEqual(states, [true, false]);
});

test('a second pick while one is in progress is refused', async () => {
  let release;
  const slow = fakeSession();
  slow.pickLocator = () => new Promise((resolve) => { release = resolve; });
  const f = setup({ pickerSession: slow });
  const first = f.call('locator:pick', {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.match((await f.call('locator:pick', {})).error, /Already picking/);
  release(null);
  assert.deepEqual(await first, { ok: true, cancelled: true });
});

test('the generated test is saved in the tests folder under the test name', async () => {
  const root = path.join('C:', 'work', 'demo');
  const f = setup({ project: { root, config: { testsDir: 'tests' } } });
  await f.call('generator:set-options', { testName: 'Login As Ada' });
  assert.equal(await f.call('file:save', '*** Test Cases ***\n'), null); // the dialog was cancelled
  assert.equal(f.saves[0].defaultPath, path.join(root, 'tests', 'login_as_ada.robot'));
  const code = f.sent.filter(([channel]) => channel === 'recorder:code').at(-1)[1].code;
  assert.match(code, /Login As Ada/);
});
