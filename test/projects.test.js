'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const projects = require('../src/main/projects');
const { RecentProjects } = require('../src/main/recentProjects');
const { tempDir } = require('./helpers/tempDir');

test('validateProjectName', () => {
  assert.strictEqual(projects.validateProjectName('my-web tests_1.0'), null);
  for (const bad of ['', '   ', '../x', 'a/b', 'a\\b', '-x', 'name.', 'what?'])
    assert.ok(projects.validateProjectName(bad), `expected "${bad}" to be rejected`);
});

test('project configuration selects its test layout and Python', () => {
  const root = tempDir('project-config');
  fs.writeFileSync(path.join(root, 'python.exe'), 'test interpreter placeholder');
  fs.writeFileSync(path.join(root, 'keywright.json'), JSON.stringify({ testsDir: 'acceptance', outputDir: 'artifacts', python: 'python.exe' }));
  const project = projects.loadProject(root);
  assert.strictEqual(project.config.testsDir, 'acceptance');
  assert.strictEqual(project.config.outputDir, 'artifacts');
  assert.strictEqual(project.python, path.join(root, 'python.exe'));
});

test('omitted configuration properties use project defaults', () => {
  const root = tempDir('config-defaults');
  fs.writeFileSync(path.join(root, 'keywright.json'), '{"outputDir":"artifacts"}');
  const project = projects.loadProject(root);
  assert.strictEqual(project.config.testsDir, 'tests');
  assert.strictEqual(project.config.outputDir, 'artifacts');
});

test('invalid project configuration reports the filename', () => {
  const root = tempDir('invalid-config');
  fs.writeFileSync(path.join(root, 'keywright.json'), '{broken');
  assert.throws(() => projects.loadProject(root), /Invalid keywright\.json/);
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
  for (const file of ['keywright.json', 'requirements.txt', '.gitignore', 'README.md', 'tests/example.robot', 'resources/common.resource'])
    assert.ok(fs.existsSync(path.join(result.root, file)), `${file} missing`);
  assert.ok(fs.existsSync(path.join(result.root, '.git')));
  assert.ok(fs.existsSync(path.join(result.root, 'results')));

  const project = projects.loadProject(result.root);
  assert.strictEqual(project.name, 'shop tests');
  assert.strictEqual(project.config.testsDir, 'tests');
  assert.strictEqual(project.python, null);

  const tree = projects.listTree(result.root);
  assert.deepStrictEqual(tree.map((n) => n.name), ['resources', 'results', 'tests', '.gitignore', 'keywright.json', 'README.md', 'requirements.txt']);
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

test('project setup accepts a long path and supplies shared browser storage to initialization', async (t) => {
  const childProcess = require('node:child_process');
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const location = path.join(tempDir('deep-project'), 'OneDrive - Test Company', 'Desktop', 'Robot projects');
  fs.mkdirSync(location, { recursive: true });
  assert.ok(location.length > 85);
  const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
  delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  // Only external tool installation is replaced; scaffold and setup sequencing run normally.
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      let code = 0;
      if (args.includes('--version')) {
        child.stdout.end(command === 'node' ? 'v24.16.0' : 'Python 3.13.14');
      } else if (args.includes('Browser.entry')) {
        const cache = options.env.PLAYWRIGHT_BROWSERS_PATH;
        if (!cache || !path.isAbsolute(cache) || cache.startsWith(location)) {
          child.stderr.end('Browser initialization did not receive shared storage');
          code = 1;
        }
      }
      child.emit('close', code);
    });
    return child;
  });
  const modulePath = require.resolve('../src/main/projects');
  const cached = require.cache[modulePath];
  delete require.cache[modulePath];
  const isolated = require('../src/main/projects');
  require.cache[modulePath] = cached;
  try {
    const result = await isolated.createProject({ location, name: 'web tests', createVenv: true, installBrowsers: true });
    assert.strictEqual(result.ok, true, result.error);
    assert.ok(fs.existsSync(path.join(result.root, 'keywright.json')));
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
  }
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
