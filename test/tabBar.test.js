'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { fileTabView, fixedTabList } = require('../src/renderer/tabBar');

const FIXED = [
  { id: '__generator__', label: '● Test Generator', pane: '#pane-generator' },
  { id: '__results__', label: '▶ Test Results', pane: '#pane-results' },
];

test('a file tab shows the file name, and marks the active and unsaved states', () => {
  assert.deepStrictEqual(fileTabView({ path: 'tests/login.robot' }, 'tests/login.robot', false), {
    name: 'login.robot',
    className: 'tab is-active',
    title: 'tests/login.robot',
    label: 'login.robot',
    id: 'tab-file-tests%2Flogin.robot',
  });
  assert.deepStrictEqual(fileTabView({ path: 'a b.resource' }, '__results__', true), {
    name: 'a b.resource',
    className: 'tab is-dirty',
    title: 'a b.resource (unsaved)',
    label: 'a b.resource, unsaved changes',
    id: 'tab-file-a%20b.resource',
  });
});

test('the Git Diff tab follows the fixed tabs only while a diff is shown', () => {
  assert.deepStrictEqual(fixedTabList(FIXED, false, '__git_diff__'), FIXED);
  assert.deepStrictEqual(fixedTabList(FIXED, true, '__git_diff__'),
    [...FIXED, { id: '__git_diff__', label: 'Git Diff', pane: '#pane-git-diff' }]);
});
