'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { definitionProviders, documentSymbolProvider, referenceProvider } = require('../src/renderer/editor/definitions');
const { createSymbols, filesImporting } = require('../src/renderer/editor/symbols');
const { setKeywords } = require('../src/renderer/editor/keywordCatalog');

class Range {
  constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
    Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn });
  }
}
const monaco = {
  Range,
  languages: { SymbolKind: { Namespace: 'namespace', Method: 'method', Function: 'function', Variable: 'variable', File: 'file', Module: 'module' } },
};

const TEST = [
  '*** Settings ***',
  'Resource    ../resources/common.resource',
  'Variables    vars.py',
  '',
  '*** Variables ***',
  '${HOST}    example.org',
  '',
  '*** Test Cases ***',
  'Case',
  '    Login    ${HOST}',
  '    No Operation',
  '    Log    %{HOME}',
];
const RESOURCE = ['*** Keywords ***', 'Login', '    No Operation'];
const LOGIN = { name: 'Login', library: 'common', user: true, source: 'resources/common.resource', lineno: 2, args: [] };
const NOOP = { name: 'No Operation', library: 'BuiltIn', args: [] };

const modelOf = (path, lines) => ({
  path,
  getLineContent: (n) => lines[n - 1],
  getLinesContent: () => lines,
  getLineMaxColumn: (n) => lines[n - 1].length + 1,
});
const at = (lineNumber, column) => ({ lineNumber, column });
const uriFor = (path) => `uri:${path}`;

function project(files) {
  const contents = new Map(Object.entries(files));
  const ensured = [];
  const deps = {
    modelPath: (model) => model.path,
    readLines: async (path) => contents.get(path) || null,
    projectTree: async () => [...contents.keys()].map((path) => ({ type: 'file', path })),
    ensureModel: async (path) => { ensured.push(path); },
    uriFor,
    firstExisting: async (paths) => paths.filter((p) => contents.has(p)).map((path) => ({ path, lines: contents.get(path) }))[0] || null,
    resolveVariable: async (path, _lines, name) => (name === '${HOST}'
      ? { path, definition: { name: '${HOST}', key: 'host', line: 6, start: 0, end: 7, how: 'variable' } }
      : null),
  };
  return { contents, ensured, deps };
}

test('filesImporting follows resource imports transitively and keeps the target', () => {
  const contents = new Map([
    ['tests/a.robot', TEST],
    ['tests/b.robot', ['*** Test Cases ***', 'Case', '    No Operation']],
    ['tests/c.robot', ['*** Settings ***', 'Resource    ../resources/mid.resource']],
    ['resources/mid.resource', ['*** Settings ***', 'Resource    common.resource']],
    ['resources/common.resource', RESOURCE],
  ]);
  assert.deepStrictEqual(filesImporting('resources/common.resource', contents),
    ['tests/a.robot', 'tests/c.robot', 'resources/mid.resource', 'resources/common.resource']);
});

test('keyword definitions open user keywords only, after preparing their models', async () => {
  setKeywords([LOGIN, NOOP]);
  const { deps, ensured } = project({ 'tests/a.robot': TEST });
  const [keyword] = definitionProviders(monaco, deps);
  const model = modelOf('tests/a.robot', TEST);
  assert.deepStrictEqual(await keyword.provideDefinition(model, at(10, 6)), [{ uri: 'uri:resources/common.resource', range: new Range(2, 1, 2, 1) }]);
  assert.deepStrictEqual(ensured, ['resources/common.resource']);
  assert.deepStrictEqual(await keyword.provideDefinition(model, at(11, 6)), []);
  assert.strictEqual(await keyword.provideDefinition(model, at(10, 14)), null);
});

test('import and variable definitions point at the file or the definition', async () => {
  const { deps, ensured } = project({ 'tests/a.robot': TEST, 'resources/common.resource': RESOURCE });
  const [, other] = definitionProviders(monaco, deps);
  const model = modelOf('tests/a.robot', TEST);
  assert.deepStrictEqual(await other.provideDefinition(model, at(2, 20)), [{
    uri: 'uri:resources/common.resource', range: new Range(1, 1, 1, 1), originSelectionRange: new Range(2, 13, 2, 41),
  }]);
  // A missing import target has no definition.
  assert.strictEqual(await other.provideDefinition(model, at(3, 15)), null);
  assert.deepStrictEqual(await other.provideDefinition(model, at(10, 16)), [{
    uri: 'uri:tests/a.robot', range: new Range(6, 1, 6, 8), originSelectionRange: new Range(10, 14, 10, 21),
  }]);
  assert.strictEqual(await other.provideDefinition(model, at(12, 14)), null);
  assert.deepStrictEqual(ensured, ['resources/common.resource', 'tests/a.robot']);
});

test('the outline maps sections, imports and tests to symbols', () => {
  const symbols = documentSymbolProvider(monaco).provideDocumentSymbols(modelOf('tests/a.robot', TEST));
  assert.deepStrictEqual(symbols.map((s) => [s.name, s.kind]), [['Settings', 'namespace'], ['Variables', 'namespace'], ['Test Cases', 'namespace']]);
  assert.deepStrictEqual(symbols[0].children.map((s) => [s.name, s.kind]), [['../resources/common.resource', 'file'], ['vars.py', 'file']]);
  const testCase = symbols[2].children[0];
  assert.deepStrictEqual([testCase.name, testCase.kind], ['Case', 'method']);
  assert.deepStrictEqual(testCase.range, new Range(9, 1, 12, 19));
  assert.deepStrictEqual(testCase.selectionRange, new Range(9, 1, 9, 5));
});

test('renameTarget resolves user keywords and explains what cannot be renamed', async () => {
  const { deps } = project({ 'tests/a.robot': TEST });
  const { renameTarget } = createSymbols(monaco, deps);
  const model = modelOf('tests/a.robot', TEST);
  setKeywords([LOGIN, NOOP]);
  const login = await renameTarget(model, at(10, 6));
  assert.deepStrictEqual({ ...login, keyword: login.keyword.name }, { kind: 'keyword', keyword: 'Login', range: new Range(10, 5, 10, 10), text: 'Login' });
  const library = await renameTarget(model, at(11, 6));
  assert.strictEqual(library.kind, 'keyword');
  assert.strictEqual(library.reject, "'No Operation' comes from the BuiltIn library: only keywords defined in the project can be renamed.");
  assert.deepStrictEqual(await renameTarget(model, at(12, 14)), { reject: 'Built-in and environment variables cannot be renamed.' });
  const variable = await renameTarget(model, at(10, 16));
  assert.deepStrictEqual([variable.kind, variable.definitionPath, variable.text, variable.reject], ['variable', 'tests/a.robot', 'HOST', undefined]);
  setKeywords([LOGIN, { ...LOGIN, source: 'resources/other.resource' }]);
  assert.match((await renameTarget(model, at(10, 6))).reject, /^2 keywords are named 'Login'/);
  setKeywords([NOOP]);
  assert.deepStrictEqual(await renameTarget(model, at(10, 6)), { reject: "No keyword named 'Login' was found." });
  assert.strictEqual(await renameTarget(model, at(9, 2)), null);
});

test('symbolOccurrences lists a resource keyword in the files that import it', async () => {
  const { deps } = project({ 'tests/a.robot': TEST, 'tests/b.robot': ['*** Test Cases ***', 'Case', '    Login'], 'resources/common.resource': RESOURCE });
  const { projectContents, symbolOccurrences } = createSymbols(monaco, deps);
  const contents = await projectContents();
  assert.deepStrictEqual([...contents.keys()], ['tests/a.robot', 'tests/b.robot', 'resources/common.resource']);
  const occurrences = await symbolOccurrences({ kind: 'keyword', keyword: LOGIN }, contents);
  assert.deepStrictEqual([...occurrences], [
    ['tests/a.robot', [{ line: 10, start: 4, end: 9 }]],
    ['resources/common.resource', [{ line: 2, start: 0, end: 5 }]],
  ]);
});

test('references leave out the declaration unless asked, and add variable file definitions', async () => {
  const { deps, ensured } = project({});
  const keywordTarget = { kind: 'keyword', keyword: LOGIN };
  const symbols = {
    renameTarget: async () => keywordTarget,
    projectContents: async () => new Map(),
    symbolOccurrences: async () => new Map([
      ['tests/a.robot', [{ line: 10, start: 4, end: 9 }]],
      ['resources/common.resource', [{ line: 2, start: 0, end: 5 }]],
    ]),
  };
  const references = referenceProvider(monaco, { ...deps, symbols });
  const ranges = (list) => list.map((l) => [l.uri, l.range.startLineNumber]);
  assert.deepStrictEqual(ranges(await references.provideReferences(null, at(1, 1), { includeDeclaration: false })), [['uri:tests/a.robot', 10]]);
  assert.deepStrictEqual(ranges(await references.provideReferences(null, at(1, 1), { includeDeclaration: true })),
    [['uri:tests/a.robot', 10], ['uri:resources/common.resource', 2]]);
  assert.deepStrictEqual(ensured, ['tests/a.robot', 'resources/common.resource', 'tests/a.robot', 'resources/common.resource']);

  const fromFile = { kind: 'variable', definitionPath: 'vars.py', definition: { how: 'variable file', line: 3, start: 0, end: 4 } };
  const variables = referenceProvider(monaco, { ...deps, symbols: { ...symbols, renameTarget: async () => fromFile, symbolOccurrences: async () => new Map() } });
  assert.deepStrictEqual(await variables.provideReferences(null, at(1, 1), { includeDeclaration: true }), [{ uri: 'uri:vars.py', range: new Range(3, 1, 3, 5) }]);
  assert.deepStrictEqual(await variables.provideReferences(null, at(1, 1), { includeDeclaration: false }), []);

  const none = referenceProvider(monaco, { ...deps, symbols: { ...symbols, renameTarget: async () => ({ reject: 'x' }) } });
  assert.deepStrictEqual(await none.provideReferences(null, at(1, 1), { includeDeclaration: true }), []);
});
