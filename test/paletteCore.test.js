'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { match, rank } = require('../src/renderer/paletteCore');

const labels = (results) => results.map((result) => result.item);

test('a query matches the characters of a text in order, ignoring case and spaces', () => {
  assert.deepStrictEqual(match('rat', 'Run All Tests').positions, [0, 4, 8]);
  assert.deepStrictEqual(match('run all', 'Run All Tests').positions, [0, 1, 2, 4, 5, 6]);
  assert.strictEqual(match('tsr', 'Run All Tests'), null);
  assert.strictEqual(match('x', ''), null);
});

test('an empty query matches everything without highlights', () => {
  assert.deepStrictEqual(match('', 'Save'), { score: 0, positions: [] });
  assert.deepStrictEqual(match('   ', 'Save'), { score: 0, positions: [] });
});

test('word starts and consecutive characters rank higher than scattered ones', () => {
  const items = ['Reload Tests', 'Show Problems', 'Show Status', 'Step Out'];
  assert.deepStrictEqual(labels(rank('st', items, (item) => item)), ['Show Status', 'Step Out', 'Reload Tests']);
  // "Show Status" matches through the word "Status", not the first S.
  assert.deepStrictEqual(match('st', 'Show Status').positions, [5, 6]);
  assert.deepStrictEqual(labels(rank('sp', items, (item) => item)), ['Show Problems', 'Step Out']);
});

test('ties keep the original order', () => {
  const items = ['Show Explorer', 'Show Search', 'Show Testing'];
  assert.deepStrictEqual(labels(rank('show', items, (item) => item)), items);
  assert.deepStrictEqual(labels(rank('', items, (item) => item)), items);
});

test('a file whose name matches ranks above one that matches only through its folder', () => {
  const files = ['tests/login/checkout.robot', 'resources/login.resource', 'tests/login.robot'];
  assert.deepStrictEqual(labels(rank('login', files, (item) => item)), ['resources/login.resource', 'tests/login.robot', 'tests/login/checkout.robot']);
  assert.deepStrictEqual(labels(rank('tlc', files, (item) => item)), ['tests/login/checkout.robot']);
});

test('several fields can be searched, the label first', () => {
  const commands = [
    { label: 'Close Project', category: 'Project' },
    { label: 'Run All Tests', category: 'Testing' },
  ];
  const results = rank('testing run', commands, (command) => `${command.category}: ${command.label}`);
  assert.deepStrictEqual(results.map((result) => result.item.label), ['Run All Tests']);
});
