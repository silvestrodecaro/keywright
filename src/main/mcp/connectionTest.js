'use strict';

const { spawn } = require('child_process');

/** The client name the test reports; the service does not list it as a connected client. */
const TEST_CLIENT = 'keywright-connection-test';

/**
 * Starts a client's stdio command exactly as configured and performs what an MCP
 * client does first: initialize, the initialized notification and tools/list.
 * This proves the command, the bridge, the connection file and the server work
 * together on this computer, whatever client will later run the same command.
 * @param {{ command: string, args: string[], env?: Record<string,string> }} config
 * @returns {Promise<{ ok: true, tools: string[], server: string } | { ok: false, error: string }>}
 */
function testConnection(config, { timeoutMs = 20_000, baseEnv = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      const env = { ...baseEnv, ...(config.env || {}) };
      child = spawn(config.command, config.args || [], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolve({ ok: false, error: `Could not start ${config.command}: ${error.message}` });
      return;
    }
    let stdout = '';
    let stderr = '';
    let server = '';
    let settled = false;
    const finish = (result) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `No reply within ${timeoutMs / 1000} seconds.${stderr ? ` ${stderr.trim()}` : ''}` }), timeoutMs);
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on('error', (error) => finish({ ok: false, error: `Could not start ${config.command}: ${error.message}` }));
    child.on('exit', (code) => finish({ ok: false, error: `The command exited (code ${code}) before answering.${stderr ? ` ${stderr.trim()}` : ''}` }));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      let newline;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        let reply;
        try {
          reply = JSON.parse(line);
        } catch {
          finish({ ok: false, error: `The command printed something other than MCP messages: ${line.slice(0, 200)}` });
          return;
        }
        if (reply.error) {
          finish({ ok: false, error: reply.error.message });
          return;
        }
        if (reply.id === 1) {
          server = [reply.result?.serverInfo?.title || reply.result?.serverInfo?.name, reply.result?.serverInfo?.version].filter(Boolean).join(' ');
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (reply.id === 2) {
          finish({ ok: true, server, tools: (reply.result?.tools || []).map((tool) => tool.name) });
        }
      }
    });
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: TEST_CLIENT, version: '1' } },
    });
  });
}

/** The same check over HTTP, for clients configured with the URL and token. */
async function testHttpConnection(url, token, fetchImpl = fetch) {
  const post = async (message) => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
      body: JSON.stringify(message),
    });
    if (response.status === 202)
      return null;
    const body = await response.json();
    if (!response.ok || body.error)
      throw new Error(typeof body.error === 'string' ? body.error : body.error?.message || `HTTP ${response.status}`);
    return body.result;
  };
  try {
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: TEST_CLIENT, version: '1' } } });
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const server = [init.serverInfo?.title || init.serverInfo?.name, init.serverInfo?.version].filter(Boolean).join(' ');
    return { ok: true, server, tools: list.tools.map((tool) => tool.name) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = { testConnection, testHttpConnection, TEST_CLIENT };
