'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TraceServer } = require('../src/main/traceServer');
const { tempDir } = require('./helpers/tempDir');

test('serves the trace viewer and only the allowed trace files', async () => {
  const dir = tempDir('trace');
  const allowed = path.join(dir, 'results');
  fs.mkdirSync(path.join(allowed, 'browser', 'traces'), { recursive: true });
  const trace = path.join(allowed, 'browser', 'traces', 'trace_1.zip');
  fs.writeFileSync(trace, 'PK fake zip');
  fs.writeFileSync(path.join(allowed, 'secret.txt'), 'no');
  fs.writeFileSync(path.join(dir, 'outside.zip'), 'no');

  const server = new TraceServer();
  server.allow([allowed]);
  try {
    const url = new URL(await server.urlFor(trace));
    assert.strictEqual(url.hostname, '127.0.0.1');
    assert.strictEqual(url.searchParams.get('trace'), `file?path=${encodeURIComponent(trace)}`);

    const index = await fetch(url);
    assert.strictEqual(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(await index.text(), /<div id="root">|id=root/);
    assert.strictEqual((await fetch(new URL('/trace/sw.bundle.js', url))).status, 200);

    const file = (p) => fetch(new URL(`/trace/file?path=${encodeURIComponent(p)}`, url));
    const ok = await file(trace);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(await ok.text(), 'PK fake zip');
    assert.strictEqual((await file(path.join(dir, 'outside.zip'))).status, 403);
    assert.strictEqual((await file(path.join(allowed, 'secret.txt'))).status, 403);
    assert.strictEqual((await fetch(new URL('/trace/..%2f..%2fpackage.json', url))).status, 403);
    assert.strictEqual((await fetch(new URL('/other', url))).status, 404);
  } finally {
    server.stop();
  }
});

test('serves Robot report files from the results folder only', async () => {
  const dir = tempDir('output');
  const results = path.join(dir, 'results');
  fs.mkdirSync(path.join(results, 'browser', 'screenshot'), { recursive: true });
  fs.writeFileSync(path.join(results, 'log.html'), '<html>log</html>');
  fs.writeFileSync(path.join(results, 'browser', 'screenshot', 'fail 1.png'), 'PNG');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'no');
  const server = new TraceServer();
  try {
    const url = await server.outputUrl(results, 'log.html');
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/output\/log\.html$/);
    const log = await fetch(url);
    assert.strictEqual(log.status, 200);
    assert.match(log.headers.get('content-type'), /text\/html/);
    // Relative links (screenshots) resolve inside the folder.
    const shot = await fetch(new URL('browser/screenshot/fail%201.png', url));
    assert.strictEqual(shot.status, 200);
    assert.strictEqual(shot.headers.get('content-type'), 'image/png');
    // Nothing outside it, even with encoded ../
    assert.strictEqual((await fetch(new URL('/output/..%2Fsecret.txt', url))).status, 403);
    assert.strictEqual((await fetch(new URL('/output/missing.html', url))).status, 404);
  } finally {
    server.stop();
  }
});
