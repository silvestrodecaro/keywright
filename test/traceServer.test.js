'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TraceServer } = require('../src/main/traceServer');
const { tempDir } = require('./helpers/tempDir');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');

test('a report removed between stat and stream open returns 404 and leaves the server running', { timeout: 10000 }, async (t) => {
  const root = tempDir('output-disappears');
  const file = path.join(root, 'report.html');
  fs.writeFileSync(file, 'initial report');
  // Isolate the server because the regression is an unhandled stream error
  // that terminates its process. The filesystem operation and HTTP request are real.
  const child = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    const { TraceServer } = require(process.argv[1]);
    const root = process.argv[2];
    const createReadStream = fs.createReadStream;
    let removed = false;
    fs.createReadStream = (file, ...args) => {
      if (!removed && path.basename(file) === 'report.html') {
        removed = true;
        fs.unlinkSync(file);
      }
      return createReadStream(file, ...args);
    };
    new TraceServer().outputUrl(root, 'report.html').then(url => console.log(url));
  `, require.resolve('../src/main/traceServer'), root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.setEncoding('utf8').on('data', (text) => { errors += text; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
  });
  const lines = createInterface({ input: child.stdout });
  const [url] = await once(lines, 'line');
  lines.close();
  let response, requestError;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(2000) });
  } catch (error) {
    requestError = error;
  }
  assert.strictEqual(response?.status, 404, requestError ? `request failed: ${requestError}\n${errors}` : 'missing report status');
  await response.text();
  fs.writeFileSync(file, 'replacement report');
  const next = await fetch(url, { signal: AbortSignal.timeout(2000) });
  assert.strictEqual(next.status, 200);
  assert.strictEqual(await next.text(), 'replacement report');
});

test('output requests cannot follow a directory link outside the permitted output folder', async (t) => {
  const base = tempDir('output-link');
  const output = path.join(base, 'results');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(output);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(output, 'report.html'), 'allowed report');
  fs.writeFileSync(path.join(outside, 'secret.html'), 'outside content');
  fs.symlinkSync(outside, path.join(output, 'linked'), 'junction');
  const server = new TraceServer();
  t.after(() => server.stop());
  const url = await server.outputUrl(output, 'report.html');
  const denied = await fetch(new URL('linked/secret.html', url));
  assert.strictEqual(denied.status, 403);
  assert.ok(!(await denied.text()).includes('outside content'));
  const valid = await fetch(url);
  assert.strictEqual(valid.status, 200);
  assert.strictEqual(await valid.text(), 'allowed report');
});

test('trace requests cannot follow a directory link outside an allowed trace folder', async (t) => {
  const base = tempDir('trace-link');
  const output = path.join(base, 'results');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(output);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(output, 'allowed.zip'), 'PK allowed');
  fs.writeFileSync(path.join(outside, 'secret.zip'), 'outside trace');
  fs.symlinkSync(outside, path.join(output, 'linked'), 'junction');
  const server = new TraceServer();
  t.after(() => server.stop());
  server.allow([output]);
  const denied = await fetch(new URL('/trace/file?path=' + encodeURIComponent(path.join(output, 'linked/secret.zip')),
    await server.urlFor(path.join(output, 'allowed.zip'))));
  assert.strictEqual(denied.status, 403);
  assert.ok(!(await denied.text()).includes('outside trace'));
  const viewerUrl = await server.urlFor(path.join(output, 'allowed.zip'));
  const valid = await fetch(new URL('/trace/file?path=' + encodeURIComponent(path.join(output, 'allowed.zip')), viewerUrl));
  assert.strictEqual(valid.status, 200);
  assert.strictEqual(await valid.text(), 'PK allowed');
});

test('malformed request paths return 400 without escaping the request handler', () => {
  const server = new TraceServer();
  server.allow([os.tmpdir()]);
  server._outputDir = os.tmpdir();
  for (const url of ['/trace/%', '/trace/%E0%A4%A', '/output/%ZZ', '/output/%00', '/trace/file?path=%00', 'http://[']) {
    let status;
    const response = { writeHead: (value) => { status = value; }, end() {} };
    assert.doesNotThrow(() => server._handle({ method: 'GET', url }, response), url);
    assert.strictEqual(status, 400, url);
  }
});

test('the HTTP server keeps serving reports after malformed requests', async (t) => {
  const root = tempDir('trace-bad-url');
  fs.writeFileSync(path.join(root, 'log 100%.html'), '<html>still available</html>');
  const server = new TraceServer();
  t.after(() => server.stop());
  const url = await server.outputUrl(root, 'log 100%.html');
  for (const pathname of ['/trace/%', '/trace/%E0%A4%A', '/output/%ZZ', '/output/%00', '/trace/file?path=%00']) {
    const response = await fetch(new URL(pathname, url));
    assert.strictEqual(response.status, 400, pathname);
    await response.text();
  }
  const report = await fetch(url);
  assert.strictEqual(report.status, 200);
  assert.strictEqual(await report.text(), '<html>still available</html>');
});

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
    const html = await index.text();
    assert.match(html, /<div id="root">|id=root/);
    assert.match(html, /::-webkit-scrollbar-thumb[^<]*<\/style>\s*<\/head>/);
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
