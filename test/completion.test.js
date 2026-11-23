'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { completionProvider, snippetFor } = require('../src/renderer/editor/completion');
const { sectionAt, keywordCellAt } = require('../src/renderer/editor/modelCells');
const { setKeywords } = require('../src/renderer/editor/keywordCatalog');

// The parts of Monaco the provider uses.
const monaco = {
  Range: class {
    constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
      Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn });
    }
  },
  languages: {
    CompletionItemKind: { Module: 'module', Function: 'function', Snippet: 'snippet', Property: 'property' },
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
  },
};
const modelOf = (lines) => ({ getLineContent: (n) => lines[n - 1] });
const complete = (lines, lineNumber, column) => completionProvider(monaco).provideCompletionItems(modelOf(lines), { lineNumber, column });
const labels = (result) => result.suggestions.map((s) => (typeof s.label === 'string' ? s.label : s.label.label));

const args = (...specs) => specs.map(([name, required, kind = 'POSITIONAL_OR_NAMED']) => ({ name, required, kind, repr: name }));

test('sectionAt reads the nearest section header above the line', () => {
  const model = modelOf(['*** Settings ***', 'Library    Browser', '*** Test Cases ***', 'Case', '    Click']);
  assert.strictEqual(sectionAt(model, 1), 'none');
  assert.strictEqual(sectionAt(model, 2), 'settings');
  assert.strictEqual(sectionAt(model, 5), 'tests');
});

test('keywordCellAt finds the keyword cell under the cursor, including its end', () => {
  const model = modelOf(['*** Test Cases ***', 'Case', '    Click    #button']);
  assert.strictEqual(keywordCellAt(model, { lineNumber: 3, column: 5 }).text, 'Click');
  assert.strictEqual(keywordCellAt(model, { lineNumber: 3, column: 10 }).text, 'Click');
  assert.strictEqual(keywordCellAt(model, { lineNumber: 3, column: 16 }), null);
});

test('snippetFor turns embedded and required positional arguments into placeholders', () => {
  assert.strictEqual(snippetFor({ name: 'Click', args: args(['selector', true], ['button', false]) }), 'Click    ${1:selector}');
  assert.strictEqual(snippetFor({ name: 'Open ${page:\\w+} Page', args: args(['timeout', true]) }), 'Open ${1:page} Page    ${2:timeout}');
  assert.strictEqual(snippetFor({ name: 'Log', args: args(['message', true], ['tags', true, 'NAMED_ONLY'], ['rest', true, 'VAR_POSITIONAL']) }),
    'Log    ${1:message}');
  // Snippet syntax characters stay literal.
  assert.strictEqual(snippetFor({ name: 'Pay $5 {now}', args: [] }), 'Pay \\$5 {now\\}');
});

test('a line starting with * offers the section headers', () => {
  const result = complete(['*'], 1, 2);
  assert.deepStrictEqual(labels(result), ['*** Settings ***', '*** Variables ***', '*** Test Cases ***', '*** Tasks ***', '*** Keywords ***', '*** Comments ***']);
  assert.deepStrictEqual(result.suggestions[0].range, new monaco.Range(1, 1, 1, 2));
});

test('settings are offered per section', () => {
  assert.ok(labels(complete(['*** Settings ***', 'Li'], 2, 3)).includes('Suite Setup'));
  assert.ok(labels(complete(['*** Keywords ***', 'Kw', '    [Ar'], 3, 8)).includes('[Arguments]'));
  const test = labels(complete(['*** Test Cases ***', 'Case', '    [Ta'], 3, 8));
  assert.ok(test.includes('[Template]'));
  assert.ok(!test.includes('[Arguments]'));
});

test('keyword cells offer the catalog, ordered user, library, BuiltIn, then block snippets', () => {
  setKeywords([
    { name: 'No Operation', library: 'BuiltIn', args: [], shortdoc: 'Does nothing.' },
    { name: 'Click', library: 'Browser', args: args(['selector', true]) },
    { name: 'Login', library: 'common', user: true, source: 'common.resource', args: [] },
  ]);
  const result = complete(['*** Test Cases ***', 'Case', '    Cl'], 3, 7);
  const click = result.suggestions.find((s) => s.filterText === 'Click');
  assert.deepStrictEqual(click.label, { label: 'Click', description: 'Browser' });
  assert.strictEqual(click.detail, 'Click    selector');
  assert.strictEqual(click.insertText, 'Click    ${1:selector}');
  assert.deepStrictEqual(click.range, new monaco.Range(3, 5, 3, 7));
  const sorted = [...result.suggestions].sort((a, b) => a.sortText.localeCompare(b.sortText)).map((s) => s.filterText || s.label);
  assert.deepStrictEqual(sorted.slice(0, 3), ['Login', 'Click', 'No Operation']);
  assert.ok(labels(result).includes('FOR'));
  assert.strictEqual(result.suggestions.find((s) => s.label.label === 'Login').label.description, 'common.resource');
  // Block snippets only in tests and keywords.
  assert.ok(!labels(complete(['*** Settings ***', 'Suite Setup    No'], 2, 18)).includes('FOR'));
});

test('argument cells get no suggestions', () => {
  setKeywords([{ name: 'Click', library: 'Browser', args: [] }]);
  assert.deepStrictEqual(complete(['*** Test Cases ***', 'Case', '    Click    sel'], 3, 17), { suggestions: [] });
});
