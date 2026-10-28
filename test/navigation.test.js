'use strict';

const test = require('node:test');
const assert = require('node:assert');
const nav = require('../src/renderer/editor/navigation');

const FILE = [
  '*** Settings ***',                                  // 1
  'Resource    ../resources/common.resource',          // 2
  'Variables    ${CURDIR}${/}vars.py',                 // 3
  'Library    Browser',                                // 4
  '',                                                  // 5
  '*** Variables ***',                                 // 6
  '${BASE URL}    https://example.com',                // 7
  '@{USERS}    ada    bob',                            // 8
  '...    eve',                                        // 9
  '',                                                  // 10
  '*** Test Cases ***',                                // 11
  'Login',                                             // 12
  '    ${title}=    Get Title',                        // 13
  '    FOR    ${user}    IN    @{USERS}',              // 14
  '        Log    ${user} ${title}',                   // 15
  '    END',                                           // 16
  '    VAR    ${count}    3',                          // 17
  '    Set Suite Variable    ${SHARED}    x',          // 18
  '    TRY',                                           // 19
  '        Fail',                                      // 20
  '    EXCEPT    AS    ${error}',                      // 21
  '        Log    ${error}',                           // 22
  '    END',                                           // 23
  'Other',                                             // 24
  '    Log    ${title}',                               // 25
  '',                                                  // 26
  '*** Keywords ***',                                  // 27
  'Open ${page} Page',                                 // 28
  '    [Arguments]    ${user}    ${retries}=2',        // 29
  '    ...    ${verbose}',                             // 30
  '    Log    ${page} ${retries} ${verbose} ${user}',  // 31
];

test('normalizeVariable and variableAt', () => {
  assert.strictEqual(nav.normalizeVariable('${Base_URL}'), nav.normalizeVariable('@{base url}'));
  assert.deepStrictEqual(nav.variableAt('    Log    ${a${b}} x', 16), { name: '${b}', start: 14, end: 18 });
  assert.deepStrictEqual(nav.variableAt('    Log    ${a${b}} x', 12), { name: '${a${b}}', start: 11, end: 19 });
  assert.strictEqual(nav.variableAt('    Log    \\${a}', 13), null);
  assert.deepStrictEqual(nav.lookupKeys('${user.name}'), ['user.name', 'user']);
  assert.ok(nav.isBuiltinVariable('${CURDIR}') && nav.isBuiltinVariable('${3}') && nav.isBuiltinVariable('${EMPTY}'));
  assert.ok(!nav.isBuiltinVariable('${BASE URL}'));
});

test('finds variable definitions in the file', () => {
  const parsed = nav.parseFile(FILE);
  const at = (name, line) => {
    const d = nav.findVariable(parsed, name, line);
    return d && `${d.line}:${d.start} ${d.how}`;
  };
  assert.strictEqual(at('${base_url}', 13), '7:0 variable');
  assert.deepStrictEqual(parsed.variables.find((v) => v.name === '@{USERS}').values, ['ada', 'bob', 'eve']);
  assert.strictEqual(at('${title}', 15), '13:4 assignment');
  assert.strictEqual(at('${user}', 15), '14:11 FOR loop variable');
  assert.strictEqual(at('${count}', 17), '17:11 VAR');
  assert.strictEqual(at('${error}', 22), '21:20 EXCEPT ... AS');
  assert.strictEqual(at('${SHARED}', 25), '18:26 Set Suite Variable');
  assert.strictEqual(at('${title}', 25), null, 'locals of another test are not visible');
  assert.strictEqual(at('${page}', 31), '28:5 embedded argument');
  assert.strictEqual(at('${retries}', 31), '29:30 argument');
  assert.strictEqual(at('${verbose}', 31), '30:11 argument');
  assert.strictEqual(at('${user}', 31), '29:19 argument', 'the keyword argument, not the FOR variable of the test');
  assert.strictEqual(at('${user.name}', 31), '29:19 argument');
});

test('imports and their paths', () => {
  const { imports } = nav.parseFile(FILE);
  assert.deepStrictEqual(imports.map((i) => [i.type, i.path, i.line, i.start]), [
    ['resource', '../resources/common.resource', 2, 12],
    ['variables', '${CURDIR}${/}vars.py', 3, 13],
    ['library', 'Browser', 4, 11],
  ]);
  assert.deepStrictEqual(nav.importCandidates('tests/login.robot', '../resources/common.resource'), ['resources/common.resource']);
  assert.deepStrictEqual(nav.importCandidates('tests/login.robot', '${CURDIR}${/}vars.py'), ['tests/vars.py']);
  assert.deepStrictEqual(nav.importCandidates('tests/login.robot', 'resources/common.resource'), ['tests/resources/common.resource', 'resources/common.resource']);
  assert.deepStrictEqual(nav.importCandidates('tests/login.robot', 'resources\\\\keys.resource'), ['tests/resources/keys.resource', 'resources/keys.resource']);
  assert.deepStrictEqual(nav.importCandidates('tests/login.robot', 'Browser'), []);
  assert.deepStrictEqual(nav.importCandidates('a.robot', '../../outside.resource'), []);
  assert.deepStrictEqual(nav.importCandidates('a.robot', '${ROOT}/x.resource'), []);
});

test('variable files', () => {
  const defs = nav.variableFileDefinitions('vars.py', ['BASE_URL = "https://x"', 'LIST__USERS = ["a"]', '_private = 1', 'def f():', '    inner = 2', 'TIMEOUT: int = 5', 'X == 1']);
  assert.deepStrictEqual(defs.map((d) => [d.name, d.line, d.values[0]]), [['BASE_URL', 1, '"https://x"'], ['USERS', 2, '["a"]'], ['TIMEOUT', 6, '5']]);
  const yaml = nav.variableFileDefinitions('vars.yaml', ['user name: ada', '  nested: 1']);
  assert.deepStrictEqual(yaml.map((d) => [d.key, d.values[0]]), [['username', 'ada']]);
});

test('outline', () => {
  const tree = nav.outline(FILE);
  const flat = tree.map((s) => `${s.name} ${s.line}-${s.end} [${s.children.map((c) => `${c.kind}:${c.name}@${c.line}-${c.end}`).join(', ')}]`);
  assert.deepStrictEqual(flat, [
    'Settings 1-5 [resource:../resources/common.resource@2-2, variables:${CURDIR}${/}vars.py@3-3, library:Browser@4-4]',
    'Variables 6-10 [variable:${BASE URL}@7-7, variable:@{USERS}@8-8]',
    'Test Cases 11-26 [test:Login@12-23, test:Other@24-26]',
    'Keywords 27-31 [keyword:Open ${page} Page@28-31]',
  ]);
});

test('unresolved variables', () => {
  const lines = [
    '*** Settings ***',
    'Documentation    Uses ${NOT CHECKED} in docs',
    'Suite Setup    Log    ${MISSING SUITE}',
    '',
    '*** Variables ***',
    '${BASE}    https://x',
    '${FULL}    ${BASE}/login ${UNDEFINED IN VAR}',
    '',
    '*** Test Cases ***',
    'Uses Variables',
    '    [Documentation]    About ${doc var}',
    '    ...    still ${documentation}',
    '    ${n}=    Set Variable    1',
    '    Log Many    ${n} ${FULL} ${SPACE * 4} ${CURDIR} %{HOME} ${1} ${TRUE} ${{ 1 + 2 }}',
    '    Log    ${typo} \\${escaped} ${dict_${n}} ${obj.attr}',
    '    VAR    ${shared}    x    scope=SUITE',
    '    # ${in comment}',
    '',
    '*** Keywords ***',
    'Count ${count:\\d+} Items',
    '    [Arguments]    ${limit}=${count}',
    '    Log    ${count} ${limit} ${shared} ${n}',
  ];
  assert.deepStrictEqual(nav.unresolvedVariables(lines).map((u) => `${u.line}:${u.start}-${u.end} ${u.name}`), [
    '3:22-38 ${MISSING SUITE}',
    '7:25-44 ${UNDEFINED IN VAR}',
    '15:11-18 ${typo}',
    '15:44-55 ${obj.attr}',
    '22:39-43 ${n}',
  ]);
  assert.deepStrictEqual(nav.unresolvedVariables(lines).find((u) => u.name === '${obj.attr}').keys, ['obj.attr', 'obj']);
  assert.deepStrictEqual(nav.runtimeVariableKeys(lines), ['shared']);
  assert.deepStrictEqual(nav.variableUses('${a_${b}} ${{ $x }} \\${c} @{d}[0]').map((u) => u.name), ['${b}', '@{d}']);
});

test('dynamic and JSON variable files', () => {
  assert.ok(nav.isDynamicVariableFile('vars.py', ['def get_variables(env):', '    return {}']));
  assert.ok(nav.isDynamicVariableFile('vars.py', ['from common import *']));
  assert.ok(nav.isDynamicVariableFile('vars.toml', []));
  assert.ok(!nav.isDynamicVariableFile('vars.py', ['A = 1']));
  const json = nav.variableFileDefinitions('vars.json', ['{', '  "base url": "https://x",', '  "users": ["a"]', '}']);
  assert.deepStrictEqual(json.map((d) => [d.key, d.line, d.start, d.values[0]]), [['baseurl', 2, 2, '"https://x"'], ['users', 3, 2, '["a"]']]);
});
