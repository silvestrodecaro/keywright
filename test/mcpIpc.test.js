'use strict';

// The MCP part of the main process: the IPC handlers behind the MCP dialog, wired to the
// service, the AI's file changes and the client configurations.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createMcpIpc } = require('../src/main/ipc/mcp');
const { tempDir } = require('./helpers/tempDir');

function setup({ answer = 1, showMessageBox, confirmWaitMs } = {}) {
  const handlers = new Map();
  const sent = [];
  const dialogs = [];
  const root = tempDir('mcp-ipc-project');
  const opened = { root };
  const started = [];
  const agentBrowser = Object.assign(new EventEmitter(), { open: false, options: {}, close: async () => { agentBrowser.closed = true; } });
  const mcp = createMcpIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    userData: tempDir('mcp-ipc-profile'),
    version: '9.9.9',
    send: (channel, payload) => sent.push([channel, payload]),
    showMessageBox: async (options) => { dialogs.push(options); return showMessageBox ? showMessageBox() : { response: answer }; },
    confirmWaitMs,
    trash: async () => {},
    project: () => ({ root: opened.root, name: 'demo', python: null, config: { testsDir: 'tests', resourcesDir: 'resources', outputDir: 'results' } }),
    refreshProject: () => null,
    dirtyPaths: () => [],
    keywordIndex: { build: async () => ({ ok: true, keywords: [], errors: [] }) },
    languageWorker: () => null,
    discoverTests: async () => ({ ok: true, suite: { name: 'Tests', tests: [], suites: [] } }),
    runner: Object.assign(new EventEmitter(), { running: false }),
    startRun: async (options) => { started.push(options); throw new Error('started'); }, // no run to wait for
    agentBrowser,
    browsers: {},
    launchError: (error) => error.message,
    clientHome: tempDir('mcp-ipc-home'),
  });
  const call = (channel, ...args) => handlers.get(channel)({}, ...args);
  return { mcp, handlers, sent, dialogs, root, opened, started, agentBrowser, call };
}

/** Turns the server on and returns a function that calls run_tests as an AI client. */
async function connect(f) {
  const { url, token } = await f.call('mcp:set-enabled', true);
  return async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_tests', arguments: {} } }),
    });
    return (await response.json()).result.content[0].text;
  };
}

async function startServer(f, t) {
  await f.mcp.start();
  t.after(() => f.mcp.stop());
  f.mcp.service.settings.update({ port: 0 });
  return connect(f);
}

test('AI clients run tests after the user allows it, once per project until the server is off', async (t) => {
  const f = setup({ answer: 0 });
  const run = await startServer(f, t);
  assert.equal(await run(), 'started');
  assert.equal(await run(), 'started');
  assert.equal(f.dialogs.length, 1);
  assert.match(f.dialogs[0].message, /run the tests of demo/);
  assert.equal(f.dialogs[0].defaultId, 1, 'Enter does not allow');
  f.opened.root = tempDir('mcp-ipc-other');
  await run();
  assert.equal(f.dialogs.length, 2, 'another project');
  f.opened.root = f.root;
  await run();
  assert.equal(f.dialogs.length, 2, 'the first project is still allowed');
  await f.call('mcp:set-enabled', false);
  await (await connect(f))();
  assert.equal(f.dialogs.length, 3, 'the server was turned off');
});

test('without permission no test runs, and the client is told', async (t) => {
  const f = setup({ answer: 1 });
  const run = await startServer(f, t);
  assert.match(await run(), /did not allow running the tests/);
  assert.deepEqual(f.started, []);
});

test('a question not answered in time stays open, is shown once, and its answer counts for the next call', async (t) => {
  let answer;
  const f = setup({ confirmWaitMs: 30, showMessageBox: () => new Promise((resolve) => { answer = resolve; }) });
  const run = await startServer(f, t);
  const [one, two] = await Promise.all([run(), run()]);
  assert.match(one, /Tell the user to answer in Keywright/);
  assert.match(two, /Tell the user to answer in Keywright/);
  assert.equal(f.dialogs.length, 1);
  answer({ response: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await run(), 'started');
  assert.equal(f.dialogs.length, 1);
});

test('turning the server off drops an open question, whose answer allows nothing later', async (t) => {
  const answers = [];
  const f = setup({ confirmWaitMs: 30, showMessageBox: () => new Promise((resolve) => { answers.push(resolve); }) });
  const run = await startServer(f, t);
  await run();
  await f.call('mcp:set-enabled', false);
  answers[0]({ response: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  const again = await connect(f);
  assert.match(await again(), /Tell the user to answer/);
  assert.equal(f.dialogs.length, 2);
  assert.deepEqual(f.started, []);
});

test('the dialog channels are registered, and say so when the server could not start', async () => {
  const f = setup();
  for (const channel of ['mcp:status', 'mcp:set-enabled', 'mcp:regenerate-token', 'mcp:close-browser', 'mcp:undo-change', 'mcp:test-connection'])
    assert.ok(f.handlers.has(channel), channel);
  assert.equal(await f.call('mcp:status'), null);
  await assert.rejects(f.call('mcp:set-enabled', true), /unavailable in this session/);
});

test('the status lists the server, the client setups and the open project\'s AI changes', async (t) => {
  const f = setup();
  await f.mcp.start();
  t.after(() => f.mcp.stop());
  const status = await f.call('mcp:status');
  assert.equal(status.enabled, false);
  assert.equal(status.browserOpen, false);
  assert.ok(status.setups.some((setup) => setup.id === 'claude-code'));
  assert.deepEqual(status.changes, []);
});

test('turning the server off closes the AI browser', async (t) => {
  const f = setup();
  await f.mcp.start();
  t.after(() => f.mcp.stop());
  f.mcp.service.settings.update({ port: 0 });
  assert.equal((await f.call('mcp:set-enabled', true)).running, true);
  assert.equal((await f.call('mcp:set-enabled', false)).running, false);
  assert.equal(f.agentBrowser.closed, true);
});

test('Test connection asks first about a command from the project\'s own configuration', async (t) => {
  const f = setup({ answer: 1 }); // Cancel
  await f.mcp.start();
  t.after(() => f.mcp.stop());
  f.mcp.service.settings.update({ port: 0 });
  await f.call('mcp:set-enabled', true);
  const file = path.join(f.root, '.agents', 'mcp_config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { keywright: { command: 'not-run.exe', args: ['--x'] } } }));
  const result = await f.call('mcp:test-connection', 'antigravity');
  assert.equal(result.ok, false);
  assert.match(result.error, /cancelled/);
  assert.equal(f.dialogs.length, 1);
  assert.match(f.dialogs[0].detail, /not-run\.exe --x/);
});
