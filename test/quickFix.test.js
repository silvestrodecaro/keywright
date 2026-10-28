'use strict';

const test = require('node:test');
const assert = require('node:assert');
const qf = require('../src/renderer/editor/quickFix');

const normalize = (s) => s.toLowerCase().replace(/[\s_]/g, '');

test('similar names', () => {
  const keywords = ['Click', 'Fill Text', 'Get Text', 'Close Browser', 'Log', 'Log Many'];
  assert.deepStrictEqual(qf.similarNames('Clik', keywords, normalize), ['Click']);
  assert.deepStrictEqual(qf.similarNames('fill txt', keywords, normalize), ['Fill Text']);
  assert.deepStrictEqual(qf.similarNames('Close', keywords, normalize), ['Close Browser']);
  assert.deepStrictEqual(qf.similarNames('Completely Different', keywords, normalize), []);
  assert.deepStrictEqual(qf.similarNames('${BASE_ULR}', ['${BASE URL}', '${OTHER}'], normalize), ['${BASE URL}']);
});

test('keyword stub from a call', () => {
  assert.deepStrictEqual(qf.keywordStub('Login As', ['ada', 'secret', 'remember=True']), [
    'Login As',
    '    [Arguments]    ${arg1}    ${arg2}    ${remember}=${EMPTY}',
    '    Fail    Not implemented',
  ]);
  assert.deepStrictEqual(qf.keywordStub('Do It', []), ['Do It', '    Fail    Not implemented']);
});

test('keyword insertion: existing section or a new one', () => {
  const withSection = ['*** Test Cases ***', 'T', '    Do It', '', '*** Keywords ***', 'Other', '    No Operation', '', ''];
  const insertion = qf.keywordInsertion(withSection, ['Do It', '    Fail    Not implemented']);
  const result = qf.applyInsertion(withSection, insertion);
  assert.deepStrictEqual(result.slice(4, 10), ['*** Keywords ***', 'Other', '    No Operation', '', 'Do It', '    Fail    Not implemented']);
  assert.strictEqual(result[insertion.keywordLine - 1], 'Do It');

  const without = ['*** Test Cases ***', 'T', '    Do It', ''];
  const created = qf.keywordInsertion(without, ['Do It', '    Fail    Not implemented']);
  const lines = qf.applyInsertion(without, created);
  assert.deepStrictEqual(lines.slice(3), ['', '', '*** Keywords ***', 'Do It', '    Fail    Not implemented', '']);
  assert.strictEqual(lines[created.keywordLine - 1], 'Do It');
});

test('variable insertion', () => {
  const withSection = ['*** Variables ***', '${A}    1', '', '*** Test Cases ***'];
  assert.deepStrictEqual(qf.applyInsertion(withSection, qf.variableInsertion(withSection, '${B}    ${EMPTY}')).slice(0, 3),
    ['*** Variables ***', '${A}    1', '${B}    ${EMPTY}']);
  const settingsOnly = ['*** Settings ***', 'Library    Browser', '', '*** Test Cases ***', 'T'];
  assert.deepStrictEqual(qf.applyInsertion(settingsOnly, qf.variableInsertion(settingsOnly, '${B}    ${EMPTY}')),
    ['*** Settings ***', 'Library    Browser', '', '', '*** Variables ***', '${B}    ${EMPTY}', '', '*** Test Cases ***', 'T']);
  const bare = ['*** Test Cases ***', 'T'];
  assert.deepStrictEqual(qf.applyInsertion(bare, qf.variableInsertion(bare, '${B}    ${EMPTY}')),
    ['*** Variables ***', '${B}    ${EMPTY}', '', '', '*** Test Cases ***', 'T']);
});

test('END insertion', () => {
  const lines = ['*** Test Cases ***', 'T', '    FOR    ${i}    IN RANGE    3', '        Log    ${i}', '        ...    more', '', '    Log    after'];
  assert.deepStrictEqual(qf.endInsertion(lines, 3), { afterLine: 5, lines: ['    END'] });
  const nested = ['T', '    IF    True', '        FOR    ${i}    IN    a', '            Log    ${i}', '    END'];
  assert.deepStrictEqual(qf.endInsertion(nested, 3), { afterLine: 4, lines: ['        END'] });
});

test('call arguments with continuation lines', () => {
  const lines = ['*** Test Cases ***', 'T', '    Login As    ada', '    ...    secret', '    Log    x'];
  assert.deepStrictEqual(qf.callArguments(lines, 3, 4), ['ada', 'secret']);
});
