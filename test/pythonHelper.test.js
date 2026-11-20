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
