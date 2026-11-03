'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./helpers/tempDir');
const projects = require('../src/main/projects');
const { WorkspaceFiles } = require('../src/renderer/workspaceFiles');

function fixture() {
  const root = tempDir('workspace-save');
  const tabs = new Map();
  const models = new Map();
  const editor = {
    has: (name) => models.has(name),
    snapshot: (name) => ({ content: models.get(name).content, version: models.get(name).version }),
    markSaved: (name, version) => { models.get(name).savedVersion = version; },
    isDirty: (name) => models.get(name).version !== models.get(name).savedVersion,
    dirtyPaths: () => [...models.keys()].filter((name) => editor.isDirty(name)),
    reload(name, content) {
      const model = models.get(name);
      model.content = content;
      model.savedVersion = ++model.version;
    },
    restoreContent(name, content) {
      const model = models.get(name);
      model.content = content;
      model.version++;
    },
  };
  const api = {
    readProjectFile: async (name) => projects.readProjectFile(root, name),
    writeProjectFile: async (name, content, revision) => projects.writeProjectFile(root, name, content, revision),
    confirmFileConflict: async () => 'cancel',
    confirmRunChanges: async () => 'save',
    confirmUnsaved: async () => 'save',
  };
  const comparisons = [];
  let compareChoice = { choice: 'cancel' };
  const compare = async (request) => {
    comparisons.push(request);
    return typeof compareChoice === 'function' ? compareChoice(request) : compareChoice;
  };
  const workspace = new WorkspaceFiles({ editor, api, getFile: (name) => tabs.get(name), compare });
  function open(name, content) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
    tabs.set(name, projects.readProjectFile(root, name));
    models.set(name, { content, version: 1, savedVersion: 1 });
  }
  function edit(name, content) {
    models.get(name).content = content;
    models.get(name).version++;
  }
  function reopen(name) {
    const disk = projects.readProjectFile(root, name);
    tabs.set(name, disk);
    models.set(name, { content: disk.content, version: 1, savedVersion: 1 });
  }
  return {
    root, api, workspace, editor, open, edit, reopen, comparisons,
    answerCompare: (choice) => { compareChoice = choice; },
    read: (name) => fs.readFileSync(path.join(root, name), 'utf8'),
  };
}

test('opening an external link produces an explanatory read-only file state', async () => {
  const f = fixture();
  const outside = tempDir('workspace-external');
  fs.writeFileSync(path.join(outside, 'private.resource'), 'external content');
  fs.symlinkSync(outside, path.join(f.root, 'linked'), 'junction');
  const opened = await f.workspace.read('linked/private.resource');
  assert.equal(opened.path, 'linked/private.resource');
  assert.equal(opened.content, null);
  assert.match(opened.reason, /outside the project/);
  assert.match(opened.reason, /destination folder/);
  assert.ok(!opened.reason.includes('external content'));
});

test('opening a missing file explains recovery and strips the IPC wrapper from the error', async () => {
  const f = fixture();
  const read = f.api.readProjectFile;
  f.api.readProjectFile = async (name) => {
    try { return await read(name); }
    catch (error) { throw new Error(`Error invoking remote method 'project:read-file': Error: ${error.message}`); }
  };
  const opened = await f.workspace.read('missing.robot');
  assert.equal(opened.content, null);
  assert.match(opened.reason, /missing\.robot/);
  assert.match(opened.reason, /reopen/);
  assert.ok(!opened.reason.includes('project:read-file'));
});

test('opening a readable file retains its content and disk revision', async () => {
  const f = fixture();
  f.open('example.robot', 'original content');
  const opened = await f.workspace.read('example.robot');
  assert.equal(opened.content, 'original content');
  assert.equal(projects.writeProjectFile(f.root, 'example.robot', 'saved change', opened.revision).ok, true);
  assert.equal(f.read('example.robot'), 'saved change');
});

test('typing during a save leaves the newer editor content dirty', async () => {
  const f = fixture();
  f.open('tests/example.robot', 'original');
  f.edit('tests/example.robot', 'first edit');
  let finish;
  const write = f.api.writeProjectFile;
  f.api.writeProjectFile = (...args) => new Promise((resolve) => { finish = async () => resolve(await write(...args)); });
  const saving = f.workspace.save('tests/example.robot');
  await Promise.resolve();
  f.edit('tests/example.robot', 'newer edit');
  await finish();
  assert.equal(await saving, false);
  assert.equal(f.read('tests/example.robot'), 'first edit');
  assert.equal(f.editor.snapshot('tests/example.robot').content, 'newer edit');
  assert.equal(f.editor.isDirty('tests/example.robot'), true);
});

test('successive save requests serialize writes and persist the latest edit', async () => {
  const f = fixture();
  f.open('a.robot', 'original');
  f.edit('a.robot', 'first');
  let finish;
  const write = f.api.writeProjectFile;
  f.api.writeProjectFile = (...args) => new Promise((resolve) => {
    f.api.writeProjectFile = write;
    finish = async () => resolve(await write(...args));
  });
  const first = f.workspace.save('a.robot');
  await Promise.resolve();
  f.edit('a.robot', 'second');
  const second = f.workspace.save('a.robot');
  await finish();
  await first;
  assert.equal(await second, true);
  assert.equal(f.read('a.robot'), 'second');
  assert.equal(f.editor.isDirty('a.robot'), false);
});

test('a save completing after a tab is reopened cannot mark the replacement buffer clean', async () => {
  const f = fixture();
  f.open('a.robot', 'original');
  f.edit('a.robot', 'older edit');
  f.edit('a.robot', 'older snapshot');
  let finish;
  const write = f.api.writeProjectFile;
  f.api.writeProjectFile = (...args) => new Promise((resolve) => { finish = async () => resolve(await write(...args)); });
  const saving = f.workspace.save('a.robot');
  await Promise.resolve();
  f.reopen('a.robot');
  f.edit('a.robot', 'replacement edit');
  f.edit('a.robot', 'replacement snapshot');
  await finish();
  assert.equal(await saving, false);
  assert.equal(f.editor.snapshot('a.robot').content, 'replacement snapshot');
  assert.equal(f.editor.isDirty('a.robot'), true);
});

test('cancelling an external conflict preserves both disk and editor changes', async () => {
  const f = fixture();
  f.open('a.robot', 'original');
  f.edit('a.robot', 'editor');
  fs.writeFileSync(path.join(f.root, 'a.robot'), 'external');
  assert.equal(await f.workspace.save('a.robot'), false);
  assert.equal(f.read('a.robot'), 'external');
  assert.equal(f.editor.snapshot('a.robot').content, 'editor');
  assert.equal(f.editor.isDirty('a.robot'), true);
});

test('overwriting a conflict requires an explicit choice and updates the saved revision', async () => {
  const f = fixture();
  f.open('a.robot', 'original');
  f.edit('a.robot', 'editor');
  fs.writeFileSync(path.join(f.root, 'a.robot'), 'external');
  f.api.confirmFileConflict = async () => 'overwrite';
  assert.equal(await f.workspace.save('a.robot'), true);
  f.edit('a.robot', 'next edit');
  assert.equal(await f.workspace.save('a.robot'), true);
  assert.equal(f.read('a.robot'), 'next edit');
});

test('reloading a conflict replaces the buffer but cancels the pending save', async () => {
  const f = fixture();
  f.open('a.robot', 'original');
  f.edit('a.robot', 'editor');
  fs.writeFileSync(path.join(f.root, 'a.robot'), 'external');
  f.api.confirmFileConflict = async () => 'reload';
  assert.equal(await f.workspace.save('a.robot'), false);
  assert.equal(f.editor.snapshot('a.robot').content, 'external');
  assert.equal(f.editor.isDirty('a.robot'), false);
  f.edit('a.robot', 'next edit');
  assert.equal(await f.workspace.save('a.robot'), true);
});

test('comparing a conflict shows the disk and editor versions and can be cancelled', async () => {
  const f = fixture();
  f.open('a.robot', 'original');
  f.edit('a.robot', 'editor');
  fs.writeFileSync(path.join(f.root, 'a.robot'), 'external');
  f.api.confirmFileConflict = async () => 'compare';
  assert.equal(await f.workspace.save('a.robot'), false);
  assert.deepEqual(f.comparisons, [{ path: 'a.robot', disk: 'external', mine: 'editor' }]);
  assert.equal(f.read('a.robot'), 'external');
  assert.equal(f.editor.snapshot('a.robot').content, 'editor');
  assert.equal(f.editor.isDirty('a.robot'), true);
});

test('a version merged in the comparison is saved and replaces the editor content', async () => {
  const f = fixture();
  f.open('a.robot', 'original');
  f.edit('a.robot', 'editor');
  fs.writeFileSync(path.join(f.root, 'a.robot'), 'external');
  f.api.confirmFileConflict = async () => 'compare';
  f.answerCompare({ choice: 'save', content: 'external + editor' });
  assert.equal(await f.workspace.save('a.robot'), true);
  assert.equal(f.read('a.robot'), 'external + editor');
  assert.equal(f.editor.snapshot('a.robot').content, 'external + editor');
  assert.equal(f.editor.isDirty('a.robot'), false);
  f.edit('a.robot', 'next edit');
  assert.equal(await f.workspace.save('a.robot'), true);
  assert.equal(f.read('a.robot'), 'next edit');
});

test('the disk version chosen in the comparison replaces the buffer without saving', async () => {
  const f = fixture();
  f.open('a.robot', 'original');
  f.edit('a.robot', 'editor');
  fs.writeFileSync(path.join(f.root, 'a.robot'), 'external');
  f.api.confirmFileConflict = async () => 'compare';
  f.answerCompare({ choice: 'reload' });
  assert.equal(await f.workspace.save('a.robot'), false);
  assert.equal(f.editor.snapshot('a.robot').content, 'external');
  assert.equal(f.editor.isDirty('a.robot'), false);
  assert.equal(f.read('a.robot'), 'external');
});

test('a file changed again during the comparison raises a new conflict', async () => {
  const f = fixture();
  f.open('a.robot', 'original');
  f.edit('a.robot', 'editor');
  fs.writeFileSync(path.join(f.root, 'a.robot'), 'external');
  const answers = ['compare', 'cancel'];
  f.api.confirmFileConflict = async () => answers.shift();
  f.answerCompare(() => {
    fs.writeFileSync(path.join(f.root, 'a.robot'), 'external again');
    return { choice: 'save', content: 'merged' };
  });
  assert.equal(await f.workspace.save('a.robot'), false);
  assert.deepEqual(answers, []);
  assert.equal(f.read('a.robot'), 'external again');
  // The merged version stays in the editor, unsaved, rather than being lost.
  assert.equal(f.editor.snapshot('a.robot').content, 'merged');
  assert.equal(f.editor.isDirty('a.robot'), true);
});

test('preparing a run saves dirty resources as well as test files', async () => {
  const f = fixture();
  for (const name of ['tests/a.robot', 'resources/common.resource']) {
    f.open(name, 'original');
    f.edit(name, 'updated');
  }
  assert.equal((await f.workspace.prepareRun()).ok, true);
  assert.equal(f.read('tests/a.robot'), 'updated');
  assert.equal(f.read('resources/common.resource'), 'updated');
  assert.deepEqual(f.editor.dirtyPaths(), []);
});

test('running saved files is explicit and leaves dirty buffers untouched', async () => {
  const f = fixture();
  f.open('a.robot', 'original');
  f.edit('a.robot', 'editor');
  f.api.confirmRunChanges = async () => 'saved';
  const result = await f.workspace.prepareRun();
  assert.equal(result.ok, true);
  assert.equal(result.usingSaved, true);
  assert.equal(f.read('a.robot'), 'original');
  assert.equal(f.editor.isDirty('a.robot'), true);
});

test('a cancelled run neither saves nor starts preparation successfully', async () => {
  const f = fixture();
  f.open('a.robot', 'original');
  f.edit('a.robot', 'editor');
  f.api.confirmRunChanges = async () => 'cancel';
  assert.equal((await f.workspace.prepareRun()).ok, false);
  assert.equal(f.read('a.robot'), 'original');
});

test('watch runs pause on dirty buffers without opening a dialog', async () => {
  const f = fixture();
  f.open('a.robot', 'original');
  f.edit('a.robot', 'editor');
  f.api.confirmRunChanges = async () => { throw new Error('Watch must not show a dialog'); };
  assert.equal((await f.workspace.prepareRun({ background: true })).ok, false);
  assert.equal(f.read('a.robot'), 'original');
});

test('a save failure prevents the run and keeps the buffer dirty', async () => {
  const f = fixture();
  f.open('a.robot', 'original');
  f.edit('a.robot', 'editor');
  f.api.writeProjectFile = async () => { throw new Error('Disk full'); };
  assert.equal((await f.workspace.prepareRun()).ok, false);
  assert.equal(f.editor.isDirty('a.robot'), true);
  assert.equal(f.read('a.robot'), 'original');
});

test('closing several files aborts when an earlier buffer changes during a later save', async () => {
  const f = fixture();
  for (const name of ['a.robot', 'b.resource']) {
    f.open(name, 'original');
    f.edit(name, 'first edit');
  }
  const write = f.api.writeProjectFile;
  f.api.writeProjectFile = async (...args) => {
    const result = await write(...args);
    if (args[0] === 'b.resource') f.edit('a.robot', 'late edit');
    return result;
  };
  assert.equal(await f.workspace.resolveUnsaved(['a.robot', 'b.resource']), false);
  assert.equal(f.editor.isDirty('a.robot'), true);
  assert.equal(f.editor.snapshot('a.robot').content, 'late edit');
});

test('discarding or cancelling a close never writes the buffer to disk', async () => {
  const f = fixture();
  f.open('a.robot', 'original');
  f.edit('a.robot', 'editor');
  f.api.confirmUnsaved = async () => 'cancel';
  assert.equal(await f.workspace.resolveUnsaved(['a.robot']), false);
  f.api.confirmUnsaved = async () => 'discard';
  assert.equal(await f.workspace.resolveUnsaved(['a.robot']), true);
  assert.equal(f.read('a.robot'), 'original');
});
