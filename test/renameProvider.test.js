'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { renameProvider } = require('../src/renderer/editor/renameProvider');
const { setKeywords } = require('../src/renderer/editor/keywordCatalog');

class Range {
  constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
    Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn });
  }
}
const monaco = { Range };
const LOGIN = { name: 'Login', library: 'common', user: true, source: 'resources/common.resource', lineno: 2, args: [] };
const keywordTarget = { kind: 'keyword', keyword: LOGIN, range: new Range(3, 5, 3, 10), text: 'Login' };

/** A project with open models (path -> { uri, version }) and files on disk (path -> content). */
function setup({ target = keywordTarget, occurrences = new Map(), open = {}, disk = {}, readVersions = {}, failWrite } = {}) {
  const files = new Map(Object.entries(disk).map(([path, content]) => [path, { content, revision: `r-${path}` }]));
  const writes = [];
  const statuses = [];
  const disposed = [];
  const provider = renameProvider(monaco, {
    symbols: {
      renameTarget: async () => target,
      projectContents: async () => new Map(),
      symbolOccurrences: async () => occurrences,
    },
    openModel: (path) => (open[path] ? { uri: `uri:${path}`, getVersionId: () => open[path] } : null),
    readVersion: (path) => readVersions[path],
    readFile: async (path) => files.get(path) || { content: null, reason: 'not found' },
    writeFile: async (path, content, revision) => {
      writes.push([path, content, revision]);
      if (failWrite === path && content !== files.get(path)?.content)
        return { ok: false };
      return { ok: true, revision: `${revision}+` };
    },
    disposePreviews: (paths) => disposed.push(...paths),
    status: (text) => statuses.push(text),
  });
  return { provider, writes, statuses, disposed };
}

test('resolveRenameLocation explains why nothing can be renamed', async () => {
  assert.deepStrictEqual(await setup({ target: null }).provider.resolveRenameLocation(), { rejectReason: 'Only keywords and variables can be renamed.' });
  assert.deepStrictEqual(await setup({ target: { reject: 'No.' } }).provider.resolveRenameLocation(), { rejectReason: 'No.' });
  assert.deepStrictEqual(await setup().provider.resolveRenameLocation(), { range: keywordTarget.range, text: 'Login' });
});

test('invalid, unchanged and conflicting names produce no edits', async () => {
  setKeywords([LOGIN, { ...LOGIN, name: 'Logout', source: 'resources/other.resource' }]);
  const { provider, writes } = setup({ disk: { 'resources/common.resource': '*** Keywords ***\nLogin\n' } });
  assert.deepStrictEqual(await provider.provideRenameEdits(null, null, 'Login'), { edits: [] });
  assert.ok((await provider.provideRenameEdits(null, null, '')).rejectReason);
  assert.deepStrictEqual(await provider.provideRenameEdits(null, null, 'logout'),
    { edits: [], rejectReason: "A keyword named 'Logout' already exists in resources/other.resource." });
  assert.deepStrictEqual(await setup({ target: { reject: 'Library keyword.' } }).provider.provideRenameEdits(null, null, 'X'),
    { edits: [], rejectReason: 'Library keyword.' });
  assert.deepStrictEqual(writes, []);
});

test('open files get workspace edits at the version read; closed files are written with their line endings', async () => {
  setKeywords([LOGIN]);
  const occurrences = new Map([
    ['tests/open.robot', [{ line: 3, start: 4, end: 9 }, { line: 4, start: 12, end: 17 }]],
    ['resources/common.resource', [{ line: 2, start: 0, end: 5 }]],
  ]);
  const { provider, writes, statuses, disposed } = setup({
    occurrences,
    open: { 'tests/open.robot': 9 },
    readVersions: { 'tests/open.robot': 7 },
    disk: { 'resources/common.resource': '*** Keywords ***\r\nLogin\r\n    No Operation' },
  });
  const result = await provider.provideRenameEdits(null, null, 'Sign In');
  assert.deepStrictEqual(result.edits, [
    { resource: 'uri:tests/open.robot', versionId: 7, textEdit: { range: new Range(3, 5, 3, 10), text: 'Sign In' } },
    { resource: 'uri:tests/open.robot', versionId: 7, textEdit: { range: new Range(4, 13, 4, 18), text: 'Sign In' } },
  ]);
  assert.deepStrictEqual(writes, [['resources/common.resource', '*** Keywords ***\r\nSign In\r\n    No Operation', 'r-resources/common.resource']]);
  assert.deepStrictEqual(disposed, ['resources/common.resource']);
  assert.deepStrictEqual(statuses, ["Renamed 'Login' to 'Sign In': 3 occurrences in 2 files, 1 saved; open files have unsaved changes"]);
});

test('without a recorded read the open model version is used, and Python expressions get an identifier', async () => {
  const variable = { kind: 'variable', text: 'user name', range: new Range(1, 1, 1, 1) };
  const { provider, statuses } = setup({
    target: variable,
    occurrences: new Map([['tests/a.robot', [{ line: 2, start: 6, end: 15 }, { line: 3, start: 10, end: 19, expression: true }]]]),
    open: { 'tests/a.robot': 4 },
  });
  const { edits } = await provider.provideRenameEdits(null, null, 'login name');
  assert.deepStrictEqual(edits.map((e) => [e.versionId, e.textEdit.text]), [[4, 'login name'], [4, 'login_name']]);
  assert.deepStrictEqual(statuses, ["Renamed 'user name' to 'login name': 2 occurrences in 1 file; open files have unsaved changes"]);
});

test('a failed write puts back the files already written', async () => {
  setKeywords([LOGIN]);
  const { provider, writes, statuses, disposed } = setup({
    occurrences: new Map([
      ['a.resource', [{ line: 1, start: 0, end: 5 }]],
      ['b.resource', [{ line: 1, start: 0, end: 5 }]],
    ]),
    disk: { 'a.resource': 'Login', 'b.resource': 'Login' },
    failWrite: 'b.resource',
  });
  assert.deepStrictEqual(await provider.provideRenameEdits(null, null, 'Sign In'),
    { edits: [], rejectReason: 'b.resource changed on disk. Reload the file and try renaming again. No file was changed.' });
  assert.deepStrictEqual(writes, [
    ['a.resource', 'Sign In', 'r-a.resource'],
    ['b.resource', 'Sign In', 'r-b.resource'],
    ['a.resource', 'Login', 'r-a.resource+'],
  ]);
  assert.deepStrictEqual([statuses, disposed], [[], []]);
});

test('an unreadable closed file stops the rename before anything is written', async () => {
  setKeywords([LOGIN]);
  const { provider, writes } = setup({
    occurrences: new Map([['a.resource', [{ line: 1, start: 0, end: 5 }]], ['gone.resource', [{ line: 1, start: 0, end: 5 }]]]),
    disk: { 'a.resource': 'Login' },
  });
  assert.deepStrictEqual(await provider.provideRenameEdits(null, null, 'Sign In'), { edits: [], rejectReason: 'gone.resource: not found' });
  assert.deepStrictEqual(writes, []);
});
