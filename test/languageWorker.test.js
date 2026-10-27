'use strict';

// Needs the same Python as e2e.test.js (RFIDE_PYTHON or .venv); skipped otherwise.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { LanguageWorker } = require('../src/main/languageWorker');

const root = path.join(__dirname, '..');
const python = process.env.RFIDE_PYTHON || [
  path.join(root, '.venv', 'Scripts', 'python.exe'),
  path.join(root, '.venv', 'bin', 'python'),
].find((p) => fs.existsSync(p));

test('checks unsaved Robot content and survives a crash', { skip: !python && 'no Python with Robot Framework', timeout: 60_000 }, async () => {
  const worker = new LanguageWorker(python, root);
  try {
    const text = '*** Test Cases ***\nT\n    FOR    ${i}    IN RANGE    3\n        Log    ${i}\n';
    const { problems } = await worker.request('check', { path: 'tests/a.robot', text });
    assert.deepStrictEqual(problems, [{ line: 3, column: 5, endLine: 3, endColumn: 33, message: 'FOR loop must have closing END.', severity: 'error' }]);

    // Concurrent requests are matched to their answers.
    const [ok, resource] = await Promise.all([
      worker.request('check', { path: 'tests/ok.robot', text: '*** Test Cases ***\nT\n    Log    x\n' }),
      worker.request('check', { path: 'r.resource', text: '*** Test Cases ***\nT\n' }),
    ]);
    assert.deepStrictEqual(ok.problems, []);
    assert.match(resource.problems[0].message, /Resource file with 'Test Cases' section is invalid/);

    await assert.rejects(worker.request('unknown-command'), /unknown-command/);

    worker._child.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const again = await worker.request('check', { path: 'tests/ok.robot', text: '*** Test Cases ***\nT\n    Log    x\n' });
    assert.deepStrictEqual(again.problems, []);
  } finally {
    worker.dispose();
  }
});
