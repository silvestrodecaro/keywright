'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { escapeArg } = require('../src/generator/escape');
const { toBrowserSelector } = require('../src/generator/selectors');
const { generateRobot, generateSteps } = require('../src/generator/robotGenerator');

test('escapeArg', () => {
  assert.strictEqual(escapeArg(''), '${EMPTY}');
  assert.strictEqual(escapeArg('a  b'), 'a ${SPACE}b');
  assert.strictEqual(escapeArg(' x '), '${SPACE}x${SPACE}');
  assert.strictEqual(escapeArg('#tag'), '\\#tag');
  assert.strictEqual(escapeArg('${var} @{x}'), '\\${var} \\@{x}');
  assert.strictEqual(escapeArg('C:\\temp'), 'C:\\\\temp');
  assert.strictEqual(escapeArg('line1\nline2'), 'line1\\nline2');
  assert.strictEqual(escapeArg('txt=hello'), 'txt\\=hello');
  assert.strictEqual(escapeArg('a=b', { escapeNamedArg: false }), 'a=b');
  assert.strictEqual(escapeArg('https://x.org/?a=b'), 'https://x.org/?a=b');
});

test('toBrowserSelector', () => {
  assert.strictEqual(toBrowserSelector('internal:role=button[name="Sign in"i]'), 'role=button[name="Sign in"i]');
  assert.strictEqual(toBrowserSelector('internal:text="Hello"i'), 'text=Hello');
  assert.strictEqual(toBrowserSelector('internal:text="Hello"s'), 'text="Hello"');
  assert.strictEqual(toBrowserSelector('internal:text=" padded "i'), 'text=" padded "i');
  assert.strictEqual(toBrowserSelector('internal:testid=[data-testid="go"s]'), '[data-testid="go"]');
  assert.strictEqual(toBrowserSelector('internal:label="User"i'), 'internal:label="User"i');
  assert.strictEqual(
    toBrowserSelector('iframe >> internal:control=enter-frame >> internal:role=button[name="a >> b"i] >> nth=0'),
    'iframe >>> role=button[name="a >> b"i] >> nth=0');
});

const page = 'page@1';
const at = (action) => ({ signals: [], pageGuid: page, ...action });

test('single page recording', () => {
  const code = generateRobot([
    at({ name: 'openPage', url: 'about:blank' }),
    at({ name: 'navigate', url: 'https://example.com/' }),
    at({ name: 'click', selector: 'internal:role=link[name="More"i]', button: 'left', modifiers: 0, clickCount: 1 }),
    at({ name: 'click', selector: '#a', button: 'right', modifiers: 0, clickCount: 1 }),
    at({ name: 'click', selector: '#b', button: 'left', modifiers: 2 | 8, clickCount: 2 }),
    at({ name: 'press', selector: '#c', key: 'a', modifiers: 2 }),
    at({ name: 'uncheck', selector: '#d' }),
    at({ name: 'hover', selector: '#e' }),
    at({ name: 'assertValue', selector: '#f', value: '' }),
    at({ name: 'assertChecked', selector: '#g', checked: false }),
    at({ name: 'closePage' }),
  ], { testName: 'My Test', browser: 'firefox' });

  assert.strictEqual(code, [
    '*** Settings ***',
    'Library    Browser',
    '',
    '',
    '*** Test Cases ***',
    'My Test',
    '    New Browser    firefox    headless=False',
    '    New Context',
    '    New Page    https://example.com/',
    '    Click    role=link[name="More"i]',
    '    Click    \\#a    right',
    '    Click With Options    \\#b    left    Control    Shift    clickCount=2',
    '    Press Keys    \\#c    Control+a',
    '    Uncheck Checkbox    \\#d',
    '    Hover    \\#e',
    '    Get Property    \\#f    value    ==    ${EMPTY}',
    '    Get Checkbox State    \\#g    ==    unchecked',
    '    Close Page',
    '',
  ].join('\n'));
});

test('downloads, viewport and channel', () => {
  const code = generateRobot([
    at({ name: 'openPage', url: 'https://example.com/' }),
    at({ name: 'click', selector: '#dl', button: 'left', modifiers: 0, clickCount: 1, signals: [{ name: 'download', downloadAlias: '' }] }),
  ], { channel: 'msedge', viewport: { width: 800, height: 600 } });
  assert.match(code, /New Browser {4}chromium {4}headless=False {4}channel=msedge/);
  assert.match(code, /New Context {4}viewport=\{'width': 800, 'height': 600\}/);
  assert.match(code, /\$\{download_promise\}= {4}Promise To Wait For Download\n {4}Click {4}\\#dl\n {4}\$\{download\}= {4}Wait For {4}\$\{download_promise\}/);
});

test('generateSteps returns only the keyword calls', () => {
  assert.deepStrictEqual(generateSteps([
    at({ name: 'openPage', url: 'about:blank' }),
    at({ name: 'navigate', url: 'https://example.com/' }),
    at({ name: 'fill', selector: 'internal:label="Name"i', text: 'Ada' }),
  ]), [
    'New Page    https://example.com/',
    'Fill Text    internal:label="Name"i    Ada',
  ]);
  assert.deepStrictEqual(generateSteps([]), []);
});

test('visibility assertions wait for the visible state', () => {
  assert.deepStrictEqual(generateSteps([
    at({ name: 'assertVisible', selector: 'internal:text="Please enter a valid e-mail"i' }),
  ]), [
    'Wait For Elements State    text=Please enter a valid e-mail    visible',
  ]);
});
