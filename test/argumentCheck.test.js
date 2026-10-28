'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { collectCalls, checkCall, splitFromEquals } = require('../src/renderer/editor/argumentCheck');
const { runHelper } = require('../src/main/pythonHelper');
const { tempDir } = require('./helpers/tempDir');

// Argument specs as produced by libdoc (see rfide_runner.py `_args`).
const arg = (name, kind, required = true) => ({ name, kind, required });
const CLICK = { name: 'Click', library: 'Browser', args: [arg('selector', 'POSITIONAL_OR_NAMED'), arg('button', 'POSITIONAL_OR_NAMED', false)] };
const NEW_CONTEXT = { name: 'New Context', library: 'Browser', args: [arg('', 'NAMED_ONLY_MARKER', false), arg('viewport', 'NAMED_ONLY', false)] };
const LOG_MANY = { name: 'Log Many', library: 'BuiltIn', args: [arg('messages', 'VAR_POSITIONAL', false)] };
const WITH_KWARGS = { name: 'Configure', library: 'Lib', args: [arg('name', 'POSITIONAL_OR_NAMED'), arg('options', 'VAR_NAMED', false)] };
const NEEDS_TOKENS = { name: 'Login', user: true, args: [arg('user', 'POSITIONAL_OR_NAMED'), arg('token', 'NAMED_ONLY'), arg('otp', 'NAMED_ONLY')] };

function problems(line, kw) {
  const [call] = collectCalls(['*** Test Cases ***', 'T', line]);
  return checkCall(call, kw).map((p) => `${p.message} @${p.cell.text}`);
}

test('collectCalls joins continuation lines and skips comments', () => {
  const calls = collectCalls([
    '*** Settings ***',
    'Suite Setup    New Browser    chromium',
    '*** Test Cases ***',
    'T',
    '    ${x}=    Get Text    \\#out',
    '    # a comment between',
    '    ...    ==    Hello',
    '    FOR    ${i}    IN RANGE    2',
    '        Log    ${i}',
    '    END',
  ]);
  assert.deepStrictEqual(calls.map((c) => [c.keyword.text, c.args.map((a) => a.text)]), [
    ['New Browser', ['chromium']],
    ['Get Text', ['\\#out', '==', 'Hello']],
    ['Log', ['${i}']],
  ]);
  assert.deepStrictEqual(calls[1].args.map((a) => a.line), [5, 7, 7]);
});

test('splitFromEquals ignores escaped "=" and "=" inside variables', () => {
  assert.strictEqual(splitFromEquals('name=value'), 'name');
  assert.strictEqual(splitFromEquals('no equals'), null);
  assert.strictEqual(splitFromEquals('a\\=b'), null);
  assert.strictEqual(splitFromEquals('${x=y}'), null);
  assert.strictEqual(splitFromEquals('${x=y}=z'), '${x=y}');
});

test('valid calls', () => {
  assert.deepStrictEqual(problems('    Click    \\#login    right', CLICK), []);
  assert.deepStrictEqual(problems('    Click    selector=\\#login    button=right', CLICK), []);
  assert.deepStrictEqual(problems('    Click    css=button.primary', CLICK), []); // unknown name: positional
  assert.deepStrictEqual(problems('    Log Many    a    b    c', LOG_MANY), []);
  assert.deepStrictEqual(problems("    New Context    viewport={'width': 800}", NEW_CONTEXT), []);
  assert.deepStrictEqual(problems('    Configure    x    anything=1', WITH_KWARGS), []);
  assert.deepStrictEqual(problems('    Click    @{args}', CLICK), []);
});

test('first error, with Robot\'s messages', () => {
  assert.deepStrictEqual(problems('    Click', CLICK), ["Keyword 'Browser.Click' expected 1 to 2 arguments, got 0. @Click"]);
  assert.deepStrictEqual(problems('    Click    a    left    extra', CLICK), ["Keyword 'Browser.Click' expected 1 to 2 arguments, got 3. @extra"]);
  assert.deepStrictEqual(problems('    New Context    800x600', NEW_CONTEXT), ["Keyword 'Browser.New Context' expected 0 non-named arguments, got 1. @800x600"]);
  assert.deepStrictEqual(problems('    Click    button=left    \\#login', CLICK), ["Keyword 'Browser.Click' got positional argument after named arguments. @\\#login"]);
  assert.deepStrictEqual(problems('    Click    \\#login    selector=\\#other', CLICK), ["Keyword 'Browser.Click' got multiple values for argument 'selector'. @selector=\\#other"]);
  assert.deepStrictEqual(problems('    Click    button=left', CLICK), ["Keyword 'Browser.Click' missing value for argument 'selector'. @Click"]);
  assert.deepStrictEqual(problems('    Click    x    button=left    foo=bar', CLICK), ["Keyword 'Browser.Click' got unexpected named argument 'foo'. @foo=bar"]);
  assert.deepStrictEqual(problems('    Login    ada', NEEDS_TOKENS), ["Keyword 'Login' missing named-only arguments 'otp' and 'token'. @Login"]);
});

test('user keyword names in messages', () => {
  const fromResource = { name: 'Open App', user: true, library: 'common', source: 'resources/common.resource', args: [arg('url', 'POSITIONAL_OR_NAMED')] };
  const local = { ...fromResource, library: 'login', source: 'tests/login.robot' };
  assert.deepStrictEqual(problems('    Open App', fromResource), ["Keyword 'common.Open App' expected 1 argument, got 0. @Open App"]);
  assert.deepStrictEqual(problems('    Open App', local), ["Keyword 'Open App' expected 1 argument, got 0. @Open App"]);
});

// Compares the editor's messages with Robot's on real keywords.
const root = path.join(__dirname, '..');
const python = process.env.RFIDE_PYTHON || [
  path.join(root, '.venv', 'Scripts', 'python.exe'),
  path.join(root, '.venv', 'bin', 'python'),
].find((p) => fs.existsSync(p));

test('messages match Robot Framework', { skip: !python && 'no Python with robotframework-browser', timeout: 120_000 }, async () => {
  const docs = await runHelper(python, ['libdoc', 'BuiltIn', 'Browser']);
  const keywords = new Map(docs.libraries.flatMap((lib) => lib.keywords.map((kw) => [kw.name, kw])));
  const calls = [
    'Click',
    'Click    a    left    extra',
    'Click    button=left    \\#login',
    'Click    \\#login    selector=\\#other',
    'Click    button=left',
    'Click    x    button=left    foo=bar',
    'New Context    800x600',
    'Get Text    \\#out    ==    x    msg    extra',
    'Should Be Equal    1',
    'Should Be Equal    1    1    msg=m    values=True    nope=1',
    'Log    hello    level=INFO    html=False    console=False    repr=False    formatter=str    extra=1',
  ];
  const source = ['*** Settings ***', 'Library    Browser', '', '*** Test Cases ***',
    ...calls.flatMap((call, i) => [`Case ${i}`, `    ${call}`])].join('\n');
  const dir = tempDir('args');
  fs.writeFileSync(path.join(dir, 'args.robot'), source);
  const run = spawnSync(python, ['-m', 'robot', '--dryrun', '--output', 'out.xml', '--log', 'NONE', '--report', 'NONE', 'args.robot'],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  const xml = fs.readFileSync(path.join(dir, 'out.xml'), 'utf8');

  for (const [i, call] of calls.entries()) {
    const [parsed] = collectCalls(['*** Test Cases ***', 'T', `    ${call}`]);
    const ours = checkCall(parsed, keywords.get(parsed.keyword.text)).map((p) => p.message);
    const test = new RegExp(`<test [^>]*name="Case ${i}"[\\s\\S]*?<status status="(\\w+)"[^>]*>([^<]*)</status>\\s*</test>`).exec(xml);
    assert.ok(test, `no result for case ${i}\n${run.stdout}`);
    const robot = test[1] === 'FAIL' ? [test[2].replace(/&apos;/g, "'").replace(/&quot;/g, '"')] : [];
    assert.deepStrictEqual(ours, robot, `case ${i}: ${call}`);
  }
});
