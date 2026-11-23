'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { hoverProviders, documentation } = require('../src/renderer/editor/hover');
const { setKeywords } = require('../src/renderer/editor/keywordCatalog');

const monaco = {
  Range: class {
    constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
      Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn });
    }
  },
};
const modelOf = (path, lines) => ({ path, getLineContent: (n) => lines[n - 1], getLinesContent: () => lines });

function providers(resolveVariable = async () => null) {
  const [keyword, variable] = hoverProviders(monaco, { modelPath: (model) => model.path, resolveVariable });
  return { keyword, variable };
}

test('documentation escapes Markdown in names and fences the signature', () => {
  const kw = { name: 'Click *now*', library: 'My_Lib', args: [{ repr: 'a```b' }], doc: 'Clicks.' };
  const [header, body] = documentation(kw);
  assert.strictEqual(header.value, '**Click \\*now\\*** — My\\_Lib library\n\n````robotframework\nClick *now*    a```b\n````');
  assert.deepStrictEqual(body, { value: 'Clicks.' });
  assert.deepStrictEqual(documentation({ ...kw, doc: '<p>x</p>', docFormat: 'HTML' })[1], { value: '<p>x</p>', supportHtml: true });
  assert.strictEqual(documentation({ ...kw, doc: '' }).length, 1);
  assert.match(documentation({ name: 'Login', user: true, source: 'res/common.resource', args: [] })[0].value, /— keyword in res\/common\\\.resource/);
});

test('keyword hover covers the cell and separates matching keywords', () => {
  setKeywords([
    { name: 'Open App', library: 'one', args: [], doc: 'First.' },
    { name: 'Open App', library: 'two', args: [] },
  ]);
  const model = modelOf('tests/a.robot', ['*** Test Cases ***', 'Case', '    Open App    x']);
  const hover = providers().keyword.provideHover(model, { lineNumber: 3, column: 7 });
  assert.deepStrictEqual(hover.range, new monaco.Range(3, 5, 3, 13));
  assert.deepStrictEqual(hover.contents.map((c) => c.value.split('\n')[0]), ['**Open App** — one library', 'First.', '---', '**Open App** — two library']);
  assert.strictEqual(providers().keyword.provideHover(model, { lineNumber: 3, column: 16 }), null);
  setKeywords([]);
  assert.strictEqual(providers().keyword.provideHover(model, { lineNumber: 3, column: 7 }), null);
});

test('variable hover names environment, built-in and unknown variables', async () => {
  const model = modelOf('tests/a.robot', ['*** Test Cases ***', 'Case', '    Log    %{HOME} ${CURDIR} ${missing}']);
  const { variable } = providers();
  assert.deepStrictEqual(await variable.provideHover(model, { lineNumber: 3, column: 13 }),
    { range: new monaco.Range(3, 12, 3, 19), contents: [{ value: '`%{HOME}` environment variable' }] });
  assert.deepStrictEqual((await variable.provideHover(model, { lineNumber: 3, column: 22 })).contents, [{ value: '`${CURDIR}` built-in variable' }]);
  assert.match((await variable.provideHover(model, { lineNumber: 3, column: 32 })).contents[0].value, /^`\$\{missing\}` is not defined in this file/);
  assert.strictEqual(await variable.provideHover(model, { lineNumber: 3, column: 6 }), null);
});

test('variable hover shows where and how a variable is defined', async () => {
  const lines = ['*** Test Cases ***', 'Case', '    Log    ${user}    ${token}'];
  const model = modelOf('tests/a.robot', lines);
  const calls = [];
  const { variable } = providers(async (path, given, name, line) => {
    calls.push([path, given, name, line]);
    return name === '${user}'
      ? { path: 'resources/common.resource', definition: { name: '${USER}', line: 4, how: 'Variables section', values: ['admin', 'x'] } }
      : { path, definition: { name: '${token}', line: 2, how: 'assignment', from: 'Get Token' } };
  });
  const user = await variable.provideHover(model, { lineNumber: 3, column: 14 });
  assert.deepStrictEqual(user.contents, [{ value: '**${USER}**: Variables section (resources/common.resource:4)\n\n```\n${USER}    admin    x\n```' }]);
  const token = await variable.provideHover(model, { lineNumber: 3, column: 25 });
  assert.deepStrictEqual(token.contents, [{ value: '**${token}**: assigned from `Get Token` (line 2)' }]);
  assert.deepStrictEqual(calls[0], ['tests/a.robot', lines, '${user}', 3]);
});
