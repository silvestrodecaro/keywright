'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RecoveryStore } = require('../src/main/recoveryStore');
const { tempDir } = require('./helpers/tempDir');

const project = (dir, name = 'web-tests') => path.join(dir, name);

test('unsaved buffers are stored per project and read back', () => {
  const dir = tempDir('recovery');
  const store = new RecoveryStore(path.join(dir, 'recovery'));
  const entries = [
    { path: 'tests/login.robot', content: '*** Test Cases ***\nLogin\n', revision: 'abc' },
    { path: 'resources/new.resource', content: 'x', revision: null },
  ];
  store.write(project(dir), entries);
  assert.deepEqual(store.read(project(dir)), entries);
  assert.deepEqual(store.read(project(dir, 'other')), []);
});

test('project paths are compared like the file system compares them', { skip: process.platform !== 'win32' }, () => {
  const dir = tempDir('recovery');
  const store = new RecoveryStore(path.join(dir, 'recovery'));
  store.write(project(dir), [{ path: 'a.robot', content: 'a', revision: 'r' }]);
  assert.equal(store.read(project(dir).toUpperCase() + '\\').length, 1);
});

test('writing no buffers removes the stored recovery file', () => {
  const dir = tempDir('recovery');
  const folder = path.join(dir, 'recovery');
  const store = new RecoveryStore(folder);
  store.write(project(dir), [{ path: 'a.robot', content: 'a', revision: 'r' }]);
  assert.equal(fs.readdirSync(folder).length, 1);
  store.write(project(dir), []);
  assert.deepEqual(fs.readdirSync(folder), []);
  store.clear(project(dir)); // clearing a missing file is not an error
});

test('a corrupt or foreign recovery file is ignored', () => {
  const dir = tempDir('recovery');
  const folder = path.join(dir, 'recovery');
  const store = new RecoveryStore(folder);
  store.write(project(dir), [{ path: 'a.robot', content: 'a', revision: 'r' }]);
  const [name] = fs.readdirSync(folder);
  fs.writeFileSync(path.join(folder, name), '{ not json');
  assert.deepEqual(store.read(project(dir)), []);
  // A file whose recorded root differs (a hash collision or a copied profile) is not used.
  fs.writeFileSync(path.join(folder, name), JSON.stringify({ root: project(dir, 'elsewhere'), files: [{ path: 'a.robot', content: 'a', revision: 'r' }] }));
  assert.deepEqual(store.read(project(dir)), []);
  // Malformed entries are dropped, valid ones kept.
  fs.writeFileSync(path.join(folder, name), JSON.stringify({ root: project(dir), files: [{ path: 'a.robot', content: 'a', revision: 'r' }, { path: 5 }, null] }));
  assert.deepEqual(store.read(project(dir)), [{ path: 'a.robot', content: 'a', revision: 'r' }]);
});
