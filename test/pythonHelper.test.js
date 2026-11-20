'use strict';

// Needs the same Python as e2e.test.js (KEYWRIGHT_PYTHON or .venv in the project root).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runHelper } = require('../src/main/pythonHelper');
const { tempDir } = require('./helpers/tempDir');

const root = path.join(__dirname, '..');
const python = process.env.KEYWRIGHT_PYTHON || [
  path.join(root, '.venv', 'Scripts', 'python.exe'),
  path.join(root, '.venv', 'bin', 'python'),
].find((p) => fs.existsSync(p));
const skip = !python && 'no Python with Robot Framework';

test('runHelper gives up on a library that never finishes importing', { skip, timeout: 30_000 }, async () => {
  const dir = tempDir('slow-library');
  const library = path.join(dir, 'Slow.py');
  fs.writeFileSync(library, 'import time\ntime.sleep(60)\n');
  const started = Date.now();
  const result = await runHelper(python, ['libdoc', library], { cwd: dir, timeoutMs: 2000 });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /did not finish within 2 seconds/);
  assert.ok(Date.now() - started < 15_000, 'the helper was not stopped');
});

test('runHelper reads the result even when a library prints when Python exits', { skip, timeout: 60_000 }, async () => {
  const dir = tempDir('exit-print');
  const library = path.join(dir, 'Noisy.py');
  fs.writeFileSync(library, [
    'import atexit',
    'atexit.register(lambda: print("goodbye from the library"))',
    'def say_hello():',
    '    pass',
    '',
  ].join('\n'));
  const result = await runHelper(python, ['libdoc', library], { cwd: dir });
  assert.strictEqual(result.ok, true, result.error);
  assert.deepStrictEqual(result.libraries[0].keywords.map((keyword) => keyword.name), ['Say Hello']);
});

test('libdoc reports a library failing without a message and still documents the others', { skip, timeout: 60_000 }, async () => {
  const dir = tempDir('silent-failure');
  const library = path.join(dir, 'Silent.py');
  fs.writeFileSync(library, 'raise RuntimeError()\n');
  const result = await runHelper(python, ['libdoc', 'Collections', library], { cwd: dir });
  assert.strictEqual(result.ok, true, result.error);
  assert.deepStrictEqual(result.libraries.map((item) => item.import), ['Collections']);
  assert.strictEqual(result.errors[0].import, library);
  assert.match(result.errors[0].error, /RuntimeError/);
});

test('libdoc finds a library by name in the project folder, as the Robot run does', { skip, timeout: 60_000 }, async () => {
  const dir = tempDir('root-library');
  fs.writeFileSync(path.join(dir, 'RootLibrary.py'), 'def root_keyword():\n    pass\n');
  const result = await runHelper(python, ['libdoc', 'RootLibrary'], { cwd: dir });
  assert.strictEqual(result.ok, true, result.error);
  assert.deepStrictEqual(result.errors, []);
  assert.deepStrictEqual(result.libraries[0].keywords.map((keyword) => keyword.name), ['Root Keyword']);
});
