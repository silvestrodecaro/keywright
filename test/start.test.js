'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { tempDir } = require('./helpers/tempDir');

function fixture() {
  const root = tempDir('start with spaces');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  const dist = path.join(root, 'node_modules/electron/dist');
  fs.mkdirSync(dist, { recursive: true });
  const executable = path.join(dist, process.platform === 'win32' ? 'electron.exe' : 'electron');
  fs.writeFileSync(executable, 'runtime placeholder; never executed by these tests');
  fs.writeFileSync(path.join(dist, 'version'), '45.2.1');
  const calls = [];
  const output = new PassThrough();
  output.resume();
  return { root, executable, calls, output };
}

function spawnFor(f, buildExit = 0, appSignal) {
  return (executable, args, options) => {
    f.calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    process.nextTick(() => {
      child.emit('spawn');
      if (buildExit) child.stderr.write('Renderer compilation failed');
      child.emit('close', f.calls.length === 1 ? buildExit : appSignal ? null : 0, f.calls.length === 1 ? undefined : appSignal);
    });
    return child;
  };
}

test('start builds before launching and forwards a project path without shell interpretation', async () => {
  const f = fixture();
  const { start } = require('../scripts/start');
  const project = path.join(f.root, 'Robot projects', 'shop & checkout');
  await start({ root: f.root, args: [project], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    output: f.output, spawn: spawnFor(f) });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].executable, process.execPath);
  assert.ok(f.calls[0].args[0].endsWith(path.join('scripts', 'build.mjs')));
  assert.equal(f.calls[1].executable, f.executable);
  assert.deepEqual(f.calls[1].args, [f.root, project]);
  assert.equal(f.calls[1].options.cwd, f.root);
  assert.equal(f.calls[1].options.shell, false);
  assert.equal(f.calls[1].options.env.ELECTRON_RUN_AS_NODE, undefined);
});

test('a failed renderer build prevents Electron from being launched', async () => {
  const f = fixture();
  const { start } = require('../scripts/start');
  await assert.rejects(start({ root: f.root, output: f.output, spawn: spawnFor(f, 23) }), /Renderer compilation failed/);
  assert.equal(f.calls.length, 1);
});

test('a removed Electron executable stops start without launching or downloading anything', async () => {
  const f = fixture();
  fs.unlinkSync(f.executable);
  const { start } = require('../scripts/start');
  await assert.rejects(start({ root: f.root, output: f.output, spawn: spawnFor(f) }), /quarantin|blocked/i);
  assert.equal(f.calls.length, 0);
});

test('an interrupted desktop process is reported as cancellation', async () => {
  const f = fixture();
  const { start } = require('../scripts/start');
  await assert.rejects(start({ root: f.root, output: f.output, spawn: spawnFor(f, 0, 'SIGINT') }), { name: 'AbortError' });
});
