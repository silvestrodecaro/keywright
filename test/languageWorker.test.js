'use strict';

// Needs the same Python as e2e.test.js (RFIDE_PYTHON or .venv); skipped otherwise.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { LanguageWorker } = require('../src/main/languageWorker');
const { tempDir } = require('./helpers/tempDir');

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

test('lints unsaved content with Robocop and the project configuration', { skip: !python && 'no Python with Robot Framework', timeout: 60_000 }, async () => {
  const os = require('os');
  const dir = tempDir('lint');
  fs.mkdirSync(path.join(dir, 'tests'));
  const worker = new LanguageWorker(python, dir);
  const lint = (text, file = 'tests/a.robot') => worker.request('lint', { path: path.join(dir, file), root: dir, text });
  try {
    const text = '*** Test Cases ***\nmy test\n    ${unused}=    Set Variable    1\n';
    const result = await lint(text);
    if (!result.available)
      return; // robotframework-robocop is not installed in this Python
    const rules = result.problems.map((p) => p.rule);
    assert.ok(rules.includes('VAR02') && rules.includes('NAME07'), rules.join());
    const unused = result.problems.find((p) => p.rule === 'VAR02');
    assert.deepStrictEqual([unused.line, unused.column, unused.endLine, unused.endColumn, unused.name], [3, 5, 3, 14, 'unused-variable']);

    // A disabler comment on the line (the quick fix) silences the rule there.
    const disabled = await lint(text.replace('Set Variable    1', 'Set Variable    1    # robocop: off=unused-variable'));
    assert.ok(!disabled.problems.some((p) => p.rule === 'VAR02'));

    // The project's configuration applies, and is reloaded when it changes.
    fs.writeFileSync(path.join(dir, 'robocop.toml'), '[tool.robocop.lint]\nignore = ["NAME07"]\n');
    const configured = await lint(text);
    assert.ok(!configured.problems.some((p) => p.rule === 'NAME07'));
  } finally {
    const child = worker._child;
    worker.dispose();
    if (child && child.exitCode === null) // its working folder is removed after the tests
      await new Promise((resolve) => child.once('exit', resolve));
  }
});
