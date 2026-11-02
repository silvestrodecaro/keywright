'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { compile, selected, parseList } = require('../src/renderer/tagPatterns');

// Expected values checked against robot.model.tags.TagPatterns (Robot Framework 7.5).
const CASES = [
  ['smoke', ['smoke'], true], ['smoke', ['Smoke Test'], false], ['smoke test', ['smoke_test'], true],
  ['smokeANDfast', ['smoke'], false], ['smokeANDfast', ['smoke', 'fast'], true], ['smokeORfast', ['fast'], true],
  ['NOTslow', ['fast'], true], ['NOTslow', ['slow'], false], ['smokeNOTslow', ['smoke', 'slow'], false],
  ['aORbANDc', ['a'], true], ['aORbANDc', ['b'], false], ['aNOTbANDc', ['a', 'b'], true], ['aNOTbANDc', ['a', 'b', 'c'], false],
  ['reg*', ['regression'], true], ['r?g', ['rag'], true], ['smoke', [], false], ['NOTslow', [], true],
  ['aNOTbNOTc', ['a', 'c'], false], ['aANDbORc', ['c'], true], ['smoke OR fast', ['fast'], true],
];

test('tag patterns behave like Robot Framework', () => {
  for (const [pattern, tags, expected] of CASES)
    assert.strictEqual(compile(pattern)(tags), expected, `${pattern} ${JSON.stringify(tags)}`);
});

test('include and exclude lists', () => {
  assert.deepStrictEqual(parseList(' smoke, fastANDui ,,'), ['smoke', 'fastANDui']);
  assert.ok(selected(['smoke'], { include: ['smoke', 'ui'] }));
  assert.ok(!selected(['api'], { include: ['smoke', 'ui'] }));
  assert.ok(!selected(['smoke', 'slow'], { include: ['smoke'], exclude: ['slow'] }));
  assert.ok(selected([], {}));
});
