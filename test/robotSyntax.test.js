'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { analyzeLine, tokenizeLine, cellAt, splitCells, variableRanges, normalizeKeyword } = require('../src/renderer/editor/robotSyntax');

const types = (line, section) => analyzeLine(line, section).cells.filter((c) => c.text).map((c) => [c.text, c.type]);

test('splitCells', () => {
  assert.deepStrictEqual(splitCells('    Click    #a  b'), [
    { text: '', start: 0 }, { text: 'Click', start: 4 }, { text: '#a', start: 13 }, { text: 'b', start: 17 },
  ]);
  assert.deepStrictEqual(splitCells('\tLog\thi there').map((c) => c.text), ['', 'Log', 'hi there']);
  assert.deepStrictEqual(splitCells(' Log').map((c) => c.text), ['', 'Log']);
});

test('section headers', () => {
  assert.strictEqual(analyzeLine('*** Test Cases ***').section, 'tests');
  assert.strictEqual(analyzeLine('*** Tasks ***').section, 'tests');
  assert.strictEqual(analyzeLine('***Settings***').section, 'settings');
  assert.strictEqual(analyzeLine('*** Keyword ***').section, 'keywords');
  assert.strictEqual(analyzeLine('*** Comments ***').section, 'comments');
  assert.strictEqual(analyzeLine('*** Whatever ***').section, 'unknown');
  assert.strictEqual(analyzeLine('    Log    x', 'tests').section, 'tests');
});

test('settings section', () => {
  assert.deepStrictEqual(types('Library    Browser    timeout=10s', 'settings'),
    [['Library', 'setting'], ['Browser', 'argument'], ['timeout=10s', 'argument']]);
  assert.deepStrictEqual(types('Suite Setup    New Browser    chromium', 'settings'),
    [['Suite Setup', 'setting'], ['New Browser', 'keyword'], ['chromium', 'argument']]);
});

test('test and keyword bodies', () => {
  assert.deepStrictEqual(types('Login Works', 'tests'), [['Login Works', 'name']]);
  assert.deepStrictEqual(types('    [Tags]    smoke', 'tests'), [['[Tags]', 'setting'], ['smoke', 'argument']]);
  assert.deepStrictEqual(types('    [Setup]    Open Browser', 'tests'), [['[Setup]', 'setting'], ['Open Browser', 'keyword']]);
  assert.deepStrictEqual(types('    ${a}    ${b}=    Get Two    x', 'keywords'),
    [['${a}', 'variable'], ['${b}=', 'variable'], ['Get Two', 'keyword'], ['x', 'argument']]);
  assert.deepStrictEqual(types('    Get Text    \\#out    ==    Welcome', 'tests'),
    [['Get Text', 'keyword'], ['\\#out', 'argument'], ['==', 'operator'], ['Welcome', 'argument']]);
  assert.deepStrictEqual(types('    FOR    ${i}    IN RANGE    3', 'tests'),
    [['FOR', 'control'], ['${i}', 'variable'], ['IN RANGE', 'control'], ['3', 'argument']]);
  assert.deepStrictEqual(types('    IF    $x > 1', 'tests'), [['IF', 'control'], ['$x > 1', 'argument']]);
  assert.deepStrictEqual(types('    ...    more    args', 'tests'),
    [['...', 'continuation'], ['more', 'argument'], ['args', 'argument']]);
  assert.deepStrictEqual(types('    VAR    ${name}    value', 'tests'), [['VAR', 'control'], ['${name}', 'variable'], ['value', 'argument']]);
});

test('comments', () => {
  const line = '    Log    hi    # note  here';
  const result = analyzeLine(line, 'tests');
  assert.strictEqual(result.comment, line.indexOf('#'));
  assert.deepStrictEqual(result.cells.filter((c) => c.text).map((c) => c.text), ['Log', 'hi']);
  assert.deepStrictEqual(types('Anything here', 'comments'), [['Anything here', 'comment']]);
});

test('variableRanges', () => {
  assert.deepStrictEqual(variableRanges('Hello ${name}!'), [
    { start: 0, end: 6, variable: false }, { start: 6, end: 13, variable: true }, { start: 13, end: 14, variable: false }]);
  assert.deepStrictEqual(variableRanges('${a${b}}[key]').map((p) => p.variable), [true]);
  assert.deepStrictEqual(variableRanges('\\${not}').map((p) => p.variable), [false]);
});

test('tokenizeLine', () => {
  const line = '    Fill Text    id=${field}    hello';
  assert.deepStrictEqual(tokenizeLine(line, 'tests').tokens, [
    { start: 0, type: 'whitespace' },
    { start: 4, type: 'keyword' },
    { start: 13, type: 'whitespace' },
    { start: 17, type: 'param' },
    { start: 20, type: 'variable' },
    { start: 28, type: 'whitespace' },
    { start: 32, type: 'argument' },
  ]);
  assert.deepStrictEqual(tokenizeLine('*** Settings ***', 'none'), { tokens: [{ start: 0, type: 'section' }], section: 'settings' });
  assert.deepStrictEqual(tokenizeLine('    Log    x    # c', 'tests').tokens.map((t) => t.type),
    ['whitespace', 'keyword', 'whitespace', 'argument', 'whitespace', 'comment']);
});

test('cellAt finds keyword positions for completion', () => {
  assert.deepStrictEqual(cellAt('    Cli', 7, 'tests'), { type: 'keyword', start: 4, end: 7, text: 'Cli' });
  assert.strictEqual(cellAt('    ', 4, 'tests').type, 'keyword');
  assert.strictEqual(cellAt('    ${x}=    ', 13, 'tests').type, 'keyword');
  assert.strictEqual(cellAt('    Click    ', 13, 'tests').type, 'argument');
  assert.strictEqual(cellAt('Suite Setup    New Br', 21, 'settings').type, 'keyword');
  assert.deepStrictEqual(cellAt('    Click    sel    more', 7, 'tests'), { type: 'keyword', start: 4, end: 9, text: 'Cli' });
});

test('normalizeKeyword', () => {
  assert.strictEqual(normalizeKeyword('Get_Text'), normalizeKeyword('get text'));
});

test('testCases finds test and task definitions', () => {
  const { testCases } = require('../src/renderer/editor/robotSyntax');
  const result = testCases([
    '*** Settings ***',
    'Library    Browser',
    '*** Test Cases ***',
    'First test',
    '    Log    hi',
    '# a comment',
    '',
    'Second    [Tags]    a',
    '*** Keywords ***',
    'Not a test',
    '    No Operation',
    '*** Tasks ***',
    'Task one',
  ]);
  assert.deepStrictEqual(result, {
    headers: [3, 12],
    tests: [{ name: 'First test', line: 4, end: 7 }, { name: 'Second', line: 8, end: 8 }, { name: 'Task one', line: 13, end: 13 }],
  });
});
