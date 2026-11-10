'use strict';

const fs = require('fs');
const path = require('path');
const { randomBytes, randomUUID } = require('crypto');

const DEFAULT_PORT = 47811;
const SETTINGS_FILE = 'mcp.json';
const CONNECTION_FILE = 'mcp-connection.json';

function newToken() {
  return randomBytes(32).toString('base64url');
}

/** Writes JSON through a temporary sibling, so a reader never sees half a file. */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
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
    let stored = {};
    try {
      stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // missing or unreadable: defaults, with a new token
    }
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

  removeConnection() {
    try {
      const current = JSON.parse(fs.readFileSync(this.connectionFile, 'utf8'));
      if (current.pid !== process.pid)
        return; // another Keywright window owns it
    } catch {
      return;
    }
    fs.rmSync(this.connectionFile, { force: true });
  }
}

module.exports = { McpSettings, DEFAULT_PORT, CONNECTION_FILE };
