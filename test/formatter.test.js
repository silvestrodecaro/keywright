'use strict';

// Format Document with Robocop. Needs a Python with robotframework-robocop
// (RFIDE_PYTHON or .venv); skipped otherwise.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { formatRobot } = require('../src/main/formatter');

const root = path.join(__dirname, '..');
const python = process.env.RFIDE_PYTHON || [
  path.join(root, '.venv', 'Scripts', 'python.exe'),
  path.join(root, '.venv', 'bin', 'python'),
].find((p) => fs.existsSync(p));
const hasRobocop = python && spawnSync(python, ['-c', 'import robocop']).status === 0;
const skip = !hasRobocop && 'no Python with robotframework-robocop';

function project(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfide-format-test-'));
  for (const [name, content] of Object.entries(files))
    fs.writeFileSync(path.join(dir, name), content);
  return { root: dir, python };
}

test('formats content and keeps its line endings', { skip, timeout: 60_000 }, async () => {
  const source = '*** Settings ***\nLibrary  Browser\n*** Test Cases ***\nT\n  Log  hi\n';
  const result = await formatRobot(project(), 'tests/t.robot', source);
  assert.ok(result.ok, result.error);
  assert.strictEqual(result.formatted, '*** Settings ***\nLibrary    Browser\n\n\n*** Test Cases ***\nT\n    Log    hi\n');
  const crlf = await formatRobot(project(), 'r.resource', '*** Keywords ***\r\nK\r\n  No Operation\r\n');
  assert.strictEqual(crlf.formatted, '*** Keywords ***\r\nK\r\n    No Operation\r\n');
});

test('uses the project configuration', { skip, timeout: 60_000 }, async () => {
  const configured = project({ 'robocop.toml': '[tool.robocop.format]\nspace_count = 2\n' });
  const result = await formatRobot(configured, 't.robot', '*** Test Cases ***\nT\n    Log    hi\n');
  assert.ok(result.ok, result.error);
  assert.strictEqual(result.formatted, '*** Test Cases ***\nT\n  Log  hi\n');
});
