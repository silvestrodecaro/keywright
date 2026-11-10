'use strict';

// The AI clients Keywright knows how to connect: the configuration each one needs,
// and a read-only check of the client's own configuration file. Keywright never
// writes these files; the user copies the configuration and the dialog reports
// what it finds, and whether the client has actually connected.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_NAME = 'keywright';

/**
 * Where each client keeps its MCP configuration, from the environment of this computer.
 * @param {{ env?: object, home?: string, project?: string|null }} [options]
 *   project: the open project, whose own Antigravity workspace file is checked too
 */
function clientLocations({ env = process.env, home = env.KEYWRIGHT_CLIENT_HOME || os.homedir(), project = null } = {}) {
  // KEYWRIGHT_CLIENT_HOME: UI tests point every client at a temporary home.
  const isolated = !!env.KEYWRIGHT_CLIENT_HOME;
  const appData = (!isolated && env.APPDATA) || path.join(home, 'AppData', 'Roaming');
  const codexHome = (!isolated && env.CODEX_HOME) || path.join(home, '.codex');
  return {
    'claude-code': [path.join(home, '.claude.json')],
    'claude-desktop': [process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : path.join(appData, 'Claude', 'claude_desktop_config.json')],
    codex: [path.join(codexHome, 'config.toml')],
    // The global file first, then the project's workspace file, then the location of earlier releases.
    antigravity: [
      path.join(home, '.gemini', 'config', 'mcp_config.json'),
      ...(project ? [path.join(project, '.agents', 'mcp_config.json')] : []),
      path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
    ],
    cursor: [path.join(home, '.cursor', 'mcp.json')],
  };
}

const quoteArg = (value) => (/[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value);
const tomlString = (value) => (value.includes("'") ? JSON.stringify(value) : `'${value}'`);
const jsonConfig = (server) => JSON.stringify({ mcpServers: { [SERVER_NAME]: server } }, null, 2);

/**
 * The clients, each with the configuration for this computer.
 * @param {{ bridge: { command: string, args: string[], env: Record<string,string> }, url: string|null, port: number, token: string }} status
 */
function clientConfigs(status, locations = clientLocations()) {
  const { command, args, env } = status.bridge;
  const stdio = { command, args, env };
  const envFlags = Object.entries(env).map(([k, v]) => `--env ${k}=${v}`);
  const url = status.url || `http://127.0.0.1:${status.port}/mcp`;
  const shown = (file) => file.replace(os.homedir(), '~');
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      // The name comes first: --env takes several values and would swallow it.
      config: [`claude mcp add ${SERVER_NAME} --scope user`, ...envFlags, '--', quoteArg(command), ...args.map(quoteArg)].join(' '),
      help: 'Run this once in a terminal. It adds Keywright to Claude Code for all your projects; start a new Claude Code session afterwards.',
    },
    {
      id: 'codex',
      label: 'Codex',
      config: [
        `[mcp_servers.${SERVER_NAME}]`,
        `command = ${tomlString(command)}`,
        `args = [${args.map(tomlString).join(', ')}]`,
        `env = { ${Object.entries(env).map(([k, v]) => `${k} = "${v}"`).join(', ')} }`,
        'tool_timeout_sec = 120',
      ].join('\n'),
      help: `Add this to ${shown(locations.codex[0])}, which the Codex CLI, IDE extension and app share. Or run: codex mcp add ${SERVER_NAME} ${envFlags.join(' ')} -- ${quoteArg(command)} ${args.map(quoteArg).join(' ')}`,
    },
    {
      id: 'antigravity',
      label: 'Antigravity',
      config: jsonConfig(stdio),
      help: `Add the "${SERVER_NAME}" entry under "mcpServers" in ${shown(locations.antigravity[0])}, which the Antigravity app, IDE and CLI share; if the file is empty, paste all of it. To find the file in the app: Customizations > Installed > MCP Servers > ⋮ > Copy Config File Path; in the IDE: agent panel … > MCP Servers > Manage MCP Servers > View raw config. Then restart the server there. Settings > MCP Tools only sets permissions.`,
    },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      config: jsonConfig(stdio),
      help: 'In Claude Desktop open Settings > Developer > Edit Config, add the entry under "mcpServers" in claude_desktop_config.json, and restart Claude Desktop.',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      config: jsonConfig(stdio),
      help: `Add the entry under "mcpServers" in ${shown(locations.cursor[0])}, or in .cursor/mcp.json in a project.`,
    },
    {
      id: 'http',
      label: 'Other client (HTTP)',
      config: [
        `URL: ${url}`,
        `Header: Authorization: Bearer ${status.token}`,
        '',
        'Claude Code over HTTP:',
        `claude mcp add --transport http ${SERVER_NAME} ${url} --header "Authorization: Bearer ${status.token}"`,
      ].join('\n'),
      help: 'For clients that connect to an MCP URL (Streamable HTTP), with the token as a bearer token. The port changes when it is taken at startup; the stdio configurations above follow it automatically.',
    },
  ];
}

// ---------------------------------------------------------------------------
// Reading client configuration

/**
 * Reads the value of one TOML key: basic and literal strings, arrays and inline
 * tables of those, numbers and booleans. Enough for an MCP server table.
 * @returns {{ value: unknown, rest: string }}
 */
function parseTomlValue(text) {
  const input = text.trimStart();
  if (input.startsWith('"')) {
    const match = /^"((?:[^"\\]|\\.)*)"/.exec(input);
    if (!match) throw new Error('unterminated string');
    return { value: JSON.parse(`"${match[1]}"`), rest: input.slice(match[0].length) };
  }
  if (input.startsWith("'")) {
    const end = input.indexOf("'", 1);
    if (end < 0) throw new Error('unterminated string');
    return { value: input.slice(1, end), rest: input.slice(end + 1) };
  }
  if (input.startsWith('[') || input.startsWith('{')) {
    const table = input[0] === '{';
    const close = table ? '}' : ']';
    const result = table ? {} : [];
    let rest = input.slice(1);
    for (;;) {
      rest = rest.replace(/^(\s|#[^\n]*)+/, '');
      if (rest.startsWith(close))
        return { value: result, rest: rest.slice(1) };
      if (table) {
        const key = /^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*=/.exec(rest);
        if (!key) throw new Error('bad inline table');
        const name = key[1].startsWith('"') ? JSON.parse(key[1]) : key[1].replace(/^'|'$/g, '');
        const item = parseTomlValue(rest.slice(key[0].length));
        result[name] = item.value;
        rest = item.rest;
      } else {
        const item = parseTomlValue(rest);
        result.push(item.value);
        rest = item.rest;
      }
      rest = rest.replace(/^(\s|#[^\n]*)+/, '');
      if (rest.startsWith(','))
        rest = rest.slice(1);
    }
  }
  const scalar = /^([^\s,\]}#]+)/.exec(input);
  if (!scalar) throw new Error('missing value');
  const raw = scalar[1];
  const value = raw === 'true' ? true : raw === 'false' ? false : Number.isNaN(Number(raw)) ? raw : Number(raw);
  return { value, rest: input.slice(raw.length) };
}

/** The [mcp_servers.<name>] table of a Codex config.toml, with its env subtable. */
function readTomlServer(text, name = SERVER_NAME) {
  const header = (line) => /^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/.exec(line);
  const wanted = `mcp_servers.${name}`;
  let entry = null;
  let target = null;
  let rest = text.replace(/\r\n/g, '\n');
  while (rest.length) {
    const newline = rest.indexOf('\n');
    const line = newline < 0 ? rest : rest.slice(0, newline);
    const found = header(line);
    if (found && !line.trim().startsWith('[[')) {
      const table = found[1].replace(/["']/g, '');
      if (table === wanted)
        target = entry = entry || {};
      else if (table === `${wanted}.env`)
        target = (entry = entry || {}).env = { ...(entry?.env || {}) };
      else
        target = null;
      rest = newline < 0 ? '' : rest.slice(newline + 1);
      continue;
    }
    const key = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*=/.exec(line);
    if (target && key) {
      const parsed = parseTomlValue(rest.slice(key[0].length));
      target[key[1].replace(/^["']|["']$/g, '')] = parsed.value;
      rest = parsed.rest.replace(/^[^\n]*\n?/, ''); // the rest of the line (a comment)
      continue;
    }
    rest = newline < 0 ? '' : rest.slice(newline + 1);
  }
  return entry;
}

/** The "keywright" server entry of a client's file, or null; throws when the file cannot be parsed. */
function readEntry(id, text) {
  const content = text.replace(/^\uFEFF/, ''); // Notepad may save a byte order mark
  if (!content.trim())
    return null; // created but still empty
  if (id === 'codex')
    return readTomlServer(content);
  const json = JSON.parse(content);
  if (id === 'claude-code') {
    if (json.mcpServers?.[SERVER_NAME])
      return { ...json.mcpServers[SERVER_NAME], scope: 'user' };
    for (const [folder, settings] of Object.entries(json.projects || {})) {
      if (settings?.mcpServers?.[SERVER_NAME])
        return { ...settings.mcpServers[SERVER_NAME], scope: `project ${folder}` };
    }
    return null;
  }
  return json.mcpServers?.[SERVER_NAME] || null;
}

const samePath = (a, b) => {
  const normal = (value) => path.normalize(String(value || '')).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normal(a).toLowerCase() === normal(b).toLowerCase() : normal(a) === normal(b);
};

/** Whether an entry starts this Keywright's bridge, or reaches this server over HTTP. */
function compareEntry(entry, status) {
  if (entry.disabled === true)
    return { state: 'outdated', detail: 'The entry is disabled ("disabled": true); turn it on in the client.' };
  const remote = entry.url || entry.serverUrl || entry.httpUrl;
  if (remote) {
    const header = entry.headers?.Authorization || entry.headers?.authorization || '';
    if (status.url && remote.replace(/\/$/, '') !== status.url)
      return { state: 'outdated', detail: `It connects to ${remote}, but the server is at ${status.url}.` };
    if (header && header !== `Bearer ${status.token}`)
      return { state: 'outdated', detail: 'It uses an old token. Copy the HTTP configuration again.' };
    return { state: 'configured', detail: 'Configured over HTTP.' };
  }
  const { command, args, env } = status.bridge;
  if (!samePath(entry.command, command))
    return { state: 'outdated', detail: `It starts ${entry.command || 'nothing'}, not this Keywright's Electron (${command}). Copy the configuration again.` };
  const given = Array.isArray(entry.args) ? entry.args : [];
  if (given.length !== args.length || given.some((value, index) => !samePath(value, args[index]) && value !== args[index]))
    return { state: 'outdated', detail: 'Its arguments point to another Keywright folder or connection file. Copy the configuration again.' };
  for (const [key, value] of Object.entries(env)) {
    if (String(entry.env?.[key] ?? '') !== value)
      return { state: 'outdated', detail: `It does not set ${key}=${value}, so Electron would open a window instead of running the bridge.` };
  }
  return { state: 'configured', detail: null };
}

/**
 * What each client's own configuration says about Keywright, read-only.
 * @returns {Record<string, { state: 'configured'|'outdated'|'missing'|'unreadable'|'manual', detail: string|null, file: string|null }>}
 */
function clientStates(status, locations = clientLocations()) {
  const states = {};
  for (const [id, files] of Object.entries(locations)) {
    let result = { state: 'missing', detail: null, file: files[0] };
    for (const file of files) {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue; // not installed, or not configured yet
      }
      let entry;
      try {
        entry = readEntry(id, text);
      } catch (error) {
        result = { state: 'unreadable', detail: `Could not read it: ${error.message}`, file };
        break;
      }
      if (!entry)
        continue;
      result = { ...compareEntry(entry, status), file, entry };
      if (id === 'claude-code' && entry.scope !== 'user' && result.state === 'configured')
        result.detail = `Configured for one project only (${entry.scope.slice('project '.length)}).`;
      if (id === 'antigravity' && file === files.at(-1) && files.length > 1 && result.state === 'configured')
        result.detail = 'Found in the older Antigravity location; current releases read ~/.gemini/config/mcp_config.json.';
      else if (id === 'antigravity' && file !== files[0] && result.state === 'configured')
        result.detail = 'Configured for this project only, in its .agents/mcp_config.json.';
      break;
    }
    states[id] = result;
  }
  states.http = { state: 'manual', detail: null, file: null };
  return states;
}

/**
 * The stdio command a client will run, read back from the configuration text the
 * dialog shows, so a connection test also checks that text. Claude Code's terminal
 * command is turned into the same command by the CLI. Null for HTTP clients.
 */
function launchConfig(client, status) {
  if (client.id === 'http')
    return null;
  if (client.id === 'codex')
    return readTomlServer(client.config);
  if (client.id === 'claude-code')
    return status.bridge;
  return JSON.parse(client.config).mcpServers[SERVER_NAME];
}

/**
 * What Test connection runs for a client. A configured client is tested with the
 * entry read from its own file, which is what the client will start; a client
 * without an entry can only show that the configuration offered works here.
 * @returns {{ kind: 'client', config?: object, url?: string, token?: string, file: string }
 *   | { kind: 'generated', config: object, file: string|null }
 *   | { kind: 'http', url: string, token: string }
 *   | { kind: 'unreadable', error: string, file: string }}
 */
function connectionPlan(clientId, status, locations = clientLocations()) {
  const client = clientConfigs(status, locations).find((item) => item.id === clientId);
  if (!client)
    throw new Error(`Unknown client: ${clientId}`);
  if (client.id === 'http')
    return { kind: 'http', url: status.url, token: status.token };
  const found = clientStates(status, locations)[client.id];
  if (found.state === 'unreadable')
    return { kind: 'unreadable', error: found.detail, file: found.file };
  if (!found.entry)
    return { kind: 'generated', config: launchConfig(client, status), file: found.file };
  const entry = found.entry;
  const remote = entry.url || entry.serverUrl || entry.httpUrl;
  if (remote) {
    const header = entry.headers?.Authorization || entry.headers?.authorization || '';
    return { kind: 'client', url: remote, token: header.replace(/^Bearer\s+/i, ''), file: found.file };
  }
  return { kind: 'client', config: { command: entry.command, args: entry.args || [], env: entry.env || {} }, file: found.file };
}

/** The client a connecting MCP client corresponds to, from the name it reports. */
function clientIdFor(name) {
  const value = String(name || '').toLowerCase();
  if (/claude-code|claude code/.test(value)) return 'claude-code';
  if (/claude-ai|claude desktop|claude-desktop/.test(value)) return 'claude-desktop';
  if (/codex/.test(value)) return 'codex';
  if (/antigravity|jetski/.test(value)) return 'antigravity';
  if (/cursor/.test(value)) return 'cursor';
  return 'http';
}

module.exports = { clientConfigs, clientStates, launchConfig, connectionPlan, clientLocations, clientIdFor, readTomlServer, parseTomlValue, compareEntry, SERVER_NAME };
