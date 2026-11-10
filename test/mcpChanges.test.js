'use strict';

// File changes made through the MCP tools are listed and can be undone, but only
// while the disk is as the change left it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { createTools } = require('../src/main/mcp/tools');
const { ChangeLog } = require('../src/main/mcp/changes');
const { McpProtocol } = require('../src/main/mcp/protocol');
const { tempDir } = require('./helpers/tempDir');

function setup() {
  const root = tempDir('mcp-changes');
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'tests', 'login.robot'), 'original\r\n');
  const changes = new ChangeLog({ folder: path.join(tempDir('mcp-undo'), 'undo') });
  let dirty = [];
  const trash = async (entry) => fs.rmSync(entry, { recursive: true });
  const app = {
    project: () => ({ root, name: 'demo', python: null, config: { testsDir: 'tests', resourcesDir: 'resources', outputDir: 'results' } }),
    dirtyPaths: () => dirty,
    trash,
    runner: Object.assign(new EventEmitter(), { running: false }),
    browser: { open: false },
    browsers: {},
    changes,
  };
  const mcp = new McpProtocol({ name: 'k', version: '1', tools: createTools(app) });
  let id = 0;
  const call = async (name, args) => {
    const reply = await mcp.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
    assert.equal(reply.result.isError, undefined, reply.result.content[0].text);
  };
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  const exists = (file) => fs.existsSync(path.join(root, file));
  const undo = (change) => changes.undo(change.id, { dirtyPaths: dirty, trash });
  return { root, changes, call, read, exists, undo, setDirty: (paths) => { dirty = paths; } };
}

test('every kind of change is listed newest first and undone', async () => {
  const f = setup();
  await f.call('write_file', { path: 'tests/new.robot', content: 'new' });
  await f.call('edit_file', { path: 'tests/login.robot', old_text: 'original', new_text: 'edited' });
  fs.mkdirSync(path.join(f.root, 'tests', 'old'));
  fs.writeFileSync(path.join(f.root, 'tests', 'old', 'a.robot'), 'a');
  await f.call('delete_path', { path: 'tests/old' });
  await f.call('rename_path', { path: 'tests/new.robot', new_name: 'renamed.robot' });

  const list = f.changes.list(f.root);
  assert.deepEqual(list.map((c) => [c.kind, c.path, c.to, c.tool]), [
    ['rename', 'tests/new.robot', 'tests/renamed.robot', 'rename_path'],
    ['delete', 'tests/old', null, 'delete_path'],
    ['update', 'tests/login.robot', null, 'edit_file'],
    ['create', 'tests/new.robot', null, 'write_file'],
  ]);
  // The file was renamed since it was created: creating it can only be undone after the rename.
  assert.deepEqual(list.map((c) => c.undoable), [true, true, true, false]);

  for (const change of list.slice(0, 3))
    assert.deepEqual(await f.undo(change), { ok: true });
  assert.equal(f.read('tests/login.robot'), 'original\r\n');
  assert.equal(f.read('tests/old/a.robot'), 'a');
  assert.equal(f.read('tests/new.robot'), 'new');
  assert.equal(f.exists('tests/renamed.robot'), false);

  const created = f.changes.list(f.root).at(-1);
  assert.equal(created.undoable, true);
  assert.deepEqual(await f.undo(created), { ok: true });
  assert.equal(f.exists('tests/new.robot'), false);
  assert.ok(f.changes.list(f.root).every((c) => c.undone && !c.undoable));
  assert.equal((await f.undo(created)).ok, false);
});

test('an undo never overwrites later changes or unsaved editor files', async () => {
  const f = setup();
  await f.call('write_file', { path: 'tests/login.robot', content: 'by the AI' });
  const [change] = f.changes.list(f.root);

  f.setDirty(['tests/login.robot']);
  assert.match((await f.undo(change)).error, /unsaved changes/);
  f.setDirty([]);

  fs.writeFileSync(path.join(f.root, 'tests', 'login.robot'), 'by the user');
  const [changed] = f.changes.list(f.root);
  assert.equal(changed.undoable, false);
  assert.match(changed.reason, /has changed since/);
  assert.match((await f.undo(change)).error, /has changed since/);
  assert.equal(f.read('tests/login.robot'), 'by the user');

  // Back as the AI left it: the undo is possible again.
  fs.writeFileSync(path.join(f.root, 'tests', 'login.robot'), 'by the AI');
  assert.deepEqual(await f.undo(change), { ok: true });
  assert.equal(f.read('tests/login.robot'), 'original\r\n');
});

test('only the open project\'s changes are listed', async () => {
  const f = setup();
  await f.call('write_file', { path: 'tests/a.robot', content: 'a' });
  assert.equal(f.changes.list(f.root).length, 1);
  assert.equal(f.changes.list(tempDir('other')).length, 0);
});
