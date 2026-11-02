'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const projects = require('../src/main/projects');
const { replaceInProject } = require('../src/main/projectSearch');
const { tempDir } = require('./helpers/tempDir');

function fixture() {
  const base = tempDir('project-boundary');
  const root = path.join(base, 'project');
  const outside = path.join(base, 'project-other');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'shared.resource'), 'external original\n');
  fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
  return { base, root, outside };
}

test('reading through an external directory link is refused', () => {
  const { root } = fixture();
  assert.throws(() => projects.readProjectFile(root, 'linked/shared.resource'), /outside the project/);
});

test('saving through an external directory link leaves its destination unchanged', () => {
  const { root, outside } = fixture();
  const opened = projects.readProjectFile(outside, 'shared.resource');
  assert.throws(() => projects.writeProjectFile(root, 'linked/shared.resource', 'editor change', opened.revision),
    /outside the project/);
  assert.equal(fs.readFileSync(path.join(outside, 'shared.resource'), 'utf8'), 'external original\n');
  assert.deepEqual(fs.readdirSync(outside), ['shared.resource']);
});

test('creating a file through an external link does not create folders outside the project', () => {
  const { root, outside } = fixture();
  assert.throws(() => projects.createProjectFile(root, 'linked/new-folder/new.robot'), /outside the project/);
  assert.deepEqual(fs.readdirSync(outside), ['shared.resource']);
});

test('project replacement refuses an external directory link', () => {
  const { root, outside } = fixture();
  assert.throws(() => replaceInProject(root, { query: 'original' }, 'replacement', [{ path: 'linked/shared.resource' }]),
    /outside the project/);
  assert.equal(fs.readFileSync(path.join(outside, 'shared.resource'), 'utf8'), 'external original\n');
});

test('internal directory links and a project opened through a link keep working', () => {
  const base = tempDir('internal-links');
  const root = path.join(base, 'project');
  const actual = path.join(root, 'resources');
  fs.mkdirSync(actual, { recursive: true });
  fs.writeFileSync(path.join(actual, 'shared.resource'), 'original');
  fs.symlinkSync(actual, path.join(root, 'linked'), 'junction');
  const projectAlias = path.join(base, 'project-alias');
  fs.symlinkSync(root, projectAlias, 'junction');
  const opened = projects.readProjectFile(projectAlias, 'linked/shared.resource');
  assert.equal(opened.content, 'original');
  assert.equal(projects.writeProjectFile(projectAlias, 'linked/shared.resource', 'updated', opened.revision).ok, true);
  assert.equal(fs.readFileSync(path.join(actual, 'shared.resource'), 'utf8'), 'updated');
  assert.ok(fs.lstatSync(path.join(root, 'linked')).isSymbolicLink());
  projects.createProjectFile(projectAlias, 'linked/nested/new.robot');
  assert.equal(fs.readFileSync(path.join(actual, 'nested/new.robot'), 'utf8'), '');
  assert.equal(replaceInProject(projectAlias, { query: 'updated' }, 'replaced', [{ path: 'linked/shared.resource' }]).count, 1);
  assert.equal(fs.readFileSync(path.join(actual, 'shared.resource'), 'utf8'), 'replaced');
});

test('a name beginning with two dots is still a valid project file', () => {
  const root = tempDir('dot-prefix');
  fs.writeFileSync(path.join(root, '..notes.robot'), 'notes');
  const opened = projects.readProjectFile(root, '..notes.robot');
  assert.equal(opened.content, 'notes');
  assert.equal(projects.writeProjectFile(root, '..notes.robot', 'updated', opened.revision).ok, true);
  assert.throws(() => projects.readProjectFile(root, '../outside.robot'), /outside the project/);
});

test('a save refuses a directory link retargeted while the replacement is being prepared', (t) => {
  const { root, outside } = fixture();
  const internal = path.join(root, 'resources');
  fs.mkdirSync(internal);
  fs.writeFileSync(path.join(internal, 'shared.resource'), 'internal original');
  const link = path.join(root, 'changing');
  fs.symlinkSync(internal, link, 'junction');
  const opened = projects.readProjectFile(root, 'changing/shared.resource');
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    write(file, ...args);
    if (path.basename(file).startsWith('.keywright-save-')) {
      assert.ok(fs.lstatSync(link).isSymbolicLink());
      fs.unlinkSync(link);
      fs.symlinkSync(outside, link, 'junction');
    }
  });
  assert.throws(() => projects.writeProjectFile(root, 'changing/shared.resource', 'editor change', opened.revision),
    /outside the project/);
  assert.equal(fs.readFileSync(path.join(internal, 'shared.resource'), 'utf8'), 'internal original');
  assert.equal(fs.readFileSync(path.join(outside, 'shared.resource'), 'utf8'), 'external original\n');
  assert.deepEqual(fs.readdirSync(internal), ['shared.resource']);
});
