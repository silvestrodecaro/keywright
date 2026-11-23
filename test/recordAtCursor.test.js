'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseViewport, isRecordable } = require('../src/renderer/recordAtCursor');

test('parseViewport reads the Test Generator viewport setting', () => {
  assert.deepStrictEqual(parseViewport('1280x720'), { width: 1280, height: 720 });
  assert.strictEqual(parseViewport(''), null);
  assert.strictEqual(parseViewport('default'), null);
  assert.strictEqual(parseViewport('1280x'), null);
});

test('only readable Robot files can be recorded into', () => {
  assert.strictEqual(isRecordable({ path: 'tests/a.robot', content: '' }), true);
  assert.strictEqual(isRecordable({ path: 'resources/b.RESOURCE', content: 'x' }), true);
  assert.strictEqual(isRecordable({ path: 'libs/c.py', content: 'x' }), false);
  assert.strictEqual(isRecordable({ path: 'tests/big.robot', content: null }), false);
  assert.strictEqual(isRecordable(undefined), false);
});
