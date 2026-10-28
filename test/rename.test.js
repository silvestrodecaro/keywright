'use strict';

const test = require('node:test');
const assert = require('node:assert');
const rename = require('../src/renderer/editor/rename');
const { parseFile, findVariable } = require('../src/renderer/editor/navigation');

const show = (lines, edits) => rename.applyEdits(lines, edits).join('\n');
const replaceWith = (text) => (occurrences) => occurrences.map((o) => ({ ...o, text: typeof text === 'function' ? text(o) : text }));

test('keywordPart keeps BDD and resource prefixes', () => {
  const kw = { name: 'Open App', library: 'common' };
  assert.deepStrictEqual(rename.keywordPart('Open App', kw), { start: 0, end: 8 });
  assert.deepStrictEqual(rename.keywordPart('open_app', kw), { start: 0, end: 8 });
  assert.deepStrictEqual(rename.keywordPart('Given Open App', kw), { start: 6, end: 14 });
  assert.deepStrictEqual(rename.keywordPart('common.Open App', kw), { start: 7, end: 15 });
  assert.deepStrictEqual(rename.keywordPart('When common.open app', kw), { start: 12, end: 20 });
  assert.strictEqual(rename.keywordPart('other.Open App', kw), null);
  assert.strictEqual(rename.keywordPart('Open Apps', kw), null);
});

test('keyword occurrences: calls, settings, Run Keyword arguments and definition', () => {
  const lines = [
    '*** Settings ***',
    'Suite Setup    Open App',
    '*** Test Cases ***',
    'T',
    '    [Setup]    common.Open App',
    '    Given open app',
    '    Run Keyword And Return Status    Open App',
    '    Wait Until Keyword Succeeds    3x    1s    Open App',
    '    Log    Open App',
    '*** Keywords ***',
    'Open App',
    '    No Operation',
  ];
  const kw = { name: 'Open App', library: 'common' };
  const edits = replaceWith('Start App')(rename.keywordOccurrences(lines, kw, { definition: true }));
  assert.strictEqual(show(lines, edits), [
    '*** Settings ***',
    'Suite Setup    Start App',
    '*** Test Cases ***',
    'T',
    '    [Setup]    common.Start App',
    '    Given Start App',
    '    Run Keyword And Return Status    Start App',
    '    Wait Until Keyword Succeeds    3x    1s    Start App',
    '    Log    Open App',
    '*** Keywords ***',
    'Start App',
    '    No Operation',
  ].join('\n'));
  assert.strictEqual(rename.keywordOccurrences(lines, kw).length, 5, 'without the definition');
});

test('variable occurrences follow scoping and the $name syntax', () => {
  const lines = [
    '*** Variables ***',
    '${COUNT}    1',
    '*** Test Cases ***',
    'Uses Suite Variable',
    '    Log    ${count} ${COUNT.real} \\${COUNT} ${a_${COUNT}}',
    '    IF    $count > 0    Log    $count is not renamed here',
    '    Should Be True    $COUNT == 1',
    '    Log    ${{ $count + 1 }}',
    '    [Documentation]    ${COUNT} in docs',
    'Shadows It',
    '    ${count}=    Set Variable    2',
    '    Log    ${count}',
  ];
  const parsed = parseFile(lines);
  const definition = parsed.variables[0];
  const accept = (name, line) => findVariable(parsed, name, line) === definition;
  const occurrences = rename.variableOccurrences(lines, 'count', accept);
  const edits = occurrences.map((o) => ({ ...o, text: o.expression ? 'TOTAL_ITEMS' : 'TOTAL ITEMS' }));
  assert.strictEqual(show(lines, edits), [
    '*** Variables ***',
    '${TOTAL ITEMS}    1',
    '*** Test Cases ***',
    'Uses Suite Variable',
    '    Log    ${TOTAL ITEMS} ${TOTAL ITEMS.real} \\${COUNT} ${a_${TOTAL ITEMS}}',
    '    IF    $TOTAL_ITEMS > 0    Log    $count is not renamed here',
    '    Should Be True    $TOTAL_ITEMS == 1',
    '    Log    ${{ $TOTAL_ITEMS + 1 }}',
    '    [Documentation]    ${COUNT} in docs',
    'Shadows It',
    '    ${count}=    Set Variable    2',
    '    Log    ${count}',
  ].join('\n'));
});

test('embedded argument definitions keep their pattern', () => {
  const lines = ['*** Keywords ***', 'Add ${count:\\d+} Items', '    Log    ${count}'];
  const occurrences = rename.variableOccurrences(lines, 'count', () => true);
  assert.strictEqual(show(lines, replaceWith('amount')(occurrences)), ['*** Keywords ***', 'Add ${amount:\\d+} Items', '    Log    ${amount}'].join('\n'));
});

test('invalid names', () => {
  assert.match(rename.invalidName('', 'keyword'), /empty/);
  assert.match(rename.invalidName('Open  App', 'keyword'), /consecutive spaces/);
  assert.match(rename.invalidName('${x}', 'variable'), /without/);
  assert.match(rename.invalidName('Open ${x}', 'keyword'), /embedded/);
  assert.strictEqual(rename.invalidName('Open App', 'keyword'), null);
  assert.strictEqual(rename.invalidName('BASE URL', 'variable'), null);
});
