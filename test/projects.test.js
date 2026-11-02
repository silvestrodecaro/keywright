'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projects = require('../src/main/projects');
const { RecentProjects } = require('../src/main/recentProjects');
const { tempDir } = require('./helpers/tempDir');

test('validateProjectName', () => {
  assert.strictEqual(projects.validateProjectName('my-web tests_1.0'), null);
  for (const bad of ['', '   ', '../x', 'a/b', 'a\\b', '-x', 'name.', 'what?'])
    assert.ok(projects.validateProjectName(bad), `expected "${bad}" to be rejected`);
});

test('checkProjectPathLength only limits Windows projects that install browsers', () => {
  const long = 'C:\\' + 'x'.repeat(100);
  assert.match(projects.checkProjectPathLength(long, { installBrowsers: true, platform: 'win32' }), /at most 85 characters/);
  assert.strictEqual(projects.checkProjectPathLength(long, { installBrowsers: false, platform: 'win32' }), null);
  assert.strictEqual(projects.checkProjectPathLength(long, { installBrowsers: true, platform: 'linux' }), null);
  assert.strictEqual(projects.checkProjectPathLength('C:\\Projects\\shop', { installBrowsers: true, platform: 'win32' }), null);
});

test('saving refuses to overwrite a file changed since it was read', () => {
  const root = tempDir('save-conflict');
  fs.writeFileSync(path.join(root, 'example.robot'), 'original\n');
  const opened = projects.readProjectFile(root, 'example.robot');
  fs.writeFileSync(path.join(root, 'example.robot'), 'external edit\n');
  const result = projects.writeProjectFile(root, 'example.robot', 'editor edit\n', opened.revision);
  assert.strictEqual(fs.readFileSync(path.join(root, 'example.robot'), 'utf8'), 'external edit\n');
  assert.strictEqual(result?.conflict, true);
});

test('saving returns the revision needed for a subsequent save', () => {
  const root = tempDir('save-revision');
  fs.writeFileSync(path.join(root, 'example.robot'), 'original\n');
  const opened = projects.readProjectFile(root, 'example.robot');
  const saved = projects.writeProjectFile(root, 'example.robot', 'first edit\n', opened.revision);
  assert.strictEqual(saved?.ok, true);
  assert.ok(saved.revision);
  assert.notStrictEqual(saved.revision, opened.revision);
  assert.strictEqual(projects.writeProjectFile(root, 'example.robot', 'second edit\n', saved.revision).ok, true);
  assert.strictEqual(fs.readFileSync(path.join(root, 'example.robot'), 'utf8'), 'second edit\n');
});

test('saving a deleted file reports a conflict instead of recreating it', () => {
  const root = tempDir('save-deleted');
  const target = path.join(root, 'example.robot');
  fs.writeFileSync(target, 'original\n');
  const opened = projects.readProjectFile(root, 'example.robot');
  fs.unlinkSync(target);
  const result = projects.writeProjectFile(root, 'example.robot', 'editor edit\n', opened.revision);
  assert.strictEqual(fs.existsSync(target), false);
  assert.strictEqual(result?.conflict, true);
});

test('a failed file replacement preserves the previous contents and removes the temporary file', (t) => {
  const root = tempDir('save-failure');
  fs.writeFileSync(path.join(root, 'example.robot'), 'original\n');
  const opened = projects.readProjectFile(root, 'example.robot');
  t.mock.method(fs, 'renameSync', () => { throw new Error('File is locked'); });
  assert.throws(() => projects.writeProjectFile(root, 'example.robot', 'editor edit\n', opened.revision), /locked/);
  assert.strictEqual(fs.readFileSync(path.join(root, 'example.robot'), 'utf8'), 'original\n');
  assert.deepStrictEqual(fs.readdirSync(root), ['example.robot']);
});

test('a change arriving while the replacement is prepared is not overwritten', (t) => {
  const root = tempDir('save-late-conflict');
  const target = path.join(root, 'example.robot');
  fs.writeFileSync(target, 'original');
  const opened = projects.readProjectFile(root, 'example.robot');
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (name, ...args) => {
    write(name, ...args);
    if (path.basename(name).startsWith('.keywright-save-')) write(target, 'late external edit');
  });
  const result = projects.writeProjectFile(root, 'example.robot', 'editor', opened.revision);
  assert.equal(fs.readFileSync(target, 'utf8'), 'late external edit');
  assert.equal(result.conflict, true);
  assert.deepStrictEqual(fs.readdirSync(root), ['example.robot']);
});

test('createProject scaffolds files and reports steps', async () => {
  const location = tempDir('projects');
  const events = [];
  const result = await projects.createProject({ location, name: 'shop tests', initGit: true }, {
    onSteps: (steps) => events.push(['steps', steps.map((s) => s.id)]),
    onStep: (id, status) => events.push([id, status]),
  });

  assert.deepStrictEqual(result, { root: path.join(location, 'shop tests'), ok: true });
  assert.deepStrictEqual(events, [
    ['steps', ['files', 'git']],
    ['files', 'running'], ['files', 'done'],
    ['git', 'running'], ['git', 'done'],
  ]);
  for (const file of ['rfide.json', 'requirements.txt', '.gitignore', 'README.md', 'tests/example.robot', 'resources/common.resource'])
    assert.ok(fs.existsSync(path.join(result.root, file)), `${file} missing`);
  assert.ok(fs.existsSync(path.join(result.root, '.git')));
  assert.ok(fs.existsSync(path.join(result.root, 'results')));

  const project = projects.loadProject(result.root);
  assert.strictEqual(project.name, 'shop tests');
  assert.strictEqual(project.config.testsDir, 'tests');
  assert.strictEqual(project.python, null);

  const tree = projects.listTree(result.root);
  assert.deepStrictEqual(tree.map((n) => n.name), ['resources', 'results', 'tests', '.gitignore', 'README.md', 'requirements.txt', 'rfide.json']);
  assert.deepStrictEqual(tree.find((n) => n.name === 'tests').children.map((n) => n.path), ['tests/example.robot']);

  assert.match(projects.readProjectFile(result.root, 'tests/example.robot').content, /Get Title {4}== {4}Example Domain/);
  assert.throws(() => projects.readProjectFile(result.root, '../outside.txt'), /outside the project/);

  await assert.rejects(projects.createProject({ location, name: 'shop tests' }), /already exists/);
});

test('createProject marks remaining steps as skipped after a failure', async () => {
  const location = tempDir('projects');
  const statuses = {};
  const originalPath = process.env.PATH;
  process.env.PATH = ''; // no python, no git
  try {
    const result = await projects.createProject({ location, name: 'broken', createVenv: true, initGit: true }, {
      onStep: (id, status) => { statuses[id] = status; },
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /Python 3\.10 or newer was not found/);
  } finally {
    process.env.PATH = originalPath;
  }
  assert.deepStrictEqual(statuses, { files: 'done', venv: 'failed', deps: 'skipped', git: 'skipped' });
  assert.ok(fs.existsSync(path.join(location, 'broken', 'tests', 'example.robot')));
});

test('RecentProjects keeps existing projects, most recent first', () => {
  const dir = tempDir('projects');
  const a = fs.mkdirSync(path.join(dir, 'a'), { recursive: true }) || path.join(dir, 'a');
  const b = fs.mkdirSync(path.join(dir, 'b'), { recursive: true }) || path.join(dir, 'b');
  const recent = new RecentProjects(path.join(dir, 'state', 'recent.json'));
  recent.add(a);
  recent.add(b);
  recent.add(a);
  recent.add(path.join(dir, 'missing'));
  assert.deepStrictEqual(recent.list().map((p) => p.name), ['a', 'b']);
  recent.remove(b);
  assert.deepStrictEqual(recent.list().map((p) => p.name), ['a']);
});
