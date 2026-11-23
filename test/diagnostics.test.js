'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createDiagnostics, usesTemplate } = require('../src/renderer/editor/diagnostics');
const { setKeywords } = require('../src/renderer/editor/keywordCatalog');

const MarkerSeverity = { Error: 8, Warning: 4, Info: 2 };

function modelOf(lines, { language = 'robotframework', version = 1 } = {}) {
  const model = {
    version,
    disposed: false,
    getValue: () => lines.join('\n'),
    getLinesContent: () => lines,
    getVersionId: () => model.version,
    isDisposed: () => model.disposed,
    getLanguageId: () => language,
  };
  return model;
}

function setup({ files = {}, project = { runtime: [], suite: [], dynamicSuite: false }, check = { ok: true, problems: [] }, lint = { available: true, problems: [] } } = {}) {
  const markers = new Map();
  const calls = { projectVariables: 0, lintUnavailable: 0, lint: 0 };
  const monaco = {
    MarkerSeverity,
    editor: { setModelMarkers: (_model, owner, list) => markers.set(owner, list) },
  };
  const diagnostics = createDiagnostics(monaco, {
    language: 'robotframework',
    firstExisting: async (paths) => paths.filter((p) => p in files).map((path) => ({ path, lines: files[path] }))[0] || null,
    projectVariables: async () => { calls.projectVariables++; return project; },
    checkFile: async () => (typeof check === 'function' ? check() : check),
    lintFile: async () => { calls.lint++; return lint; },
    onLintUnavailable: () => calls.lintUnavailable++,
  });
  return { diagnostics, markers, calls };
}

const CLICK = { name: 'Click', library: 'Browser', args: [{ name: 'selector', kind: 'POSITIONAL_OR_NAMED', required: true, repr: 'selector' }] };
const LOG = { name: 'Log', library: 'BuiltIn', args: [{ name: 'message', kind: 'POSITIONAL_OR_NAMED', required: true, repr: 'message' }] };

test('usesTemplate finds suite and test templates', () => {
  assert.strictEqual(usesTemplate(['*** Settings ***', 'Test Template    Login']), true);
  assert.strictEqual(usesTemplate(['*** Test Cases ***', 'Case', '    [Template]    Login']), true);
  assert.strictEqual(usesTemplate(['*** Test Cases ***', 'Case', '    Log    [Template]']), false);
});

test('keyword markers warn about unknown keywords and flag argument errors', () => {
  setKeywords([CLICK, LOG]);
  const { diagnostics } = setup();
  const markers = diagnostics.keywordMarkers(modelOf(['*** Test Cases ***', 'Case', '    Click', '    Missing Thing', '    ${x}=    Log    a']));
  assert.deepStrictEqual(markers, [
    { severity: MarkerSeverity.Error, message: "Keyword 'Browser.Click' expected 1 argument, got 0.", startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 10, source: 'keywords' },
    { severity: MarkerSeverity.Warning, message: "No keyword with name 'Missing Thing' found.", startLineNumber: 4, startColumn: 5, endLineNumber: 4, endColumn: 18, source: 'keywords' },
  ]);
});

test('keyword markers stay silent with an incomplete catalog or test templates', () => {
  const { diagnostics } = setup();
  setKeywords([CLICK], { complete: false });
  assert.deepStrictEqual(diagnostics.keywordMarkers(modelOf(['*** Test Cases ***', 'Case', '    Missing'])), []);
  setKeywords([CLICK]);
  assert.deepStrictEqual(diagnostics.keywordMarkers(modelOf(['*** Settings ***', 'Test Template    Click', '*** Test Cases ***', 'Case    x'])), []);
});

test('validate sets markers per source and maps Robot and Robocop severities', async () => {
  setKeywords([LOG]);
  const { diagnostics, markers } = setup({
    check: { ok: true, problems: [{ severity: 'error', message: 'Bad', line: 1, column: 1, endLine: 1, endColumn: 4 }, { severity: 'warning', message: 'Odd', line: 2, column: 1, endLine: 2, endColumn: 2 }] },
    lint: { available: true, problems: [
      { severity: 'E', message: 'Too long', rule: 'LEN01', name: 'too-long', line: 3, column: 5, endLine: 3, endColumn: 5 },
      { severity: 'W', message: 'Style', rule: 'NAME02', name: 'wrong-case', line: 2, column: 1, endLine: 2, endColumn: 6 },
    ] },
  });
  await diagnostics.validate(modelOf(['*** Test Cases ***', 'Case', '    Log    ${missing}']), 'tests/a.robot');
  assert.deepStrictEqual(markers.get('robot').map((m) => [m.severity, m.message, m.source]), [[MarkerSeverity.Error, 'Bad', 'Robot Framework'], [MarkerSeverity.Warning, 'Odd', 'Robot Framework']]);
  assert.deepStrictEqual(markers.get('robocop'), [
    { severity: MarkerSeverity.Warning, message: 'Too long', code: 'LEN01 too-long', startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 6, source: 'robocop' },
    { severity: MarkerSeverity.Info, message: 'Style', code: 'NAME02 wrong-case', startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 6, source: 'robocop' },
  ]);
  assert.deepStrictEqual(markers.get('variables').map((m) => m.message), ["Variable '${missing}' is not defined in this file or its imports."]);
  assert.deepStrictEqual(markers.get('keywords'), []);
});

test('variables from imports and from the project at run time are known', async () => {
  setKeywords([LOG]);
  const files = { 'resources/vars.resource': ['*** Variables ***', '${FROM_RESOURCE}    1'] };
  const { diagnostics, markers } = setup({ files, project: { runtime: ['fromcli'], suite: ['suitevar'], dynamicSuite: false } });
  const lines = ['*** Settings ***', 'Resource    ../resources/vars.resource', '*** Test Cases ***', 'Case',
    '    Log    ${FROM_RESOURCE} ${from_cli} ${suite_var}'];
  await diagnostics.validate(modelOf(lines), 'tests/a.robot');
  assert.deepStrictEqual(markers.get('variables').map((m) => m.message), ["Variable '${suite_var}' is not defined in this file or its imports."]);
  // A resource also sees the variables of the suites that import it.
  await diagnostics.validate(modelOf(lines), 'resources/b.resource');
  assert.deepStrictEqual(markers.get('variables'), []);
  // A missing import: undefined variables cannot be told apart.
  await diagnostics.validate(modelOf(['*** Settings ***', 'Resource    gone.resource', '*** Test Cases ***', 'Case', '    Log    ${x}']), 'tests/a.robot');
  assert.deepStrictEqual(markers.get('variables'), []);
});

test('project variables are read once until reset', async () => {
  const { diagnostics, calls } = setup();
  const model = modelOf(['*** Test Cases ***', 'Case', '    Log    ${x}']);
  await diagnostics.validate(model, 'a.robot');
  await diagnostics.validate(model, 'a.robot');
  assert.strictEqual(calls.projectVariables, 1);
  diagnostics.resetProjectVariables();
  await diagnostics.validate(model, 'a.robot');
  assert.strictEqual(calls.projectVariables, 2);
});

test('an unavailable Robocop is reported once, until it works again or lint is switched', async () => {
  const lint = { available: false };
  const { diagnostics, calls, markers } = setup({ lint });
  const model = modelOf(['*** Test Cases ***', 'Case']);
  await diagnostics.validate(model, 'a.robot');
  await diagnostics.validate(model, 'a.robot');
  assert.strictEqual(calls.lintUnavailable, 1);
  assert.deepStrictEqual(markers.get('robocop'), []);
  diagnostics.setLintEnabled(true);
  await diagnostics.validate(model, 'a.robot');
  assert.strictEqual(calls.lintUnavailable, 2);
  diagnostics.setLintEnabled(false);
  const before = calls.lint;
  await diagnostics.validate(model, 'a.robot');
  assert.strictEqual(calls.lint, before);
});

test('validate drops results for an edited model and explains a check that could not run', async () => {
  let model;
  const { diagnostics, markers } = setup({ check: () => { model.version++; return { ok: true, problems: [] }; } });
  model = modelOf(['*** Test Cases ***', 'Case']);
  await diagnostics.validate(model, 'a.robot');
  assert.ok(!markers.has('robot'));

  const failing = setup({ check: { ok: false, problems: [], error: 'No Python\nline 2\nline 3\nline 4\nline 5' } });
  await failing.diagnostics.validate(modelOf(['*** Test Cases ***']), 'a.robot');
  assert.deepStrictEqual(failing.markers.get('robot'), [{
    severity: MarkerSeverity.Info, message: 'Keywright could not check this file with Robot Framework: No Python\nline 2\nline 3\nline 4',
    startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1, source: 'Keywright',
  }]);
  const other = setup();
  await other.diagnostics.validate(modelOf(['x'], { language: 'python' }), 'lib.py');
  assert.strictEqual(other.markers.size, 0);
});

test('fileMarkers checks a closed file and toProblem names the severity', async () => {
  setKeywords([LOG]);
  const { diagnostics } = setup({ check: { ok: true, problems: [{ severity: 'error', message: 'Bad', line: 1, column: 1, endLine: 1, endColumn: 2 }] } });
  const markers = await diagnostics.fileMarkers('a.robot', '*** Test Cases ***\r\nCase\r\n    Nope');
  assert.deepStrictEqual(markers.map((m) => m.source), ['Robot Framework', 'keywords']);
  assert.deepStrictEqual(markers.map(diagnostics.toProblem), [
    { severity: 'error', message: 'Bad', line: 1, column: 1, source: 'Robot Framework', code: undefined },
    { severity: 'warning', message: "No keyword with name 'Nope' found.", line: 3, column: 5, source: 'keywords', code: undefined },
  ]);
  assert.strictEqual(diagnostics.toProblem({ severity: MarkerSeverity.Info, message: 'm', startLineNumber: 1, startColumn: 1, source: 'robocop', code: 7 }).code, '7');
});
