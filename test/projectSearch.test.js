'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { searchProject, replaceInProject } = require('../src/main/projectSearch');
const { tempDir } = require('./helpers/tempDir');

function project() {
  const root = tempDir('search');
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'tests', 'a.robot'), 'Log    old\n');
  fs.writeFileSync(path.join(root, 'tests', 'legacy.robot'), Buffer.from('Log    old caf\xe9\n', 'latin1'));
  return root;
}

test('search and replace leave files that are not UTF-8 untouched', () => {
  const root = project();
  const before = fs.readFileSync(path.join(root, 'tests', 'legacy.robot'));
  const found = searchProject(root, { query: 'old' });
  assert.deepEqual(found.files.map((file) => file.path), ['tests/a.robot']);
  const result = replaceInProject(root, { query: 'old' }, 'new', [{ path: 'tests/a.robot' }, { path: 'tests/legacy.robot' }]);
  assert.deepEqual(result.files, ['tests/a.robot']);
  assert.equal(fs.readFileSync(path.join(root, 'tests', 'a.robot'), 'utf8'), 'Log    new\n');
  assert.deepEqual(fs.readFileSync(path.join(root, 'tests', 'legacy.robot')), before);
});

test('replace skips files with unsaved editor changes', () => {
  const root = project();
  const result = replaceInProject(root, { query: 'old' }, 'new', [{ path: 'tests/a.robot' }], { dirtyPaths: ['tests/a.robot'] });
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.skipped, ['tests/a.robot']);
  assert.equal(fs.readFileSync(path.join(root, 'tests', 'a.robot'), 'utf8'), 'Log    old\n');
});

test('replace writes through a temporary file and leaves none behind', () => {
  const root = project();
  replaceInProject(root, { query: 'old' }, 'new', [{ path: 'tests/a.robot' }]);
  assert.deepEqual(fs.readdirSync(path.join(root, 'tests')).sort(), ['a.robot', 'legacy.robot']);
});

test('search skips the results folder however keywright.json spells it', () => {
  const root = project();
  fs.mkdirSync(path.join(root, 'results'));
  fs.writeFileSync(path.join(root, 'results', 'output.robot'), 'Log    old\n');
  for (const outputDir of ['./results/', 'results', path.join(root, 'results')])
    assert.deepEqual(searchProject(root, { query: 'old' }, { outputDir }).files.map((file) => file.path), ['tests/a.robot'], outputDir);
});
