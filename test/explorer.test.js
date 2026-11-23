'use strict';

const test = require('node:test');
const assert = require('node:assert');
const explorer = require('../src/renderer/explorer');

test('absolutePath uses the separator of the project root', () => {
  assert.strictEqual(explorer.absolutePath('C:\\Projects\\shop', 'tests/login.robot'), 'C:\\Projects\\shop\\tests\\login.robot');
  assert.strictEqual(explorer.absolutePath('C:\\Projects\\shop\\', 'a.robot'), 'C:\\Projects\\shop\\a.robot');
  assert.strictEqual(explorer.absolutePath('/home/me/shop/', 'resources/common.resource'), '/home/me/shop/resources/common.resource');
});

test('fileIcon marks Robot suites and resources', () => {
  assert.strictEqual(explorer.fileIcon('login.ROBOT'), '◆');
  assert.strictEqual(explorer.fileIcon('common.resource'), '◇');
  assert.strictEqual(explorer.fileIcon('vars.py'), '·');
});

test('expanded folders inside a renamed folder follow it', () => {
  const expanded = new Set(['tests', 'tests/login', 'tests/login/deep', 'tests/loginx', 'resources']);
  explorer.moveExpanded(expanded, 'tests/login', 'tests/auth');
  assert.deepStrictEqual([...expanded].sort(), ['resources', 'tests', 'tests/auth', 'tests/auth/deep', 'tests/loginx']);
});

test('expanded folders inside a deleted folder are forgotten', () => {
  const expanded = new Set(['tests', 'tests/login', 'tests/login/deep', 'tests/loginx']);
  explorer.removeExpanded(expanded, 'tests/login');
  assert.deepStrictEqual([...expanded], ['tests', 'tests/loginx']);
});
