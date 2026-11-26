'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { describeActivity } = require('../src/renderer/statusBar');

test('the status bar is idle when nothing records or runs', () => {
  assert.deepStrictEqual(describeActivity({}), { text: 'Idle', kind: 'idle' });
  assert.deepStrictEqual(describeActivity({ recorder: {}, tests: { running: false } }), { text: 'Idle', kind: 'idle' });
});

test('a test run is shown while it runs and while the debugger is paused', () => {
  assert.deepStrictEqual(describeActivity({ tests: { running: true } }), { text: 'Running tests…', kind: 'running' });
  assert.deepStrictEqual(describeActivity({ tests: { running: true, paused: { reason: 'breakpoint' } } }),
    { text: 'Paused at breakpoint', kind: 'paused' });
  assert.deepStrictEqual(describeActivity({ tests: { running: true, paused: { reason: 'failure' } } }),
    { text: 'Paused on failure', kind: 'paused' });
  assert.deepStrictEqual(describeActivity({ tests: { running: true, paused: { reason: 'step' } } }),
    { text: 'Paused', kind: 'paused' });
});

test('the recorder is shown while it launches and records', () => {
  assert.deepStrictEqual(describeActivity({ recorder: { busy: true } }), { text: 'Launching browser…', kind: 'running' });
  assert.deepStrictEqual(describeActivity({ recorder: { recording: true } }), { text: 'Recording', kind: 'recording' });
});

test('a paused run takes precedence over recording, and recording over a running test', () => {
  const recording = { recording: true };
  assert.strictEqual(describeActivity({ recorder: recording, tests: { running: true } }).kind, 'recording');
  assert.strictEqual(describeActivity({ recorder: recording, tests: { running: true, paused: { reason: 'breakpoint' } } }).kind, 'paused');
});
