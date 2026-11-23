'use strict';

// An interpreter that keywright.json sets outside the project folder is used only after
// the user confirms it, once per project.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { InterpreterTrust } = require('../src/main/interpreterTrust');
const { tempDir } = require('./helpers/tempDir');

function setup({ env = {} } = {}) {
  const profile = tempDir('trust-profile');
  const root = tempDir('trust-project');
  const python = path.join(tempDir('trust-python'), 'python.exe');
  fs.writeFileSync(python, '');
  const project = { root, python, config: { python } };
  const asked = [];
  let answer = true;
  const make = () => new InterpreterTrust({
    file: path.join(profile, 'trusted-interpreters.json'),
    env,
    ask: async (external) => { asked.push(external); return answer; },
  });
  return { project, python, asked, make, answer: (value) => { answer = value; } };
}

test('a project with its own interpreter is never asked about', async () => {
  const f = setup();
  const own = { ...f.project, config: {} }; // the .venv in the project
  assert.equal(await f.make().confirm(own), own);
  assert.equal(f.make().apply(own), own);
  assert.deepEqual(f.asked, []);
});

test('an external interpreter is used once confirmed, and remembered for the project', async () => {
  const f = setup();
  const trust = f.make();
  assert.equal(trust.apply(f.project).python, null, 'not used before it is confirmed');
  assert.equal((await trust.confirm(f.project)).python, f.python);
  assert.deepEqual(f.asked, [f.python]);
  // A new session reads the choice back.
  assert.equal(f.make().apply(f.project).python, f.python);
  assert.equal((await f.make().confirm(f.project)).python, f.python);
  assert.equal(f.asked.length, 1);
});

test('a declined interpreter is not used and is asked about again next time', async () => {
  const f = setup();
  f.answer(false);
  assert.equal((await f.make().confirm(f.project)).python, null);
  assert.equal(f.make().apply(f.project).python, null);
  await f.make().confirm(f.project);
  assert.equal(f.asked.length, 2);
});

test('an interpreter chosen in Project Settings counts as confirmed', async () => {
  const f = setup();
  f.make().trust(f.project.root, f.python);
  assert.equal((await f.make().confirm(f.project)).python, f.python);
  assert.deepEqual(f.asked, []);
});

test('the interpreter named in KEYWRIGHT_TRUSTED_PYTHON is trusted without asking', async () => {
  const f = setup();
  const trust = new InterpreterTrust({ file: path.join(tempDir('trust-env'), 'trusted.json'), env: { KEYWRIGHT_TRUSTED_PYTHON: f.python }, ask: async () => { throw new Error('asked'); } });
  assert.equal((await trust.confirm(f.project)).python, f.python);
});

test('a confirmation belongs to the project folder however its path is capitalized on Windows', { skip: process.platform !== 'win32' && 'Windows paths' }, async () => {
  const f = setup();
  f.make().trust(f.project.root.toUpperCase(), f.python);
  assert.equal(f.make().apply(f.project).python, f.python);
});
