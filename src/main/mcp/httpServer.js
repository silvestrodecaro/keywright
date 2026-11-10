'use strict';

const http = require('http');
const { timingSafeEqual } = require('crypto');
const { errorResponse, PARSE_ERROR, INVALID_REQUEST } = require('./protocol');

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const ENDPOINT = '/mcp';
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

function sameToken(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The Streamable HTTP transport of MCP, without server-sent events: each POST
 * carries one message (or a batch, for 2025-03-26 clients) and gets a JSON reply.
 * It listens on the loopback interface only and requires the bearer token.
 *
 * A web page in a local browser could otherwise reach the port: requests with a
 * foreign Origin and Host names other than loopback (DNS rebinding) are refused
 * before the token is checked.
 */
class McpHttpServer {
  /**
   * @param {{ protocol: { handle(message: unknown): Promise<object|null> }, token: () => string }} options
   */
  constructor({ protocol, token }) {
    this.protocol = protocol;
    this.token = token;
    this._server = null;
    this.port = null;
  }

  get url() {
    return this.port ? `http://127.0.0.1:${this.port}${ENDPOINT}` : null;
  }

  /**
   * Listens on `port`, or on a free port when it is taken (or 0).
   * @returns {Promise<number>} the port in use
   */
  async start(port = 0) {
    if (this._server)
      return this.port;
    const server = http.createServer((request, response) => {
      this._handle(request, response).catch((error) => {
        if (!response.headersSent)
          reply(response, 500, errorResponse(null, -32603, error.message));
        else
          response.destroy();
      });
    });
    // Tool calls such as a test run can take minutes: no response timeout.
    server.requestTimeout = 60_000;
    server.timeout = 0;
    const listen = (value) => new Promise((resolve, reject) => {
      const onError = (error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(server.address().port); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(value, '127.0.0.1');
    });
    try {
      this.port = await listen(port);
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || !port)
        throw error;
      this.port = await listen(0);
    }
    this._server = server;
    return this.port;
  }

  stop() {
    if (!this._server)
      return Promise.resolve();
    const server = this._server;
    this._server = null;
    this.port = null;
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  async _handle(request, response) {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname !== ENDPOINT)
      return reply(response, 404, { error: `Not found. The MCP endpoint is ${ENDPOINT}.` });
    if (!LOCAL_HOST.test(request.headers.host || ''))
      return reply(response, 403, { error: 'Only local connections are accepted.' });
    const origin = request.headers.origin;
    if (origin && !isLocalOrigin(origin))
      return reply(response, 403, { error: 'Requests from web pages are not accepted.' });
    const authorization = request.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (!match || !sameToken(match[1].trim(), this.token()))
      return reply(response, 401, { error: 'Missing or wrong token. Copy the connection settings again from Keywright.' });
    if (request.method !== 'POST') {
      // No server-initiated stream (GET) and no sessions to end (DELETE).
      response.setHeader('Allow', 'POST');
      return reply(response, 405, { error: 'Use POST.' });
    }

    let body;
    try {
      body = await readBody(request);
    } catch (error) {
      return reply(response, 413, errorResponse(null, INVALID_REQUEST, error.message));
    }
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      return reply(response, 400, errorResponse(null, PARSE_ERROR, 'The request body is not valid JSON.'));
    }
    if (Array.isArray(message)) {
      if (!message.length)
        return reply(response, 400, errorResponse(null, INVALID_REQUEST, 'Empty batch.'));
      const replies = (await Promise.all(message.map((item) => this.protocol.handle(item)))).filter(Boolean);
      return replies.length ? reply(response, 200, replies) : accepted(response);
    }
    const result = await this.protocol.handle(message);
    return result ? reply(response, 200, result) : accepted(response);
  }
}

function isLocalOrigin(origin) {
  try {
    return LOCAL_HOST.test(new URL(origin).host);
  } catch {
    return false;
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('The request is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function reply(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  response.end(body);
}

function accepted(response) {
  response.writeHead(202, { 'Content-Length': 0 });
  response.end();
}

module.exports = { McpHttpServer, ENDPOINT };
