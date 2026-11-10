'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { kindOf, withExtension, defaultKind, isWithin, moved } = require('../src/renderer/fileNames');

test('the typed extension decides the kind; a name without one keeps the chosen kind', () => {
  assert.equal(kindOf('tests/login.robot'), 'robot');
  assert.equal(kindOf('resources/Common.RESOURCE'), 'resource');
  assert.equal(kindOf('libs/helpers.py'), 'other');
  assert.equal(kindOf('tests/login'), null);
  assert.equal(kindOf('tests/.env'), null);
  assert.equal(kindOf('tests/login.'), null);
  assert.equal(kindOf('v1.2/login'), null);
});

test('the chosen extension is added only when the name has none', () => {
  assert.equal(withExtension('tests/login', 'robot'), 'tests/login.robot');
  assert.equal(withExtension('resources/common', 'resource'), 'resources/common.resource');
  assert.equal(withExtension('tests/login.robot', 'resource'), 'tests/login.robot');
  assert.equal(withExtension('libs/helpers.py', 'robot'), 'libs/helpers.py');
  assert.equal(withExtension('notes', 'other'), 'notes');
  assert.equal(withExtension(' tests\\login ', 'robot'), 'tests/login.robot');
  assert.equal(withExtension('tests/', 'robot'), 'tests/');
});

test('files created in the resources folder default to .resource', () => {
  const config = { testsDir: 'tests', resourcesDir: 'resources' };
  assert.equal(defaultKind('resources', config), 'resource');
  assert.equal(defaultKind('resources/pages/', config), 'resource');
  assert.equal(defaultKind('resources-old', config), 'robot');
  assert.equal(defaultKind('tests', config), 'robot');
  assert.equal(defaultKind('', config), 'robot');
});

test('paths inside a renamed folder follow it', () => {
  assert.ok(isWithin('tests/a.robot', 'tests'));
  assert.ok(isWithin('tests', 'tests'));
  assert.ok(!isWithin('tests2/a.robot', 'tests'));
  assert.equal(moved('tests/sub/a.robot', 'tests/sub', 'tests/pages'), 'tests/pages/a.robot');
  assert.equal(moved('tests/a.robot', 'tests/a.robot', 'tests/b.robot'), 'tests/b.robot');
  assert.equal(moved('other/a.robot', 'tests', 'specs'), 'other/a.robot');
});
