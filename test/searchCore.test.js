'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildRegex, findInText, applyReplacements, includeFilter, expandReplacement } = require('../src/renderer/searchCore');

const where = (matches) => matches.map((m) => `${m.line}:${m.column}+${m.length}`);

test('plain, case-sensitive and whole-word search', () => {
  const text = 'Open App\n    open app\n    Open Application    ${open}';
  assert.deepStrictEqual(where(findInText(text, buildRegex({ query: 'open' }))), ['1:1+4', '2:5+4', '3:5+4', '3:27+4']);
  assert.deepStrictEqual(where(findInText(text, buildRegex({ query: 'Open', caseSensitive: true }))), ['1:1+4', '3:5+4']);
  assert.deepStrictEqual(where(findInText(text, buildRegex({ query: 'open app', wholeWord: true }))), ['1:1+8', '2:5+8']);
  // Special characters are literal unless regex is on.
  assert.deepStrictEqual(where(findInText(text, buildRegex({ query: '${open}' }))), ['3:25+7']);
});

test('regex search, replacements with groups, line endings kept', () => {
  const text = 'Click    id=login\r\nClick    id=logout\r\n';
  const re = buildRegex({ query: 'id=(\\w+)', regex: true });
  const matches = findInText(text, re, { replacement: 'css=#$1', regex: true });
  assert.deepStrictEqual(matches.map((m) => m.replacement), ['css=#login', 'css=#logout']);
  assert.strictEqual(applyReplacements(text, matches), 'Click    css=#login\r\nClick    css=#logout\r\n');
  // Without regex `$1` is literal.
  const literal = findInText('a $x', buildRegex({ query: 'a' }), { replacement: '$1' });
  assert.strictEqual(applyReplacements('a $x', literal), '$1 $x');
  assert.strictEqual(expandReplacement('[$&] $$ $<n> $9', 'ab'.match(/(?<n>a)b/)), '[ab] $ a $9');
  assert.throws(() => buildRegex({ query: '(', regex: true }), SyntaxError);
});

test('zero-length matches and limits', () => {
  assert.deepStrictEqual(findInText('abc', buildRegex({ query: '^', regex: true })), []);
  assert.strictEqual(findInText('a a a a', buildRegex({ query: 'a' }), { limit: 2 }).length, 2);
});

test('files to include', () => {
  const robotOnly = includeFilter('*.robot');
  assert.ok(robotOnly('tests/login.robot') && !robotOnly('resources/common.resource'));
  const several = includeFilter('*.robot, resources/**');
  assert.ok(several('resources/sub/x.resource') && several('a.robot') && !several('README.md'));
  const folder = includeFilter('tests/');
  assert.ok(folder('tests/a/b.robot') && !folder('resources/c.resource'));
  const nested = includeFilter('tests/**/*.robot');
  assert.ok(nested('tests/a.robot') && nested('tests/x/y/a.robot') && !nested('tests/a.resource'));
  assert.ok(includeFilter('')('anything.txt'));
});
