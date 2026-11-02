'use strict';

// Debugger: breakpoints, stepping and variables with the real Robot Framework.
// Needs the same Python as runner.test.js (RFIDE_PYTHON or .venv); skipped otherwise.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TestRunner } = require('../src/main/testRunner');
const { tempDir } = require('./helpers/tempDir');

const root = path.join(__dirname, '..');
const python = process.env.RFIDE_PYTHON || [
  path.join(root, '.venv', 'Scripts', 'python.exe'),
  path.join(root, '.venv', 'bin', 'python'),
].find((p) => fs.existsSync(p));

function project() {
  const dir = tempDir('debug');
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', 'helper.resource'), [
    '*** Keywords ***',
    'Helper',
    '    [Arguments]    ${arg}',
    '    ${local}=    Set Variable    L',
    '    Log    ${arg} ${local}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'tests', 'debug.robot'), [
    '*** Settings ***',
    'Resource    helper.resource',
    '',
    '*** Variables ***',
    '${SUITE VAR}    S',
    '',
    '*** Test Cases ***',
    'Debugged',
    '    ${t}=    Set Variable    T',
    '    Helper    x',
    '    Log    after',
    '    Log    last',
    '',
  ].join('\n'));
  return { root: dir, python, config: { testsDir: 'tests', outputDir: path.join(dir, 'results') } };
}

test('stops at breakpoints and steps into, over and out', { skip: !python && 'no Python with Robot Framework', timeout: 60_000 }, async () => {
  const runner = new TestRunner();
  const pauses = [];
  const commands = ['into', 'over', 'out', 'continue'];
  let resumed = 0;
  const finished = new Promise((resolve) => runner.on('finished', resolve));
  runner.on('event', (event) => {
    if (event.type === 'debug-paused') {
      pauses.push(event);
      runner.debugCommand({ command: commands[pauses.length - 1] || 'continue' });
    } else if (event.type === 'debug-resumed') {
      resumed++;
    }
  });
  await runner.run(project(), { debug: { breakpoints: { 'tests/debug.robot': [10] } } });
  const { exitCode } = await finished;
  assert.strictEqual(exitCode, 0);

  assert.deepStrictEqual(pauses.map((p) => [p.reason, p.source, p.lineno, p.name]), [
    ['breakpoint', 'tests/debug.robot', 10, 'Helper'],
    ['step', 'tests/helper.resource', 4, 'Set Variable'], // into
    ['step', 'tests/helper.resource', 5, 'Log'], // over
    ['step', 'tests/debug.robot', 11, 'Log'], // out of Helper
  ]);
  assert.strictEqual(resumed, 4);

  // Call stack inside the keyword: the paused step, then the call of Helper.
  assert.deepStrictEqual(pauses[2].frames.map((f) => [f.name, f.source, f.lineno]), [
    ['Log', 'tests/helper.resource', 5],
    ['Helper', 'tests/debug.robot', 10],
  ]);
  // Variables by scope; built-in variables are left out.
  const scopes = Object.fromEntries(pauses[2].variables.map((g) => [g.scope, Object.fromEntries(g.variables.map((v) => [v.name, v.value]))]));
  assert.deepStrictEqual(scopes.Local, { '${arg}': 'x', '${local}': 'L' });
  assert.strictEqual(scopes.Test['${t}'], 'T');
  assert.strictEqual(scopes.Suite['${SUITE VAR}'], 'S');
  assert.ok(!pauses[2].variables.some((g) => g.variables.some((v) => v.name === '${TEMPDIR}')));
});

test('breakpoints can change and pause is honoured while running', { skip: !python && 'no Python with Robot Framework', timeout: 60_000 }, async () => {
  const runner = new TestRunner();
  const pauses = [];
  const finished = new Promise((resolve) => runner.on('finished', resolve));
  runner.on('event', (event) => {
    if (event.type !== 'debug-paused')
      return;
    pauses.push(event);
    if (pauses.length === 1) // move the breakpoint to the last line, then continue
      runner.debugCommand({ command: 'breakpoints', breakpoints: { 'tests/debug.robot': [12] } });
    runner.debugCommand({ command: 'continue' });
  });
  await runner.run(project(), { debug: { breakpoints: { 'tests/debug.robot': [9] } } });
  await finished;
  assert.deepStrictEqual(pauses.map((p) => p.lineno), [9, 12]);
});

test('stops at unexpected failures and evaluates while paused', { skip: !python && 'no Python with Robot Framework', timeout: 60_000 }, async () => {
  const dir = tempDir('debug');
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', 'fail.robot'), [
    '*** Test Cases ***',
    'Fails',
    '    ${ok}=    Run Keyword And Return Status    Fail    expected',
    '    TRY',
    '        Fail    in try',
    '    EXCEPT',
    '        No Operation',
    '    END',
    '    Checker',
    '',
    '*** Keywords ***',
    'Checker',
    '    @{items}=    Create List    a    b',
    '    Should Be Equal    1    2',
    '',
  ].join('\n'));
  const runner = new TestRunner();
  const pauses = [];
  const evaluations = new Map();
  const stepNames = [];
  const finished = new Promise((resolve) => runner.on('finished', resolve));
  const expressions = {
    variable: ['${items}[1]'],
    python: ['len($items) + 1'],
    keyword: ['Catenate    a    b'],
    watchKeyword: ['Catenate    a    b', false],
    error: ['nope +'],
  };
  runner.on('event', (event) => {
    if (event.type === 'step-start')
      stepNames.push(event.name);
    if (event.type === 'debug-paused') {
      pauses.push(event);
      for (const [id, [expression, keywords]] of Object.entries(expressions))
        runner.debugCommand({ command: 'evaluate', id, expression, keywords });
      runner.debugCommand({ command: 'continue' });
    }
    if (event.type === 'debug-evaluated')
      evaluations.set(event.id, event.ok ? `${event.value} (${event.valueType})` : `error: ${event.error}`);
  });
  await runner.run({ root: dir, python, config: { testsDir: 'tests', outputDir: path.join(dir, 'results') } },
    { debug: { breakpoints: {}, pauseOnFailure: true } });
  await finished;

  assert.deepStrictEqual(pauses.map((p) => [p.reason, p.name, p.lineno, p.message]), [['failure', 'Should Be Equal', 14, '1 != 2']]);
  assert.deepStrictEqual(pauses[0].frames.map((f) => [f.name, f.lineno]), [['Should Be Equal', 14], ['Checker', 9]]);
  assert.strictEqual(evaluations.get('variable'), 'b (str)');
  assert.strictEqual(evaluations.get('python'), '3 (int)');
  assert.strictEqual(evaluations.get('keyword'), 'a b (str)');
  assert.match(evaluations.get('watchKeyword'), /^error: Watches do not run keywords/);
  assert.match(evaluations.get('error'), /^error: /);
  assert.ok(!stepNames.includes('Catenate'), 'keywords run by evaluations are not reported as steps');
});

test('conditional breakpoints stop only when the condition holds', { skip: !python && 'no Python with Robot Framework', timeout: 60_000 }, async () => {
  const dir = tempDir('debug');
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', 'loop.robot'), [
    '*** Test Cases ***',
    'Loop',
    '    FOR    ${i}    IN RANGE    5',
    '        Log    ${i}',
    '    END',
    '    Log    after',
    '',
  ].join('\n'));
  const runner = new TestRunner();
  const pauses = [];
  const finished = new Promise((resolve) => runner.on('finished', resolve));
  runner.on('event', (event) => {
    if (event.type !== 'debug-paused')
      return;
    const local = event.variables.flatMap((g) => g.variables).find((v) => v.name === '${i}');
    pauses.push([event.lineno, local ? local.value : null, event.message || null]);
    runner.debugCommand({ command: 'continue' });
  });
  await runner.run({ root: dir, python, config: { testsDir: 'tests', outputDir: path.join(dir, 'results') } }, { debug: {
    breakpoints: { 'tests/loop.robot': [{ line: 4, condition: '$i == 3' }, { line: 6, condition: '$nope > 1' }] },
  } });
  await finished;
  assert.deepStrictEqual(pauses.slice(0, 1), [[4, '3', null]]);
  // A condition that fails to evaluate stops, with the error.
  assert.strictEqual(pauses.length, 2);
  assert.strictEqual(pauses[1][0], 6);
  assert.match(pauses[1][2], /Breakpoint condition '\$nope > 1' failed/);
});
