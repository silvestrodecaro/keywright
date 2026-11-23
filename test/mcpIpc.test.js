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

function setup({ answer = 1 } = {}) {
  const handlers = new Map();
  const sent = [];
  const dialogs = [];
  const root = tempDir('mcp-ipc-project');
  const agentBrowser = Object.assign(new EventEmitter(), { open: false, options: {}, close: async () => { agentBrowser.closed = true; } });
  const mcp = createMcpIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    userData: tempDir('mcp-ipc-profile'),
    version: '9.9.9',
    send: (channel, payload) => sent.push([channel, payload]),
    showMessageBox: async (options) => { dialogs.push(options); return { response: answer }; },
    trash: async () => {},
    project: () => ({ root, name: 'demo', python: null, config: { testsDir: 'tests', resourcesDir: 'resources', outputDir: 'results' } }),
    refreshProject: () => null,
    dirtyPaths: () => [],
    keywordIndex: { build: async () => ({ ok: true, keywords: [], errors: [] }) },
    languageWorker: () => null,
    discoverTests: async () => ({ ok: true, suite: { name: 'Tests', tests: [], suites: [] } }),
    runner: Object.assign(new EventEmitter(), { running: false }),
    startRun: async () => {},
    agentBrowser,
    browsers: {},
    launchError: (error) => error.message,
    clientHome: tempDir('mcp-ipc-home'),
  });
  const call = (channel, ...args) => handlers.get(channel)({}, ...args);
  return { mcp, handlers, sent, dialogs, root, agentBrowser, call };
}

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
