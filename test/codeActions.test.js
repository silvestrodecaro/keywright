'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { codeActionProvider, createKeywordCommand } = require('../src/renderer/editor/codeActions');
const { setKeywords } = require('../src/renderer/editor/keywordCatalog');

class Range {
  constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
    Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn });
  }
}
const monaco = { Range };

function modelOf(path, lines) {
  const pushed = [];
  return {
    path,
    pushed,
    uri: `uri:${path}`,
    getVersionId: () => 3,
    getLinesContent: () => lines,
    getLineContent: (n) => lines[n - 1],
    getLineCount: () => lines.length,
    getLineMaxColumn: (n) => lines[n - 1].length + 1,
    pushEditOperations: (_selections, edits) => pushed.push(...edits),
  };
}
const marker = (message, line, start, end, extra = {}) => ({ message, startLineNumber: line, startColumn: start, endLineNumber: line, endColumn: end, ...extra });

function provider(files = {}, imported = { keys: new Set(), names: [], unknown: false }) {
  return codeActionProvider(monaco, {
    modelPath: (model) => model.path,
    firstExisting: async (paths) => paths.filter((p) => p in files).map((path) => ({ path, lines: files[path] }))[0] || null,
    importedVariables: async () => imported,
  });
}
const actionsFor = async (p, model, m) => (await p.provideCodeActions(model, null, { markers: [m] })).actions;

test('an unknown keyword offers similar names, keeping a BDD prefix, and creating it here or in imported resources', async () => {
  setKeywords([{ name: 'Click', library: 'Browser', args: [] }, { name: 'Open ${page} Page', library: 'common', args: [] }]);
  const lines = ['*** Settings ***', 'Resource    ../resources/common.resource', '*** Test Cases ***', 'Case', '    Given Clik    #a'];
  const model = modelOf('tests/a.robot', lines);
  const actions = await actionsFor(provider({ 'resources/common.resource': [] }), model, marker("No keyword with name 'Given Clik' found.", 5, 5, 15));
  assert.deepStrictEqual(actions.map((a) => a.title), [
    "Change to 'Click'", "Create keyword 'Clik' in this file", "Create keyword 'Clik' in resources/common.resource",
  ]);
  assert.deepStrictEqual(actions[0].edit.edits, [{ resource: 'uri:tests/a.robot', versionId: 3, textEdit: { range: new Range(5, 5, 5, 15), text: 'Given Click' } }]);
  assert.strictEqual(actions[0].isPreferred, true);
  assert.deepStrictEqual(actions[2].command, { id: 'keywright.createKeyword', title: "Create keyword 'Clik' in resources/common.resource",
    arguments: [{ path: 'resources/common.resource', stub: ['Clik', '    Fail    Not implemented'] }] });
});

test('an undefined variable offers similar visible names and a definition in the Variables section', async () => {
  const lines = ['*** Variables ***', '${USERNAME}    me', '*** Test Cases ***', 'Case', '    Log    ${usernam}'];
  const model = modelOf('tests/a.robot', lines);
  const actions = await actionsFor(provider({}, { keys: new Set(), names: ['${PASSWORD}'], unknown: false }), model,
    marker("Variable '${usernam}' is not defined in this file or its imports.", 5, 12, 22));
  assert.deepStrictEqual(actions.map((a) => a.title), ['Change to ${USERNAME}', 'Define ${usernam} in the Variables section']);
  assert.deepStrictEqual(actions[0].edit.edits[0].textEdit, { range: new Range(5, 14, 5, 21), text: 'USERNAME' });
  assert.strictEqual(actions[1].edit.edits[0].textEdit.text.includes('${usernam}    ${EMPTY}'), true);
});

test('Robocop rules are disabled on the line or for the file, joining an existing disabler', async () => {
  const p = provider();
  const plain = modelOf('a.robot', ['*** Test Cases ***', 'Case', '    Log    x   ']);
  const lint = marker('Too long', 3, 5, 8, { source: 'robocop', code: 'LEN01 line-too-long' });
  const [line, file] = await actionsFor(p, plain, lint);
  assert.deepStrictEqual([line.title, file.title], ['Disable line-too-long on this line', 'Disable line-too-long in this file']);
  assert.deepStrictEqual(line.edit.edits[0].textEdit, { range: new Range(3, 13, 3, 16), text: '    # robocop: off=line-too-long' });
  assert.deepStrictEqual(file.edit.edits[0].textEdit, { range: new Range(1, 1, 1, 1), text: '# robocop: off=line-too-long\n' });

  const disabled = modelOf('a.robot', ['# robocop: off=a-rule', '*** Test Cases ***', '    Log    x    # robocop: off=other']);
  const [onLine, inFile] = await actionsFor(p, disabled, lint);
  assert.deepStrictEqual(onLine.edit.edits[0].textEdit, { range: new Range(3, 37, 3, 37), text: ', line-too-long' });
  assert.deepStrictEqual(inFile.edit.edits[0].textEdit, { range: new Range(1, 22, 1, 22), text: ', line-too-long' });
  assert.deepStrictEqual(await actionsFor(p, plain, marker('x', 1, 1, 1, { source: 'robocop', code: 'ONLYRULE' })), []);
});

test('a block without END gets a preferred Add END fix; other markers get none', async () => {
  const p = provider();
  const model = modelOf('a.robot', ['*** Test Cases ***', 'Case', '    FOR    ${i}    IN    a', '        Log    ${i}']);
  const [fix] = await actionsFor(p, model, marker("FOR loop must have closing END.", 3, 5, 8));
  assert.deepStrictEqual([fix.title, fix.isPreferred, fix.edit.edits[0].textEdit], ['Add END', true, { range: new Range(4, 20, 4, 20), text: '\n    END' }]);
  assert.deepStrictEqual(await actionsFor(p, model, marker('Something else', 1, 1, 2)), []);
});

test('createKeyword edits an open file, or writes a closed one and refreshes its preview', async () => {
  const events = [];
  const writes = [];
  const open = modelOf('tests/a.robot', ['*** Test Cases ***', 'Case', '    Do Thing']);
  const preview = { values: [], setValue: (v) => preview.values.push(v) };
  const disk = { 'resources/b.resource': { content: '*** Keywords ***\r\nOther\r\n    No Operation', revision: 'r1' } };
  const command = createKeywordCommand(monaco, {
    openModel: (path) => (path === 'tests/a.robot' ? open : null),
    previewModel: (path) => (path === 'resources/b.resource' ? preview : null),
    readFile: async (path) => disk[path],
    writeFile: async (path, content, revision) => { writes.push([path, content, revision]); return { ok: path !== 'resources/conflict.resource' }; },
    reveal: (detail) => events.push(['open', detail]),
    status: (text) => events.push(['status', text]),
  });
  const stub = ['Do Thing', '    Fail    Not implemented'];
  await command(null, { path: 'tests/a.robot', stub });
  assert.deepStrictEqual(open.pushed, [{ range: new Range(3, 13, 3, 13), text: '\n\n\n*** Keywords ***\nDo Thing\n    Fail    Not implemented' }]);
  await command(null, { path: 'resources/b.resource', stub });
  assert.deepStrictEqual(writes, [['resources/b.resource', '*** Keywords ***\r\nOther\r\n    No Operation\r\n\r\nDo Thing\r\n    Fail    Not implemented', 'r1']]);
  assert.deepStrictEqual(preview.values, [writes[0][1]]);
  assert.deepStrictEqual(events.map(([kind, detail]) => (kind === 'open' ? [kind, detail.path] : [kind, detail])), [
    ['open', 'tests/a.robot'], ['status', "Created keyword 'Do Thing' in tests/a.robot"],
    ['open', 'resources/b.resource'], ['status', "Created keyword 'Do Thing' in resources/b.resource"],
  ]);
  disk['resources/conflict.resource'] = { content: '', revision: 'r2' };
  await assert.rejects(command(null, { path: 'resources/conflict.resource', stub }), /changed on disk\. Reload the file and create the keyword again\./);
});
