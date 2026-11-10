'use strict';

// The MCP server: JSON-RPC handling, the local HTTP transport and the stdio bridge.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { McpProtocol, ToolError, checkArguments } = require('../src/main/mcp/protocol');
const { McpHttpServer } = require('../src/main/mcp/httpServer');
const { McpSettings } = require('../src/main/mcp/settings');
const { McpService, BRIDGE } = require('../src/main/mcp/service');
const { forward, NOT_RUNNING } = require('../src/main/mcp/bridge');
const { tempDir } = require('./helpers/tempDir');

const echo = {
  name: 'echo',
  description: 'Echoes text.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' }, times: { type: 'integer' } }, required: ['text'], additionalProperties: false },
  handler: ({ text, times = 1 }) => text.repeat(times),
};
const failing = {
  name: 'fail',
  description: 'Fails.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => { throw new ToolError('Read the file first.'); },
};

function protocol(extra = {}) {
  return new McpProtocol({ name: 'keywright', version: '1.0.0', instructions: 'Use the tools.', tools: [echo, failing], ...extra });
}

const call = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

test('initialize negotiates the protocol version and lists the tools', async () => {
  const mcp = protocol();
  const init = await mcp.handle(call(1, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test' }, capabilities: {} }));
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.instructions, 'Use the tools.');
  const unknown = await mcp.handle(call(2, 'initialize', { protocolVersion: '1999-01-01' }));
  assert.equal(unknown.result.protocolVersion, '2025-11-25');
  assert.equal(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await mcp.handle(call(3, 'tools/list', {}));
  assert.deepEqual(list.result.tools.map((t) => t.name), ['echo', 'fail']);
  assert.deepEqual(await mcp.handle(call(4, 'ping')), { jsonrpc: '2.0', id: 4, result: {} });
});

test('tool calls return content; bad arguments and tool failures are tool errors', async () => {
  const mcp = protocol();
  const ok = await mcp.handle(call(1, 'tools/call', { name: 'echo', arguments: { text: 'ab', times: 2 } }));
  assert.deepEqual(ok.result, { content: [{ type: 'text', text: 'abab' }] });
  const missing = await mcp.handle(call(2, 'tools/call', { name: 'echo', arguments: {} }));
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /Missing required argument "text"/);
  const wrongType = await mcp.handle(call(3, 'tools/call', { name: 'echo', arguments: { text: 'a', times: 1.5 } }));
  assert.match(wrongType.result.content[0].text, /"times" must be an integer/);
  const failed = await mcp.handle(call(4, 'tools/call', { name: 'fail', arguments: {} }));
  assert.deepEqual(failed.result, { content: [{ type: 'text', text: 'Read the file first.' }], isError: true });
  const unknownTool = await mcp.handle(call(5, 'tools/call', { name: 'nope' }));
  assert.equal(unknownTool.error.code, -32602);
  const unknownMethod = await mcp.handle(call(6, 'resources/list'));
  assert.equal(unknownMethod.error.code, -32601);
  assert.equal((await mcp.handle({ id: 7, method: 'ping' })).error.code, -32600);
});

test('argument checks cover enums, arrays and unknown properties', () => {
  const schema = {
    type: 'object',
    properties: { kind: { type: 'string', enum: ['a', 'b'] }, list: { type: 'array', items: { type: 'string' } } },
    additionalProperties: false,
  };
  assert.equal(checkArguments(schema, { kind: 'a', list: ['x'] }), null);
  assert.match(checkArguments(schema, { kind: 'c' }), /must be one of: a, b/);
  assert.match(checkArguments(schema, { list: ['x', 2] }), /items must each be a string/);
  assert.match(checkArguments(schema, { other: 1 }), /Unknown argument "other"/);
  assert.match(checkArguments(schema, []), /must be an object/);
});

/** A raw HTTP request, so tests can send the headers a browser would. */
function request(port, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body !== undefined)
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

test('the HTTP transport requires the token and refuses web pages and foreign hosts', async (t) => {
  const server = new McpHttpServer({ protocol: protocol(), token: () => 'secret-token' });
  const port = await server.start(0);
  t.after(() => server.stop());
  const auth = { Authorization: 'Bearer secret-token' };
  const ping = call(1, 'ping');

  assert.equal((await request(port, { body: ping })).status, 401);
  assert.equal((await request(port, { body: ping, headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await request(port, { body: ping, headers: { ...auth, Origin: 'https://example.com' } })).status, 403);
  assert.equal((await request(port, { body: ping, headers: { ...auth, Host: 'attacker.example:80' } })).status, 403);
  assert.equal((await request(port, { method: 'GET', headers: auth })).status, 405);

  const ok = await request(port, { body: ping, headers: { ...auth, Origin: `http://127.0.0.1:${port}` } });
  assert.deepEqual(ok, { status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } });
  assert.equal((await request(port, { body: { jsonrpc: '2.0', method: 'notifications/initialized' }, headers: auth })).status, 202);
  assert.equal((await request(port, { body: '{not json', headers: auth })).body.error.code, -32700);
  const batch = await request(port, { body: [call(1, 'ping'), { jsonrpc: '2.0', method: 'notifications/initialized' }, call(2, 'ping')], headers: auth });
  assert.deepEqual(batch.body.map((r) => r.id), [1, 2]);
});

test('the server falls back to a free port when the preferred one is taken', async (t) => {
  const first = new McpHttpServer({ protocol: protocol(), token: () => 't' });
  const taken = await first.start(0);
  t.after(() => first.stop());
  const second = new McpHttpServer({ protocol: protocol(), token: () => 't' });
  const port = await second.start(taken);
  t.after(() => second.stop());
  assert.notEqual(port, taken);
});

test('settings keep a stable token and the connection file follows the running server', async (t) => {
  const folder = tempDir('mcp');
  const service = new McpService({ folder, version: '1.0.0', tools: [echo] });
  assert.equal(service.status().enabled, false);
  const token = service.status().token;
  assert.ok(token.length >= 32);
  assert.equal(new McpSettings(folder).read().token, token, 'the token is saved');

  service.settings.update({ port: 0 });
  const status = await service.setEnabled(true);
  t.after(() => service.stop());
  assert.equal(status.running, true);
  const connection = JSON.parse(fs.readFileSync(service.settings.connectionFile, 'utf8'));
  assert.equal(connection.url, status.url);
  assert.equal(connection.token, token);
  assert.equal(new McpSettings(folder).read().enabled, true, 'the choice survives a restart');

  const newToken = service.regenerateToken().token;
  assert.notEqual(newToken, token);
  assert.equal(JSON.parse(fs.readFileSync(service.settings.connectionFile, 'utf8')).token, newToken);

  await service.setEnabled(false);
  assert.equal(fs.existsSync(service.settings.connectionFile), false);
});

test('the bridge answers requests with a clear error when Keywright is not running', async () => {
  const missing = path.join(tempDir('mcp'), 'mcp-connection.json');
  const reply = await forward(call(7, 'tools/list'), missing);
  assert.deepEqual(reply, { jsonrpc: '2.0', id: 7, error: { code: -32000, message: NOT_RUNNING } });
  assert.equal(await forward({ jsonrpc: '2.0', method: 'notifications/initialized' }, missing), null);
});

test('the stdio bridge relays a session to the running server', { timeout: 30_000 }, async (t) => {
  const folder = tempDir('mcp');
  const service = new McpService({ folder, version: '1.0.0', tools: [echo] });
  service.settings.update({ port: 0 });
  await service.setEnabled(true);
  t.after(() => service.stop());

  const child = spawn(process.execPath, [BRIDGE, '--connection', service.settings.connectionFile], { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const lines = [];
  let buffer = '';
  const waiters = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
      waiters.splice(0).forEach((resolve) => resolve());
    }
  });
  const next = async (count) => {
    while (lines.length < count)
      await new Promise((resolve) => waiters.push(resolve));
  };
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

  send(call(1, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'bridge-test', version: '2' }, capabilities: {} }));
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send(call(2, 'tools/call', { name: 'echo', arguments: { text: 'hi' } }));
  await next(2);
  const byId = new Map(lines.map((line) => [line.id, line]));
  assert.equal(byId.get(1).result.serverInfo.name, 'keywright');
  assert.deepEqual(byId.get(2).result.content, [{ type: 'text', text: 'hi' }]);
  assert.deepEqual(service.status().clients, ['bridge-test 2']);
  assert.equal(service.status().lastCall.tool, 'echo');
});
