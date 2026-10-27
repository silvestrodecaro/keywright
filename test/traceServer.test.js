'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TraceServer } = require('../src/main/traceServer');

test('serves the trace viewer and only the allowed trace files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfide-trace-'));
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
