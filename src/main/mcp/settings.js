'use strict';

const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');
const { readJson, writeJsonAtomic, parseJson } = require('../jsonFile');

const DEFAULT_PORT = 47811;
const SETTINGS_FILE = 'mcp.json';
const CONNECTION_FILE = 'mcp-connection.json';

function newToken() {
  return randomBytes(32).toString('base64url');
}

/** Writes JSON through a temporary sibling, so a reader never sees half a file. */
function writeJson(file, value) {
  writeJsonAtomic(file, value, { space: 2, mode: 0o600 });
}

/**
 * The MCP server's application settings, in the Electron user-data folder:
 * whether the server is on, its token and preferred port (mcp.json), and while it
 * runs, the address the stdio bridge connects to (mcp-connection.json).
 */
class McpSettings {
  /** @param {string} folder */
  constructor(folder) {
    this.folder = folder;
    this.file = path.join(folder, SETTINGS_FILE);
    this.connectionFile = path.join(folder, CONNECTION_FILE);
    this._values = null;
  }

  /** @returns {{ enabled: boolean, token: string, port: number }} */
  read() {
    if (this._values)
      return this._values;
    // Missing or damaged (kept aside by readJson): defaults, with a new token. A file
    // that cannot be read at all throws, so the token in it is not replaced.
    const result = readJson(this.file);
    const stored = result.status === 'ok' && result.value && typeof result.value === 'object' ? result.value : {};
    const values = {
      enabled: stored.enabled === true,
      token: typeof stored.token === 'string' && stored.token.length >= 32 ? stored.token : newToken(),
      port: Number.isInteger(stored.port) && stored.port > 0 && stored.port < 65536 ? stored.port : DEFAULT_PORT,
    };
    this._values = values;
    if (values.token !== stored.token)
      this._save();
    return values;
  }

  update(changes) {
    this._values = { ...this.read(), ...changes };
    this._save();
    return this._values;
  }

  regenerateToken() {
    return this.update({ token: newToken() }).token;
  }

  _save() {
    writeJson(this.file, this._values);
  }

  /** Published while the server listens; the bridge reads it on every request. */
  writeConnection(url, token) {
    writeJson(this.connectionFile, { url, token, pid: process.pid });
  }

  /** Removes a connection file whose Keywright is no longer running (it crashed). */
  removeStaleConnection() {
    let pid;
    try {
      pid = parseJson(fs.readFileSync(this.connectionFile, 'utf8')).pid;
    } catch {
      return;
    }
    try {
      process.kill(pid, 0); // still running: another Keywright owns it
      return;
    } catch (error) {
      if (error.code === 'EPERM')
        return; // running, owned by another user
    }
    fs.rmSync(this.connectionFile, { force: true });
  }

  removeConnection() {
    try {
      const current = parseJson(fs.readFileSync(this.connectionFile, 'utf8'));
      if (current.pid !== process.pid)
        return; // another Keywright window owns it
    } catch {
      return;
    }
    fs.rmSync(this.connectionFile, { force: true });
  }
}

module.exports = { McpSettings, DEFAULT_PORT, CONNECTION_FILE };
