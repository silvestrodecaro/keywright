'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { clampWidth, storedWidth, SIDEBAR_DEFAULT } = require('../src/renderer/sidebarWidth');

test('the sidebar keeps between 250 px and 60% of the window', () => {
  assert.strictEqual(clampWidth(300.4, 1000), 300);
  assert.strictEqual(clampWidth(100, 1000), 250);
  assert.strictEqual(clampWidth(900, 1000), 600);
  // A window narrower than the minimum still gets the minimum.
  assert.strictEqual(clampWidth(500, 300), 250);
});

test('the stored width is used when it is a positive number', () => {
  const storage = (value) => ({ getItem: (key) => (key === 'keywright.sidebarWidth' ? value : null) });
  assert.strictEqual(storedWidth(storage('320')), 320);
  assert.strictEqual(storedWidth(storage(null)), SIDEBAR_DEFAULT);
  assert.strictEqual(storedWidth(storage('wide')), SIDEBAR_DEFAULT);
  assert.strictEqual(storedWidth(storage('-5')), SIDEBAR_DEFAULT);
  assert.strictEqual(storedWidth({ getItem: () => { throw new Error('blocked'); } }), SIDEBAR_DEFAULT);
});
