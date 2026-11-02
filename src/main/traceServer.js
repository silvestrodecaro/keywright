'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { resolveInside } = require('./pathBoundary');

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

// The IDE's thin scrollbars (see styles.css), added to the viewer's page: the IDE's stylesheet does not
// reach into the frame. Snapshots of the recorded pages are separate documents and keep their own.
const VIEWER_STYLE = `<style>
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 5px; background: #38424a padding-box; }
::-webkit-scrollbar-thumb:hover { background-color: #4e5a63; }
::-webkit-scrollbar-button { display: none; }
</style>`;

function isInside(dir, file) {
  const relative = path.relative(dir, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
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
    let url, pathname;
    try {
      url = new URL(request.url, 'http://127.0.0.1');
      pathname = decodeURIComponent(url.pathname);
      if (pathname.includes('\0') || url.searchParams.get('path')?.includes('\0'))
        return this._send(response, 400);
    } catch {
      return this._send(response, 400);
    }
    if (request.method === 'GET' && pathname.startsWith('/output/') && this._outputDir) {
      const file = path.resolve(this._outputDir, pathname.slice('/output/'.length));
      return isInside(this._outputDir, file) ? this._sendFile(response, file, this._outputDir) : this._send(response, 403);
    }
    if (request.method !== 'GET' || !pathname.startsWith('/trace/'))
      return this._send(response, 404);
    const relative = pathname.slice('/trace/'.length);
    if (relative === 'file') {
      const file = path.resolve(url.searchParams.get('path') || '');
      const allowed = this._allowed.find((dir) => isInside(dir, file));
      if (path.extname(file).toLowerCase() !== '.zip' || !allowed)
        return this._send(response, 403);
      return this._sendFile(response, file, allowed);
    }
    const file = path.resolve(VIEWER_ROOT, relative || 'index.html');
    if (!isInside(VIEWER_ROOT, file))
      return this._send(response, 403);
    if (file === path.join(VIEWER_ROOT, 'index.html'))
      return this._sendViewerPage(response, file);
    return this._sendFile(response, file, VIEWER_ROOT);
  }

  _sendViewerPage(response, file) {
    fs.readFile(file, 'utf8', (error, html) => {
      if (error)
        return this._send(response, 404);
      const body = Buffer.from(html.replace('</head>', `${VIEWER_STYLE}</head>`));
      response.writeHead(200, {
        'Content-Type': CONTENT_TYPES['.html'],
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      response.end(body);
    });
  }

  _sendFile(response, file, root) {
    try {
      file = resolveInside(root, path.relative(root, file));
    } catch (error) {
      return this._send(response, error.code === 'ERR_OUTSIDE_ROOT' ? 403 : 404);
    }
    fs.stat(file, (error, stats) => {
      if (error || !stats.isFile())
        return this._send(response, 404);
      const stream = fs.createReadStream(file);
      stream.once('error', (error) => {
        if (response.destroyed)
          return;
        if (response.headersSent)
          response.destroy();
        else
          this._send(response, error.code === 'ENOENT' ? 404 : 500);
      });
      response.once('close', () => stream.destroy());
      // The output may be replaced by another test run after stat completed.
      // Wait until open succeeds so a missing file can still return an error status.
      stream.once('open', () => {
        if (response.destroyed)
          return stream.destroy();
        response.writeHead(200, {
          'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Content-Length': stats.size,
          'Cache-Control': 'no-store',
        });
        stream.pipe(response);
      });
    });
  }

  _send(response, status) {
    response.writeHead(status);
    response.end();
  }
}

module.exports = { TraceServer, VIEWER_ROOT };
