#!/usr/bin/env node
'use strict';

// stdio bridge to Keywright's MCP server, for clients that start a command
// (Claude Desktop, Codex, Cursor, Claude Code). It reads newline-delimited JSON-RPC
// from stdin, posts each message to the running Keywright, and writes the replies
// to stdout. The address and token come from the connection file Keywright writes
// while its MCP server is on, so the client configuration holds no secret.
//
// Usage: node bridge.js --connection <path to mcp-connection.json>
// Keywright's MCP server dialog shows the exact command for this computer.

const fs = require('fs');
const path = require('path');
const os = require('os');

function defaultConnectionFile() {
  const base = process.platform === 'win32'
    ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'keywright', 'mcp-connection.json');
}

function connectionFileFromArgs(argv) {
  const index = argv.indexOf('--connection');
  return index >= 0 && argv[index + 1] ? argv[index + 1] : defaultConnectionFile();
}

const NOT_RUNNING = 'Keywright is not running or its MCP server is off. Open Keywright and turn on the MCP server (title bar: MCP), then try again.';

function readConnection(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof value.url === 'string' && typeof value.token === 'string')
      return value;
  } catch {
    // not running
  }
  return null;
}

/**
 * Forwards one message. Requests always get a reply, so the client never waits
 * forever: transport failures become JSON-RPC errors with the request's id.
 * @returns {Promise<object | object[] | null>}
 */
async function forward(message, connectionFile, fetchImpl = fetch) {
  const isRequest = (item) => item && typeof item === 'object' && typeof item.method === 'string' && item.id !== undefined && item.id !== null;
  const failure = (text) => {
    const items = Array.isArray(message) ? message.filter(isRequest) : isRequest(message) ? [message] : [];
    const errors = items.map((item) => ({ jsonrpc: '2.0', id: item.id, error: { code: -32000, message: text } }));
    return Array.isArray(message) ? (errors.length ? errors : null) : errors[0] || null;
  };
  const connection = readConnection(connectionFile);
  if (!connection)
    return failure(NOT_RUNNING);
  let response;
  try {
    response = await fetchImpl(connection.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${connection.token}`,
      },
      body: JSON.stringify(message),
    });
  } catch {
    return failure(NOT_RUNNING);
  }
  if (response.status === 202)
    return null;
  let parsed;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    return failure(`Keywright replied ${response.status} without a JSON body.`);
  }
  if (parsed && (parsed.jsonrpc || Array.isArray(parsed)))
    return parsed;
  // Transport refusals (wrong token, ...) carry { error: text }.
  return failure(parsed?.error || `Keywright replied ${response.status}.`);
}

function main() {
  const connectionFile = connectionFileFromArgs(process.argv.slice(2));
  let buffer = '';
  let notifications = Promise.resolve();
  const inFlight = new Set();
  const write = (value) => {
    if (value)
      process.stdout.write(`${JSON.stringify(value)}\n`);
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line)
        continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } });
        continue;
      }
      // Replies may arrive out of order (JSON-RPC matches them by id), so a long
      // tool call does not hold back pings; only notifications keep their order.
      const run = () => forward(message, connectionFile).then(write);
      const task = message && message.id === undefined ? (notifications = notifications.then(run, run)) : run();
      inFlight.add(task);
      task.finally(() => inFlight.delete(task));
    }
  });
  process.stdin.on('end', () => Promise.allSettled([...inFlight]).then(() => process.exit(0)));
}

if (require.main === module)
  main();

module.exports = { forward, connectionFileFromArgs, defaultConnectionFile, NOT_RUNNING };
