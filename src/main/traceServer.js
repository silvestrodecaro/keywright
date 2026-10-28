'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

// Playwright's trace viewer web app, shipped with playwright-core.
const VIEWER_ROOT = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'lib', 'vite', 'traceViewer');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webm': 'video/webm',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
};

function isInside(dir, file) {
  const relative = path.relative(dir, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Serves Playwright's trace viewer on 127.0.0.1 (its service worker needs
 * http, not file://) and the trace files of the allowed folders only; also
 * Robot's report and log under /output/, from the project's results folder only
 * (their links to each other and to screenshots are relative).
 */
class TraceServer {
  constructor() {
    this._server = null;
    this._port = null;
    this._allowed = [];
    this._outputDir = null;
  }

  /** @returns {Promise<string>} the URL of a file of `outputDir` (e.g. log.html), which becomes the served folder */
  async outputUrl(outputDir, file) {
    this._outputDir = path.resolve(outputDir);
    await this._start();
    return `http://127.0.0.1:${this._port}/output/${file.split('/').map(encodeURIComponent).join('/')}`;
  }

  /** Folders whose .zip traces may be served (e.g. the open project's results folder). */
  allow(dirs) {
    this._allowed = dirs.map((dir) => path.resolve(dir));
  }

  /** @returns {Promise<string>} the viewer URL showing `traceFile` */
  async urlFor(traceFile) {
    await this._start();
    const trace = `file?path=${encodeURIComponent(path.resolve(traceFile))}`;
    const params = new URLSearchParams({ trace });
    if (path.sep !== '/')
      params.set('pathSeparator', path.sep);
    return `http://127.0.0.1:${this._port}/trace/index.html?${params}`;
  }

  stop() {
    if (this._server)
      this._server.close();
    this._server = null;
    this._port = null;
  }

  _start() {
    if (this._server)
      return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = http.createServer((request, response) => this._handle(request, response));
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this._server = server;
        this._port = server.address().port;
        resolve();
      });
    });
  }

  _handle(request, response) {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname.startsWith('/output/') && this._outputDir) {
      const file = path.resolve(this._outputDir, decodeURIComponent(url.pathname.slice('/output/'.length)));
      return isInside(this._outputDir, file) ? this._sendFile(response, file) : this._send(response, 403);
    }
    if (request.method !== 'GET' || !url.pathname.startsWith('/trace/'))
      return this._send(response, 404);
    const relative = decodeURIComponent(url.pathname.slice('/trace/'.length));
    if (relative === 'file') {
      const file = path.resolve(url.searchParams.get('path') || '');
      if (path.extname(file).toLowerCase() !== '.zip' || !this._allowed.some((dir) => isInside(dir, file)))
        return this._send(response, 403);
      return this._sendFile(response, file);
    }
    const file = path.resolve(VIEWER_ROOT, relative || 'index.html');
    if (!isInside(VIEWER_ROOT, file))
      return this._send(response, 403);
    return this._sendFile(response, file);
  }

  _sendFile(response, file) {
    fs.stat(file, (error, stats) => {
      if (error || !stats.isFile())
        return this._send(response, 404);
      response.writeHead(200, {
        'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stats.size,
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(file).pipe(response);
    });
  }

  _send(response, status) {
    response.writeHead(status);
    response.end();
  }
}

module.exports = { TraceServer, VIEWER_ROOT };
