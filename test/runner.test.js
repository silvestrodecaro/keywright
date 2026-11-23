'use strict';


// Runs the fixture project with the real Robot Framework. Needs the same Python
// as e2e.test.js (KEYWRIGHT_PYTHON or .venv in the project root); skipped otherwise.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { discoverTests, TestRunner, screenshotsFromHtml } = require('../src/main/testRunner');
const { tempDir } = require('./helpers/tempDir');

const root = path.join(__dirname, '..');
const python = process.env.KEYWRIGHT_PYTHON || [
  path.join(root, '.venv', 'Scripts', 'python.exe'),
  path.join(root, '.venv', 'bin', 'python'),
].find((p) => fs.existsSync(p));
const skip = !python && 'no Python with Robot Framework';

function fixtureProject() {
  return {
    root: path.join(__dirname, 'fixtures', 'runner-project'),
    python,
    config: { testsDir: 'tests', outputDir: tempDir('run') },
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

/** A project whose root suite is renamed or whose tests need options to be read. */
function optionsProject() {
  const folder = tempDir('discovery options');
  fs.mkdirSync(path.join(folder, 'tests'));
  fs.writeFileSync(path.join(folder, 'tests', 'plain.robot'), '*** Test Cases ***\nOne\n    No Operation\nTwo\n    No Operation\n');
  fs.writeFileSync(path.join(folder, 'tests', 'other.suite'), '*** Test Cases ***\nThree\n    No Operation\n');
  return { root: folder, python, config: { testsDir: 'tests', outputDir: path.join(folder, 'results') } };
}

test('discovery and selected runs agree on the names given by additional arguments', { skip, timeout: 60_000 }, async () => {
  const project = optionsProject();
  const extraArgs = '--name "My Suite" --settag nightly';
  const { ok, error, suite } = await discoverTests(project, { extraArgs });
  assert.ok(ok, error);
  assert.deepStrictEqual(suite.suites[0].tests.map((t) => [t.id, t.tags]), [['My Suite.Plain.One', ['nightly']], ['My Suite.Plain.Two', ['nightly']]]);
  const run = await runAndCollect(project, { select: ['My Suite.Plain.Two'], extraArgs });
  assert.deepStrictEqual(testEnds(run.events), { 'My Suite.Plain.Two': 'PASS' }, run.output);
});

test('discovery reads the files that additional arguments add, also from an argument file', { skip }, async () => {
  const project = optionsProject();
  const sources = async (extraArgs) => {
    const result = await discoverTests(project, { extraArgs });
    assert.ok(result.ok, result.error);
    return result.suite.suites.map((s) => s.source).sort();
  };
  assert.deepStrictEqual(await sources(''), ['tests/plain.robot']);
  assert.deepStrictEqual(await sources('--extension robot:suite'), ['tests/other.suite', 'tests/plain.robot']);
  fs.writeFileSync(path.join(project.root, 'args.txt'), '--extension suite\n');
  assert.deepStrictEqual(await sources('--argumentfile args.txt'), ['tests/other.suite']);
});

test('discovery reports additional arguments that Robot refuses', { skip }, async () => {
  const result = await discoverTests(optionsProject(), { extraArgs: '--nosuchoption' });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /nosuchoption/);
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

test('streams suite setup and teardown steps and teardown failures', { skip, timeout: 60_000 }, async () => {
  const dir = tempDir('suite');
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', 'setup_fails.robot'),
    '*** Settings ***\nSuite Setup    Fail    setup broke\n\n*** Test Cases ***\nA\n    Log    a\n');
  fs.writeFileSync(path.join(dir, 'tests', 'teardown_fails.robot'),
    '*** Settings ***\nSuite Setup    Log    hello\nSuite Teardown    Fail    teardown broke\n\n*** Test Cases ***\nB\n    Log    b\n');
  const project = { root: dir, python, config: { testsDir: 'tests', outputDir: path.join(dir, 'results') } };
  const { events } = await runAndCollect(project, {});

  const suiteSteps = events.filter((e) => e.type === 'step-start' && !e.test).map((e) => [e.suite, e.kind, e.name]);
  assert.deepStrictEqual(suiteSteps, [
    ['Tests.Setup Fails', 'setup', 'Fail'],
    ['Tests.Teardown Fails', 'setup', 'Log'],
    ['Tests.Teardown Fails', 'teardown', 'Fail'],
  ]);
  assert.ok(events.some((e) => e.type === 'log' && !e.test && e.suite === 'Tests.Teardown Fails' && e.text === 'hello'));
  const ends = events.filter((e) => e.type === 'test-end').map((e) => [e.id, e.status, e.message]);
  assert.deepStrictEqual(ends, [
    ['Tests.Setup Fails.A', 'FAIL', 'Parent suite setup failed:\nsetup broke'],
    ['Tests.Teardown Fails.B', 'PASS', ''],
    // Sent again at the end of the suite: the failing teardown fails the test.
    ['Tests.Teardown Fails.B', 'FAIL', 'Parent suite teardown failed:\nteardown broke'],
  ]);
});

test('tag filters, dry run and extra arguments', { skip, timeout: 60_000 }, async () => {
  const included = await runAndCollect(fixtureProject(), { include: ['smoke'], extraArgs: '--loglevel DEBUG' });
  assert.deepStrictEqual(testEnds(included.events), { 'Tests.Basic.Passing Test': 'PASS' });
  assert.match(included.output, /--include smoke --loglevel DEBUG/);

  const excluded = await runAndCollect(fixtureProject(), { select: ['Tests.Basic'], exclude: ['smoke'] });
  assert.ok(!('Tests.Basic.Passing Test' in testEnds(excluded.events)));
  assert.ok('Tests.Basic.Failing Test' in testEnds(excluded.events));

  // Dry run: keywords are checked, not run, so `Fail` passes.
  const dry = await runAndCollect(fixtureProject(), { select: ['Tests.Basic.Failing Test'], dryrun: true });
  assert.deepStrictEqual(testEnds(dry.events), { 'Tests.Basic.Failing Test': 'PASS' });
});

test('a second run while the first is starting is refused', { skip, timeout: 60_000 }, async () => {
  const runner = new TestRunner();
  const finished = new Promise((resolve) => runner.once('finished', resolve));
  const project = fixtureProject();
  const first = runner.run(project, { select: ['Tests.Basic.Passing Test'] });
  await assert.rejects(runner.run(project, { select: ['Tests.Basic.Passing Test'] }), /already running/);
  await first;
  await finished;
  assert.strictEqual(runner.running, false);
});

test('stop resolves once Robot has exited', { skip, timeout: 60_000 }, async () => {
  const runner = new TestRunner();
  const started = new Promise((resolve) => runner.once('event', resolve));
  await runner.run(fixtureProject(), { select: ['Tests.Basic.Passing Test'] });
  await started;
  await runner.stop();
  assert.strictEqual(runner.running, false);
});

test('a run that fails to start closes its listener and can be retried', { skip }, async () => {
  const runner = new TestRunner();
  const project = { ...fixtureProject(), root: path.join(tempDir('missing'), 'gone') };
  await assert.rejects(runner.run(project, {}));
  assert.strictEqual(runner.running, false);
  assert.strictEqual(runner._server, null, 'the listener socket stays open');
  await assert.rejects(runner.run(project, {}), (error) => !/already running/.test(error.message));
});

test('only the run\'s own listener is heard on the event port', { skip, timeout: 60_000 }, async () => {
  const net = require('net');
  const runner = new TestRunner();
  const events = [];
  runner.on('event', (event) => events.push(event));
  const finished = new Promise((resolve) => runner.once('finished', resolve));
  const listening = runner._listen.bind(runner);
  let intruder;
  // Another local process connects to the port before Robot does and sends an event.
  runner._listen = async () => {
    const port = await listening();
    intruder = net.connect(port, '127.0.0.1', () => intruder.write(`${JSON.stringify({ type: 'test-end', id: 'Forged', status: 'PASS' })}\n`));
    intruder.on('error', () => {});
    await new Promise((resolve) => intruder.once('connect', resolve));
    await new Promise((resolve) => setTimeout(resolve, 100));
    return port;
  };
  await runner.run(fixtureProject(), { select: ['Tests.Basic.Passing Test'] });
  await finished;
  intruder.destroy();
  assert.ok(!events.some((event) => event.id === 'Forged'), 'an event from another process was accepted');
  assert.deepStrictEqual(testEnds(events), { 'Tests.Basic.Passing Test': 'PASS' });
});

test('a run ends when Robot exits, even if a process it started keeps its output open', { skip, timeout: 60_000 }, async () => {
  const dir = tempDir('grandchild');
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', 'leak.robot'), [
    '*** Test Cases ***',
    'Leaves A Process',
    "    ${pid}=    Evaluate    __import__('subprocess').Popen([__import__('sys').executable, '-c', 'import time; time.sleep(20)']).pid",
    '    Log To Console    GRANDCHILD=${pid}',
    '',
  ].join('\n'));
  const runner = new TestRunner();
  let output = '';
  runner.on('output', (text) => { output += text; });
  const finished = new Promise((resolve) => runner.once('finished', resolve));
  const started = Date.now();
  await runner.run({ root: dir, python, config: { testsDir: 'tests', outputDir: path.join(dir, 'results') } }, {});
  const result = await finished;
  const pid = Number(/GRANDCHILD=(\d+)/.exec(output)?.[1]);
  if (pid)
    try { process.kill(pid); } catch { /* already gone */ }
  assert.strictEqual(result.exitCode, 0);
  assert.ok(Date.now() - started < 15_000, `the run ended only after ${Date.now() - started} ms`);
  assert.strictEqual(runner.running, false);
});
