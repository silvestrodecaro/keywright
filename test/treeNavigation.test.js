'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { treeAction, bindTabs } = require('../src/renderer/treeNavigation');

// Only visible rows participate: the child of the collapsed resources folder is absent.
const rows = [
  { id: 'tests', parent: null, expanded: true },
  { id: 'login', parent: 'tests' },
  { id: 'nested', parent: 'tests', expanded: true },
  { id: 'checkout', parent: 'nested' },
  { id: 'resources', parent: null, expanded: false },
];

test('tree arrows and Home/End move through visible rows without wrapping', () => {
  for (const [id, key, expected] of [
    ['tests', 'ArrowUp', { focus: 'tests' }],
    ['login', 'ArrowDown', { focus: 'nested' }],
    ['checkout', 'ArrowUp', { focus: 'nested' }],
    ['resources', 'ArrowDown', { focus: 'resources' }],
    ['checkout', 'Home', { focus: 'tests' }],
    ['login', 'End', { focus: 'resources' }],
    ['tests', 'ArrowRight', { focus: 'login' }],
    ['checkout', 'ArrowLeft', { focus: 'nested' }],
  ]) assert.deepEqual(treeAction(rows, id, key), expected);
});

test('tree expansion keys toggle only the intended folder', () => {
  assert.deepEqual(treeAction(rows, 'resources', 'ArrowRight'), { toggle: 'resources' });
  assert.deepEqual(treeAction(rows, 'nested', 'ArrowLeft'), { toggle: 'nested' });
  assert.equal(treeAction(rows, 'checkout', 'ArrowRight'), null);
  assert.equal(treeAction(rows, 'tests', 'ArrowLeft')?.toggle, 'tests');
});

test('Enter and Space activate the focused item while unrelated keys are left alone', () => {
  assert.deepEqual(treeAction(rows, 'login', 'Enter'), { activate: 'login' });
  assert.deepEqual(treeAction(rows, 'resources', ' '), { activate: 'resources' });
  assert.equal(treeAction(rows, 'login', 'Tab'), null);
  assert.equal(treeAction([], null, 'ArrowDown'), null);
});

test('tab arrow navigation retains focus when activating a pane replaces the tab buttons', () => {
  let handler;
  let focused;
  const replacement = { id: 'file', focus: () => { focused = replacement; } };
  const first = { id: 'results' };
  const file = {
    id: 'file',
    focus: () => { focused = file; },
    click: () => { nodes = [first, replacement]; focused = 'editor'; },
  };
  let nodes = [first, file];
  bindTabs({ addEventListener: (_name, callback) => { handler = callback; }, querySelectorAll: () => nodes });
  handler({ key: 'ArrowRight', target: first, preventDefault() {} });
  assert.equal(focused, replacement);
});
