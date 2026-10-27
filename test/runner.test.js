'use strict';

// Runs the fixture project with the real Robot Framework. Needs the same Python
// as e2e.test.js (RFIDE_PYTHON or .venv in the project root); skipped otherwise.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { discoverTests, TestRunner, screenshotsFromHtml } = require('../src/main/testRunner');

const root = path.join(__dirname, '..');
const python = process.env.RFIDE_PYTHON || [
  path.join(root, '.venv', 'Scripts', 'python.exe'),
  path.join(root, '.venv', 'bin', 'python'),
].find((p) => fs.existsSync(p));
const skip = !python && 'no Python with Robot Framework';

function fixtureProject() {
  return {
    root: path.join(__dirname, 'fixtures', 'runner-project'),
    python,
    config: { testsDir: 'tests', outputDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rfide-run-')) },
  };
}

function runAndCollect(project, options, onEvent = () => {}) {
  const runner = new TestRunner();
  const events = [];
  let output = '';
  return new Promise((resolve, reject) => {
    runner.on('event', (event) => {
      events.push(event);
      onEvent(event, runner);
    });
    runner.on('output', (text) => { output += text; });
    runner.on('finished', (result) => resolve({ ...result, events, output }));
    runner.run(project, options).catch(reject);
  });
}

const testEnds = (events) => Object.fromEntries(events.filter((e) => e.type === 'test-end').map((e) => [e.id, e.status]));

test('discoverTests returns suites and tests by full name', { skip }, async () => {
  const result = await discoverTests(fixtureProject());
  assert.ok(result.ok, result.error);
  const suite = result.suite;
  assert.strictEqual(suite.id, 'Tests');
  assert.deepStrictEqual(suite.suites.map((s) => s.id), ['Tests.Basic', 'Tests.Nested']);
  const basic = suite.suites[0];
  assert.strictEqual(basic.source, 'tests/basic.robot');
  assert.deepStrictEqual(basic.tests.map((t) => [t.name, t.lineno]), [
    ['Passing Test', 2],
    ['Failing Test', 7],
    ['Test With Control Structures', 10],
    ['Name With [Brackets], Commas * And ? Wildcards', 17],
  ]);
  assert.deepStrictEqual(basic.tests[0].tags, ['smoke']);
});

test('discoverTests reports a missing virtual environment', async () => {
  const result = await discoverTests({ ...fixtureProject(), python: null });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /virtual environment/);
});

test('runs selected tests and streams steps and logs', { skip, timeout: 60_000 }, async () => {
  const project = fixtureProject();
  const result = await runAndCollect(project, {
    select: ['Tests.Basic.Passing Test', 'Tests.Basic.Failing Test', 'Tests.Basic.Test With Control Structures',
      'Tests.Basic.Name With [Brackets], Commas * And ? Wildcards'],
  });
  assert.strictEqual(result.exitCode, 1); // one failing test
  assert.deepStrictEqual(testEnds(result.events), {
    'Tests.Basic.Passing Test': 'PASS',
    'Tests.Basic.Failing Test': 'FAIL',
    'Tests.Basic.Test With Control Structures': 'PASS',
    'Tests.Basic.Name With [Brackets], Commas * And ? Wildcards': 'PASS',
  });
  assert.ok(fs.existsSync(path.join(project.config.outputDir, 'log.html')));

  const failing = result.events.find((e) => e.type === 'test-end' && e.status === 'FAIL');
  assert.strictEqual(failing.message, 'values differ: 1 != 2');

  // Nested steps of "Passing Test": the user keyword contains Evaluate.
  const steps = result.events.filter((e) => e.type === 'step-start' && e.test === 'Tests.Basic.Passing Test');
  const userKeyword = steps.find((s) => s.name === 'Add Numbers');
  assert.deepStrictEqual(userKeyword.args, ['1', '2']);
  const evaluate = steps.find((s) => s.name === 'Evaluate');
  assert.strictEqual(evaluate.parent, userKeyword.id);
  assert.deepStrictEqual(evaluate.assign, ['${sum}']);
  const log = result.events.find((e) => e.type === 'log' && e.text === 'hello from passing test');
  assert.ok(log && steps.some((s) => s.id === log.step && s.name === 'Log'));

  const control = result.events.filter((e) => e.type === 'step-start' && e.test === 'Tests.Basic.Test With Control Structures');
  assert.ok(control.some((s) => s.kind === 'for' && s.name.startsWith('FOR    ${i}    IN RANGE')));
  assert.ok(control.some((s) => s.kind === 'if' && s.name === 'IF    ${i} == 1'));
});

test('selecting a suite runs all of its tests only', { skip, timeout: 60_000 }, async () => {
  const result = await runAndCollect(fixtureProject(), { select: ['Tests.Nested'] }, (event, runner) => {
    if (event.type === 'test-start' && event.id === 'Tests.Nested.Slow.Slow Test')
      runner.stop();
  });
  assert.strictEqual(result.stopped, true);
  assert.deepStrictEqual(testEnds(result.events), { 'Tests.Nested.Slow.Quick Nested Test': 'PASS' });
  assert.ok(result.events.some((e) => e.type === 'test-start' && e.id === 'Tests.Nested.Slow.Slow Test'));
});

test('screenshotsFromHtml resolves Browser library screenshots', () => {
  const html = '</td></tr><tr><td colspan="3"><a href="browser/screenshot/fail-1.png"><img src="browser/screenshot/fail-1.png" width="800px"></a>';
  assert.deepStrictEqual(screenshotsFromHtml(html, path.resolve('/out')), [path.resolve('/out/browser/screenshot/fail-1.png')]);
  assert.deepStrictEqual(screenshotsFromHtml('<img src="data:image/png;base64,AAA">', '/out'), []);
});
