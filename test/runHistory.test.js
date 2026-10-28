'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RunHistory, FILE_NAME, MAX_RUNS } = require('../src/main/runHistory');
const { compareRuns, counts, trend } = require('../src/renderer/runDiff');
const { tempDir } = require('./helpers/tempDir');

const run = (tests) => ({ tests: Object.fromEntries(Object.entries(tests).map(([id, [status, elapsed]]) => [id, { status, elapsed }])) });

test('compares a run with the previous one', () => {
  const previous = run({ a: ['PASS', 1], b: ['FAIL', 1], c: ['FAIL', 1], d: ['PASS', 1], e: ['PASS', 0.1] });
  const current = run({ a: ['FAIL', 1], b: ['PASS', 1], c: ['FAIL', 1], d: ['PASS', 2], e: ['PASS', 0.3], f: ['FAIL', 1], g: ['PASS', 1] });
  assert.deepStrictEqual(compareRuns(current, previous), {
    newFailures: ['a', 'f'],
    fixed: ['b'],
    stillFailing: ['c'],
    added: ['f', 'g'],
    slower: [{ id: 'd', before: 1, after: 2 }], // e: 3x slower but only +0.2 s
  });
  // A partial run (one test) reports nothing about the others.
  assert.deepStrictEqual(compareRuns(run({ c: ['PASS', 1] }), previous), { newFailures: [], fixed: ['c'], stillFailing: [], added: [], slower: [] });
  // The first run has nothing to compare with: its failures are just failing.
  assert.deepStrictEqual(compareRuns(run({ a: ['FAIL', 1] }), null).stillFailing, ['a']);
  assert.deepStrictEqual(counts(current), { PASS: 4, FAIL: 3, SKIP: 0, total: 7 });
  assert.deepStrictEqual(trend([current, previous], 'a'), ['PASS', 'FAIL']);
});

test('records runs in the results folder', () => {
  const dir = tempDir('history');
  const history = new RunHistory();
  history.start(dir, { select: [], include: ['smoke'] });
  history.record({ type: 'test-end', id: 'S.A', status: 'PASS', elapsed: 0.5, message: '' });
  history.record({ type: 'test-end', id: 'S.B', status: 'PASS', elapsed: 1 });
  history.record({ type: 'test-end', id: 'S.B', status: 'FAIL', elapsed: 1, message: 'Parent suite teardown failed:\nx'.repeat(50) });
  history.record({ type: 'step-end', id: 'k1', status: 'FAIL' });
  const saved = history.finish({ exitCode: 1, stopped: false });
  assert.strictEqual(saved.tests['S.B'].status, 'FAIL');
  assert.ok(saved.tests['S.B'].message.length < 320);
  assert.deepStrictEqual(saved.options.include, ['smoke']);
  assert.ok(fs.existsSync(path.join(dir, FILE_NAME)));

  // A run where no test ran is not kept; at most MAX_RUNS runs are.
  history.start(dir, {});
  assert.strictEqual(history.finish({ exitCode: 252 }), null);
  for (let i = 0; i < MAX_RUNS + 5; i++) {
    history.start(dir, {});
    history.record({ type: 'test-end', id: 'S.A', status: 'PASS', elapsed: i });
    history.finish({ exitCode: 0 });
  }
  const runs = history.list(dir);
  assert.strictEqual(runs.length, MAX_RUNS);
  assert.strictEqual(runs[0].tests['S.A'].elapsed, MAX_RUNS + 4);
});
