'use strict';

// Client configurations: every format the dialog shows is read back and run as its
// client would run it, and each client's own file is checked read-only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { McpService } = require('../src/main/mcp/service');
const { clientConfigs, clientStates, clientLocations, clientIdFor, launchConfig, connectionPlan, readTomlServer } = require('../src/main/mcp/clients');
const { testConnection, testHttpConnection } = require('../src/main/mcp/connectionTest');
const { tempDir } = require('./helpers/tempDir');

const echo = {
  name: 'echo',
  description: 'Echoes text.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  handler: ({ text }) => text,
};

async function runningService(t) {
  const service = new McpService({ folder: tempDir('mcp-clients'), version: '9.9.9', tools: [echo] });
  service.settings.update({ port: 0 });
  await service.setEnabled(true);
  t.after(() => service.stop());
  return service;
}

/** A status with Windows-like paths, without a running server. */
const sampleStatus = {
  bridge: {
    command: 'C:\\Tools\\Keywright\\node_modules\\electron\\dist\\electron.exe',
    args: ['C:\\Tools\\Keywright\\src\\main\\mcp\\bridge.js', '--connection', "C:\\Users\\o'neil\\AppData\\Roaming\\keywright\\mcp-connection.json"],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  },
  url: 'http://127.0.0.1:47811/mcp',
  port: 47811,
  token: 'secret-token-0123456789-0123456789',
  seen: {},
};

test('every stdio configuration reads back to the exact bridge command', () => {
  const configs = clientConfigs(sampleStatus);
  assert.deepEqual(configs.map((c) => c.id), ['claude-code', 'codex', 'antigravity', 'claude-desktop', 'cursor', 'http']);
  for (const client of configs.filter((c) => c.id !== 'http')) {
    const config = launchConfig(client, sampleStatus);
    assert.equal(config.command, sampleStatus.bridge.command, client.id);
    assert.deepEqual(config.args, sampleStatus.bridge.args, client.id);
    assert.deepEqual(config.env, sampleStatus.bridge.env, client.id);
  }
  const codex = configs.find((c) => c.id === 'codex');
  assert.match(codex.config, /^\[mcp_servers\.keywright\]\ncommand = 'C:\\Tools/);
  assert.match(codex.config, /"C:\\\\Users\\\\o'neil/, 'a path with a quote uses a basic string');
  assert.equal(readTomlServer(codex.config).tool_timeout_sec, 120);
  assert.match(configs[0].config, /^claude mcp add keywright --scope user --env ELECTRON_RUN_AS_NODE=1 -- /);
  assert.equal(launchConfig(configs.at(-1), sampleStatus), null);
});

test('the TOML reader handles subtables, multi-line arrays, comments and other servers', () => {
  const text = [
    'model = "gpt-5"',
    '[mcp_servers.other]',
    'command = "npx"',
    '',
    '[mcp_servers.keywright] # Keywright',
    'command = "C:\\\\Tools\\\\electron.exe"',
    'args = [',
    "  'bridge.js', # the bridge",
    '  "--connection",',
    '  "c.json",',
    ']',
    'startup_timeout_sec = 20',
    '',
    '[mcp_servers.keywright.env]',
    'ELECTRON_RUN_AS_NODE = "1"',
    '',
    '[profiles.fast]',
    'command = "not this"',
  ].join('\r\n');
  assert.deepEqual(readTomlServer(text), {
    command: 'C:\\Tools\\electron.exe',
    args: ['bridge.js', '--connection', 'c.json'],
    startup_timeout_sec: 20,
    env: { ELECTRON_RUN_AS_NODE: '1' },
  });
  assert.equal(readTomlServer('[mcp_servers.other]\ncommand = "x"\n'), null);
});

test('client files are read without changes: configured, missing, outdated and unreadable', () => {
  const home = tempDir('mcp-home');
  const locations = clientLocations({ home, env: { APPDATA: path.join(home, 'AppData', 'Roaming') } });
  const configs = Object.fromEntries(clientConfigs(sampleStatus, locations).map((c) => [c.id, c]));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };

  let states = clientStates(sampleStatus, locations);
  for (const id of ['claude-code', 'codex', 'antigravity', 'claude-desktop', 'cursor'])
    assert.equal(states[id].state, 'missing', id);
  assert.equal(states.http.state, 'manual');

  // What `claude mcp add` writes; the dialog's TOML and JSON pasted into existing files.
  write(locations['claude-code'][0], JSON.stringify({ numStartups: 3, mcpServers: { keywright: { type: 'stdio', ...sampleStatus.bridge } } }));
  write(locations.codex[0], `model = "gpt-5"\n\n${configs.codex.config}\n`);
  write(locations.antigravity[1], configs.antigravity.config); // the older location
  write(locations.cursor[0], '{ not json');
  const otherFolder = { ...sampleStatus.bridge, args: ['D:\\Old\\bridge.js', ...sampleStatus.bridge.args.slice(1)] };
  write(locations['claude-desktop'][0], JSON.stringify({ mcpServers: { keywright: otherFolder } }));

  const before = fs.readFileSync(locations.codex[0], 'utf8');
  states = clientStates(sampleStatus, locations);
  assert.equal(states['claude-code'].state, 'configured');
  assert.equal(states.codex.state, 'configured');
  assert.equal(states.antigravity.state, 'configured');
  assert.match(states.antigravity.detail, /older Antigravity location/);
  assert.equal(states.cursor.state, 'unreadable');
  assert.equal(states['claude-desktop'].state, 'outdated');
  assert.match(states['claude-desktop'].detail, /another Keywright folder/);
  assert.equal(fs.readFileSync(locations.codex[0], 'utf8'), before, 'files are only read');

  // An entry without ELECTRON_RUN_AS_NODE would open an Electron window instead.
  write(locations.antigravity[0], JSON.stringify({ mcpServers: { keywright: { command: sampleStatus.bridge.command, args: sampleStatus.bridge.args } } }));
  states = clientStates(sampleStatus, locations);
  assert.equal(states.antigravity.state, 'outdated');
  assert.match(states.antigravity.detail, /ELECTRON_RUN_AS_NODE=1/);
  assert.equal(states.antigravity.file, locations.antigravity[0], 'the current location wins');

  // HTTP entries are compared with the server's address and token.
  write(locations.cursor[0], JSON.stringify({ mcpServers: { keywright: { url: sampleStatus.url, headers: { Authorization: 'Bearer old' } } } }));
  assert.match(clientStates(sampleStatus, locations).cursor.detail, /old token/);
});

test('Antigravity: an empty file, a byte order mark, the project workspace file and a disabled entry', () => {
  const home = tempDir('mcp-home');
  const project = tempDir('mcp-project');
  const locations = clientLocations({ home, env: {}, project });
  assert.deepEqual(locations.antigravity.map((file) => path.relative(home, file).split(path.sep).join('/')).filter((file) => !file.startsWith('..')),
    ['.gemini/config/mcp_config.json', '.gemini/antigravity/mcp_config.json']);
  assert.equal(locations.antigravity[1], path.join(project, '.agents', 'mcp_config.json'));
  const configs = Object.fromEntries(clientConfigs(sampleStatus, locations).map((c) => [c.id, c]));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };

  // Created by Antigravity but still empty: not configured, not unreadable.
  write(locations.antigravity[0], '');
  assert.equal(clientStates(sampleStatus, locations).antigravity.state, 'missing');
  assert.equal(connectionPlan('antigravity', sampleStatus, locations).kind, 'generated');

  write(locations.antigravity[1], configs.antigravity.config);
  let state = clientStates(sampleStatus, locations).antigravity;
  assert.equal(state.state, 'configured');
  assert.match(state.detail, /this project only/);

  write(locations.antigravity[0], `\uFEFF${configs.antigravity.config}`);
  state = clientStates(sampleStatus, locations).antigravity;
  assert.deepEqual([state.state, state.detail, state.file], ['configured', null, locations.antigravity[0]]);

  const entry = JSON.parse(configs.antigravity.config);
  entry.mcpServers.keywright.disabled = true;
  write(locations.antigravity[0], JSON.stringify(entry));
  state = clientStates(sampleStatus, locations).antigravity;
  assert.equal(state.state, 'outdated');
  assert.match(state.detail, /disabled/);
});

test('connecting clients are recognized by the name they report', () => {
  assert.equal(clientIdFor('claude-code'), 'claude-code');
  assert.equal(clientIdFor('codex-mcp-client'), 'codex');
  assert.equal(clientIdFor('claude-ai'), 'claude-desktop');
  assert.equal(clientIdFor('antigravity'), 'antigravity');
  assert.equal(clientIdFor('cursor-vscode'), 'cursor');
  assert.equal(clientIdFor('my-agent'), 'http');
});

test('the connection test runs each shown configuration against the server', { timeout: 60_000 }, async (t) => {
  const service = await runningService(t);
  const status = service.status();
  for (const client of clientConfigs(status)) {
    const config = launchConfig(client, status);
    const result = config ? await testConnection(config) : await testHttpConnection(status.url, status.token);
    assert.deepEqual(result, { ok: true, server: 'Keywright 9.9.9', tools: ['echo'] }, client.id);
  }
  assert.deepEqual(service.status().clients, [], 'the test is not listed as a connected client');
  assert.deepEqual(service.status().seen, {});

  const wrongToken = await testHttpConnection(status.url, 'nope');
  assert.equal(wrongToken.ok, false);
  assert.match(wrongToken.error, /wrong token/);
  const missing = await testConnection({ command: path.join(tempDir('mcp-clients'), 'missing.exe'), args: [] });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /Could not start/);
});

test('the connection test reports a server that is off', { timeout: 30_000 }, async (t) => {
  const service = await runningService(t);
  const status = service.status();
  await service.setEnabled(false);
  const result = await testConnection(status.bridge);
  assert.equal(result.ok, false);
  assert.match(result.error, /not running or its MCP server is off/);
});

test('a real client connection is remembered for its client type', { timeout: 30_000 }, async (t) => {
  const service = await runningService(t);
  await service.protocol.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-mcp-client', version: '0.9' } } });
  assert.ok(service.status().seen.codex);
  assert.deepEqual(service.status().clients, ['codex-mcp-client 0.9']);
});

test("Test connection runs the entry from the client's own file, not the offered configuration", { timeout: 60_000 }, async (t) => {
  const service = await runningService(t);
  const status = service.status();
  const home = tempDir('mcp-home');
  const locations = clientLocations({ home, env: {} });
  const configs = Object.fromEntries(clientConfigs(status, locations).map((c) => [c.id, c]));
  const run = async (id) => {
    const plan = connectionPlan(id, status, locations);
    const result = plan.config ? await testConnection(plan.config) : plan.url ? await testHttpConnection(plan.url, plan.token) : { ok: false, error: plan.error };
    return { kind: plan.kind, ok: result.ok, error: result.error };
  };

  // Not configured: only the offered configuration can be run, reported as such.
  assert.deepEqual(await run('codex'), { kind: 'generated', ok: true, error: undefined });

  // Configured: the client's entry is what runs.
  fs.mkdirSync(path.dirname(locations.codex[0]), { recursive: true });
  fs.writeFileSync(locations.codex[0], configs.codex.config);
  assert.deepEqual(await run('codex'), { kind: 'client', ok: true, error: undefined });

  // An entry for a moved Keywright fails, although the offered configuration works.
  const moved = { ...status.bridge, args: [path.join(home, 'old', 'bridge.js'), ...status.bridge.args.slice(1)] };
  fs.mkdirSync(path.dirname(locations.cursor[0]), { recursive: true });
  fs.writeFileSync(locations.cursor[0], JSON.stringify({ mcpServers: { keywright: moved } }));
  const cursor = await run('cursor');
  assert.equal(cursor.kind, 'client');
  assert.equal(cursor.ok, false);

  // An HTTP entry is tested with its own URL and token.
  fs.mkdirSync(path.dirname(locations.antigravity[0]), { recursive: true });
  fs.writeFileSync(locations.antigravity[0], JSON.stringify({ mcpServers: { keywright: { serverUrl: status.url, headers: { Authorization: 'Bearer stale' } } } }));
  const remote = await run('antigravity');
  assert.equal(remote.kind, 'client');
  assert.match(remote.error, /wrong token/);

  fs.writeFileSync(locations.codex[0], '[mcp_servers.keywright]\ncommand = "unterminated\n');
  assert.equal((await run('codex')).kind, 'unreadable');
  assert.equal(connectionPlan('http', status, locations).kind, 'http');
});
