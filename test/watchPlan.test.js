'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { affectedTests } = require('../src/renderer/watchPlan');

const tests = [
  { id: 'Tests.Login.Valid', source: 'tests/login.robot', suites: ['Tests', 'Tests.Login'] },
  { id: 'Tests.Login.Invalid', source: 'tests/login.robot', suites: ['Tests', 'Tests.Login'] },
  { id: 'Tests.Cart.Add', source: 'tests/cart.robot', suites: ['Tests', 'Tests.Cart'] },
];
const plan = (paths, watched = [], watchAll = false) => affectedTests({ paths, tests, watched: new Set(watched), watchAll });

test('nothing is watched: nothing runs', () => {
  assert.deepStrictEqual(plan(['tests/login.robot']), []);
});

test('a changed suite file re-runs its watched tests only', () => {
  assert.deepStrictEqual(plan(['tests/login.robot'], ['Tests.Login.Valid', 'Tests.Cart.Add']), ['Tests.Login.Valid']);
  assert.deepStrictEqual(plan(['tests/login.robot'], ['Tests.Login']), ['Tests.Login.Valid', 'Tests.Login.Invalid']);
  assert.deepStrictEqual(plan(['tests/login.robot'], [], true), ['Tests.Login.Valid', 'Tests.Login.Invalid']);
  assert.deepStrictEqual(plan(['tests/cart.robot'], ['Tests.Login']), []);
});

test('a changed dependency re-runs every watched test', () => {
  assert.deepStrictEqual(plan(['resources/common.resource'], ['Tests.Login.Invalid', 'Tests.Cart']), ['Tests.Login.Invalid', 'Tests.Cart.Add']);
  assert.deepStrictEqual(plan(['libs/helpers.py'], [], true), ['Tests.Login.Valid', 'Tests.Login.Invalid', 'Tests.Cart.Add']);
});

test('irrelevant files are ignored', () => {
  assert.deepStrictEqual(plan(['README.md', 'docs/notes.md'], [], true), []);
  assert.deepStrictEqual(plan(['README.md', 'tests/cart.robot'], [], true), ['Tests.Cart.Add']);
});
