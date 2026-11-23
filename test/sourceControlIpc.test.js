'use strict';

// The Source Control panel's channels: they act on the open project's repository only,
// allow a fixed list of Git actions, and keep unsaved editor files safe.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceControlIpc } = require('../src/main/ipc/sourceControl');

function setup({ dirty = [] } = {}) {
  const handlers = new Map();
  const calls = [];
  const source = {
    status: async () => ({ branch: 'main' }),
    stage: async (file) => calls.push(['stage', file]),
    switchBranch: async (name) => calls.push(['switchBranch', name]),
    branches: async () => ['main'],
    review: async () => ({ patch: 'diff', token: 't', revision: 'r', extra: 'not sent' }),
  };
  let project = { root: 'C:/work/demo' };
  createSourceControlIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    project: () => project,
    sourceControl: () => (project ? source : null),
    dirtyPaths: () => dirty,
  });
  const call = (channel, ...args) => handlers.get(channel)({}, ...args);
  return { call, calls, close: () => { project = null; } };
}

test('requests act on the open project only', async () => {
  const f = setup();
  assert.deepEqual(await f.call('source-control:status', 'C:/work/demo'), { ok: true, value: { branch: 'main' } });
  assert.match((await f.call('source-control:status', 'C:/work/other')).error, /no longer open/);
  f.close();
  assert.match((await f.call('source-control:stage', 'C:/work/demo', 'a.robot')).error, /no longer open/);
});

test('a review sends the patch, its token and revision, nothing else', async () => {
  const f = setup();
  assert.deepEqual((await f.call('source-control:diff', 'C:/work/demo', 'changes', 'a.robot')).value, { patch: 'diff', token: 't', revision: 'r' });
});

test('only listed Git actions run, with at most four arguments', async () => {
  const f = setup();
  assert.deepEqual(await f.call('source-control:action', 'C:/work/demo', 'branches', []), { ok: true, value: ['main'] });
  assert.match((await f.call('source-control:action', 'C:/work/demo', 'constructor', [])).error, /Unknown Git action/);
  assert.match((await f.call('source-control:action', 'C:/work/demo', 'branches', [1, 2, 3, 4, 5])).error, /Unknown Git action/);
  assert.match((await f.call('source-control:action', 'C:/work/demo', 'branches', 'x')).error, /Unknown Git action/);
});

test('actions that change files wait until the editor has no unsaved files', async () => {
  const f = setup({ dirty: ['tests/a.robot'] });
  assert.match((await f.call('source-control:action', 'C:/work/demo', 'switchBranch', ['dev'])).error, /Save or close unsaved editor files/);
  assert.deepEqual(f.calls, []);
  const clean = setup();
  assert.equal((await clean.call('source-control:action', 'C:/work/demo', 'switchBranch', ['dev'])).ok, true);
  assert.deepEqual(clean.calls, [['switchBranch', 'dev']]);
});
