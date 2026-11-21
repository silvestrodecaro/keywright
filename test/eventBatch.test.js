'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Batch } = require('../src/main/eventBatch');

test('items pushed close together are delivered once, in order', async () => {
  const delivered = [];
  const batch = new Batch((items) => delivered.push(items), 20);
  batch.push(1);
  batch.push(2);
  batch.push(3);
  assert.deepEqual(delivered, []);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(delivered, [[1, 2, 3]]);
});

test('flush delivers at once and nothing is delivered twice', async () => {
  const delivered = [];
  const batch = new Batch((items) => delivered.push(items), 20);
  batch.push('a');
  batch.flush();
  batch.flush();
  assert.deepEqual(delivered, [['a']]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(delivered, [['a']]);
});
