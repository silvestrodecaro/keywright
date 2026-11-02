'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function storage(entries = []) {
  const values = new Map(entries);
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test('reading legacy preferences preserves project suffixes and keeps the original data', () => {
  const { readSetting } = require('../src/renderer/settings');
  const values = [
    ['sidebarWidth', '360'], ['lint', 'off'], ['watches', '["${name}"]'],
    ['breakpoints:C:\\Projects\\example', '{"tests/a.robot":[10]}'],
    ['runOptions:C:\\Projects\\example', '{"include":"smoke","dryrun":true}'],
  ];
  const saved = storage(values.map(([suffix, value]) => ['rfide.' + suffix, value]));
  for (const [suffix, value] of values) {
    assert.equal(readSetting(saved, 'keywright.' + suffix), value);
    assert.equal(saved.getItem('keywright.' + suffix), value);
    assert.equal(saved.getItem('rfide.' + suffix), value);
  }
});

test('modern preferences take precedence and an empty value is not replaced', () => {
  const { readSetting } = require('../src/renderer/settings');
  const saved = storage([['keywright.watches', ''], ['rfide.watches', '["old"]']]);
  assert.equal(readSetting(saved, 'keywright.watches'), '');
  saved.setItem('keywright.watches', '["new"]');
  assert.equal(readSetting(saved, 'keywright.watches'), '["new"]');
  assert.equal(saved.getItem('rfide.watches'), '["old"]');
});

test('legacy preferences remain usable when storage cannot accept a migration write', () => {
  const { readSetting } = require('../src/renderer/settings');
  const saved = storage([['rfide.sidebarWidth', '360']]);
  saved.setItem = () => { throw new Error('Quota exceeded'); };
  assert.equal(readSetting(saved, 'keywright.sidebarWidth'), '360');
  assert.equal(saved.getItem('rfide.sidebarWidth'), '360');
});

test('unavailable preference storage falls back without preventing application startup', () => {
  const { readSetting } = require('../src/renderer/settings');
  const blocked = { getItem() { throw new Error('Storage unavailable'); } };
  assert.equal(readSetting(blocked, 'keywright.sidebarWidth'), null);
});
