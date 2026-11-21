'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProjectWatcher } = require('../src/main/projectWatcher');
const { tempDir } = require('./helpers/tempDir');

function nextChanges(watcher, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no changes reported')), timeout);
    watcher.once('changes', (paths) => {
      clearTimeout(timer);
      resolve(paths);
    });
  });
}

test('accepts ignores tool folders, results and run output', () => {
  const watcher = new ProjectWatcher(os.tmpdir(), { ignore: ['results'] });
  assert.strictEqual(watcher.accepts('tests/login.robot'), true);
  assert.strictEqual(watcher.accepts('resources/common.resource'), true);
  assert.strictEqual(watcher.accepts('results/log.html'), false);
  assert.strictEqual(watcher.accepts('results'), false);
  assert.strictEqual(watcher.accepts('resultsx/a.robot'), true);
  assert.strictEqual(watcher.accepts('.venv/Lib/site.py'), false);
  assert.strictEqual(watcher.accepts('.git/index'), false);
  assert.strictEqual(watcher.accepts('lib/__pycache__/x.pyc'), false);
  assert.strictEqual(watcher.accepts('log.html'), false);
});

test('reports changed files once, debounced, with project-relative paths', async () => {
  const root = tempDir('watch');
  fs.mkdirSync(path.join(root, 'tests'));
  fs.mkdirSync(path.join(root, 'results'));
  const watcher = new ProjectWatcher(root, { ignore: ['results'], delay: 150 });
  watcher.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const changes = nextChanges(watcher);
    fs.writeFileSync(path.join(root, 'tests', 'a.robot'), '*** Test Cases ***\n');
    fs.appendFileSync(path.join(root, 'tests', 'a.robot'), 'T\n    Log    x\n');
    fs.writeFileSync(path.join(root, 'results', 'output.xml'), '<robot/>');
    fs.writeFileSync(path.join(root, 'common.resource'), '');
    assert.deepStrictEqual(await changes, ['common.resource', 'tests/a.robot']);

    // Only ignored files: nothing is reported.
    const quiet = nextChanges(watcher, 600);
    fs.writeFileSync(path.join(root, 'results', 'log.html'), '');
    await assert.rejects(quiet, /no changes/);
  } finally {
    watcher.stop();
  }
});

test('the ignored results folder matches however keywright.json spells it', () => {
  const root = tempDir('watch-ignore');
  for (const ignore of ['./results/', 'results\\', path.join(root, 'results')]) {
    const watcher = new ProjectWatcher(root, { ignore: [ignore] });
    assert.equal(watcher.accepts('results/browser/screenshot/a.png'), false, ignore);
    assert.equal(watcher.accepts('tests/results.robot'), true, ignore);
  }
  if (process.platform === 'win32')
    assert.equal(new ProjectWatcher(root, { ignore: ['Results'] }).accepts('results/a.png'), false);
});

test('changes arriving without pause are still reported after the longest wait', async () => {
  const root = tempDir('watch-maxwait');
  const watcher = new ProjectWatcher(root, { delay: 100, maxWait: 300 });
  const reported = [];
  watcher.on('changes', (paths) => reported.push(paths));
  const started = Date.now();
  while (Date.now() - started < 600) {
    watcher._record('tests/a.robot');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  watcher.stop();
  assert.ok(reported.length >= 1, 'nothing was reported while changes kept coming');
});
