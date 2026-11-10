'use strict';

const path = require('path');
const { EventEmitter } = require('events');
const { McpProtocol } = require('./protocol');
const { McpHttpServer } = require('./httpServer');
const { McpSettings } = require('./settings');
const { INSTRUCTIONS } = require('./tools');
const { clientIdFor } = require('./clients');
const { TEST_CLIENT } = require('./connectionTest');

const BRIDGE = path.join(__dirname, 'bridge.js');

/**
 * Keywright's MCP server, switched on and off by the user.
 * The setting survives restarts; while the server listens, the connection file
 * tells the stdio bridge where it is.
 *
 * Events: 'state' (status) whenever the server starts, stops, fails, or a client
 * connects or calls a tool.
 */
class McpService extends EventEmitter {
  /**
   * @param {{ folder: string, version: string, tools: object[], runtime?: string }} options
   *   runtime: the executable that runs the bridge (Electron as Node by default)
   */
  constructor({ folder, version, tools, runtime = process.execPath }) {
    super();
    this.settings = new McpSettings(folder);
    this.runtime = runtime;
    this.error = null;
    this.clients = [];
    this.seen = {}; // client id -> time of its last initialize
    this.lastCall = null;
    this.protocol = new McpProtocol({
      name: 'keywright',
      title: 'Keywright',
      version,
      instructions: INSTRUCTIONS,
      tools,
      onInitialize: (client) => {
        if (client.name === TEST_CLIENT)
          return; // the dialog's own connection test
        this.seen[clientIdFor(client.name || client.title)] = new Date().toISOString();
        const name = [client.title || client.name, client.version].filter(Boolean).join(' ') || 'Unknown client';
        this.clients = [name, ...this.clients.filter((other) => other !== name)].slice(0, 5);
        this._publish();
      },
      onToolCall: (tool) => {
        this.lastCall = { tool, at: new Date().toISOString() };
        this._publish();
      },
    });
    this.server = new McpHttpServer({ protocol: this.protocol, token: () => this.settings.read().token });
  }

  get running() {
    return !!this.server.port;
  }

  status() {
    const { enabled, token, port } = this.settings.read();
    return {
      enabled,
      running: this.running,
      error: this.error,
      url: this.server.url,
      port: this.server.port || port,
      token,
      clients: this.clients,
      seen: this.seen,
      lastCall: this.lastCall,
      bridge: { command: this.runtime, args: [BRIDGE, '--connection', this.settings.connectionFile], env: { ELECTRON_RUN_AS_NODE: '1' } },
    };
  }

  /** Starts the server when the setting is on (application start). */
  async restore() {
    if (this.settings.read().enabled)
      await this.start();
    return this.status();
  }

  async setEnabled(enabled) {
    this.settings.update({ enabled: !!enabled });
    if (enabled)
      await this.start();
    else
      await this.stop();
    return this.status();
  }

  async start() {
    this.error = null;
    try {
      const { port, token } = this.settings.read();
      await this.server.start(port);
      this.settings.writeConnection(this.server.url, token);
    } catch (error) {
      this.error = `The MCP server could not start: ${error.message}`;
      await this.server.stop();
    }
    this._publish();
  }

  async stop() {
    await this.server.stop();
    this.settings.removeConnection();
    this.clients = [];
    this.seen = {};
    this.lastCall = null;
    this._publish();
  }

  /** A new token disconnects clients configured with the old one (HTTP); the bridge reads the new one. */
  regenerateToken() {
    const token = this.settings.regenerateToken();
    if (this.running)
      this.settings.writeConnection(this.server.url, token);
    this._publish();
    return this.status();
  }

  _publish() {
    this.emit('state', this.status());
  }
}

module.exports = { McpService, BRIDGE };
