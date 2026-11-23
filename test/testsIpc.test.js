'use strict';

// The Testing panel's part of the main process: runs, their events and history, and the
// URLs of reports and traces, over a fake runner.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createTestsIpc } = require('../src/main/ipc/tests');
const { tempDir } = require('./helpers/tempDir');

function setup({ fail = null } = {}) {
  const handlers = new Map();
  const sent = [];
  const root = tempDir('tests-ipc');
  const project = { root, python: 'python', config: { testsDir: 'tests', outputDir: 'results' } };
  const runner = Object.assign(new EventEmitter(), {
    running: false,
    runs: [],
    async run(_project, options) {
      this.runs.push(options);
      if (fail)
        throw new Error(fail);
      this.running = true;
    },
    stop() {},
    debugCommand: () => true,
  });
  const allowed = [];
  const traceServer = { allow: (dirs) => allowed.push(dirs), urlFor: async () => 'http://127.0.0.1:1/trace', outputUrl: async (_dir, file) => `http://127.0.0.1:1/output/${file}` };
  let current = project;
  const ipc = createTestsIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    send: (channel, payload) => sent.push([channel, payload]),
    runner,
    traceServer,
    project: () => current,
    refreshProject: () => null,
    discoverTests: async () => ({ ok: true, suite: { name: 'Tests' } }),
    openPath: async () => '',
    batchMs: 20,
  });
  const call = (channel, ...args) => handlers.get(channel)({}, ...args);
  return { ipc, call, sent, runner, root, allowed, close: () => { current = null; } };
}

const channels = (sent) => sent.map(([channel]) => channel);

test('a run passes the Run options to Robot and allows its results folder to be served', async () => {
  const f = setup();
  assert.deepEqual(await f.call('tests:run', { select: ['S.T'], headed: true, browser: 'firefox', include: ['smoke'] }), { ok: true });
  assert.deepEqual(f.runner.runs[0].variables, { HEADLESS: 'False', BROWSER: 'firefox' });
  assert.deepEqual(f.runner.runs[0].include, ['smoke']);
  assert.deepEqual(f.allowed[0], [path.join(f.root, 'results')]);
  assert.match((await f.call('tests:run', {})).error, /already running/);
});

test('without a project, or when Robot cannot start, nothing is recorded', async () => {
  const closed = setup();
  closed.close();
  assert.match((await closed.call('tests:run', {})).error, /No project is open/);

  const f = setup({ fail: 'no Python' });
  assert.deepEqual(await f.call('tests:run', {}), { ok: false, error: 'no Python' });
  f.runner.emit('event', { type: 'test-end', id: 'S.T', status: 'PASS' });
  f.runner.emit('finished', { exitCode: 0, stopped: false });
  assert.ok(!channels(f.sent).includes('tests:history-added'), 'a run that did not start is not saved');
});

test('events arrive in batches, debugger events at once, and everything before the end of the run', async () => {
  const f = setup();
  await f.call('tests:run', {});
  f.runner.emit('event', { type: 'test-start', id: 'S.T' });
  f.runner.emit('output', 'line 1\n');
  assert.deepEqual(channels(f.sent), []);
  f.runner.emit('event', { type: 'debug-paused', id: 'S.T' });
  assert.deepEqual(channels(f.sent), ['tests:output', 'tests:events']);
  f.runner.emit('event', { type: 'test-end', id: 'S.T', status: 'PASS' });
  f.runner.emit('finished', { exitCode: 0, stopped: false });
  assert.deepEqual(channels(f.sent), ['tests:output', 'tests:events', 'tests:events', 'tests:finished', 'tests:history-added']);
  assert.deepEqual((await f.call('tests:history')).map((run) => Object.keys(run.tests)), [['S.T']]);
});

test('only Robot\'s own report and log are served, once they exist', async () => {
  const f = setup();
  assert.match((await f.call('tests:output-url', 'secret.txt')).error, /No project/);
  assert.match((await f.call('tests:output-url', 'log.html')).error, /no log\.html yet/);
  fs.mkdirSync(path.join(f.root, 'results'));
  fs.writeFileSync(path.join(f.root, 'results', 'log.html'), '<html>');
  assert.deepEqual(await f.call('tests:output-url', 'log.html'), { ok: true, url: 'http://127.0.0.1:1/output/log.html' });
  assert.match((await f.call('tests:trace-url', path.join(f.root, 'missing.zip'))).error, /written when the browser context is closed/);
});
