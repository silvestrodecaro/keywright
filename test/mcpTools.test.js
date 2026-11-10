'use strict';

// MCP tools on a project folder: file changes, protection of unsaved editor
// files, keyword search and the summary of a test run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { createTools, RunTracker, within } = require('../src/main/mcp/tools');
const { McpProtocol } = require('../src/main/mcp/protocol');
const { tempDir } = require('./helpers/tempDir');

function setup({ dirty = [], keywords = [] } = {}) {
  const root = tempDir('mcp-tools');
  fs.mkdirSync(path.join(root, 'tests'));
  fs.mkdirSync(path.join(root, 'resources'));
  fs.writeFileSync(path.join(root, 'tests', 'login.robot'), '*** Test Cases ***\r\nLogin\r\n    Log    one\r\n');
  fs.writeFileSync(path.join(root, 'resources', 'app.resource'), '*** Keywords ***\nOpen App\n    No Operation\n');
  const trashed = [];
  const runner = Object.assign(new EventEmitter(), { running: false, stop() { this.stopped = true; } });
  const app = {
    project: () => ({ root, name: 'demo', python: null, config: { testsDir: 'tests', resourcesDir: 'resources', outputDir: 'results' } }),
    dirtyPaths: () => dirty,
    trash: async (entry) => {
      trashed.push(path.relative(root, entry).split(path.sep).join('/'));
      fs.rmSync(entry, { recursive: true });
    },
    keywords: async () => ({ ok: true, keywords }),
    check: async () => ({ ok: true, problems: [{ line: 2, severity: 'ERROR', message: 'Bad' }] }),
    discover: async () => ({ ok: true, suite: { name: 'Tests', source: 'tests', tests: [], suites: [] } }),
    runner,
    startRun: async () => {},
    browser: { open: false },
    browsers: {},
    launchError: (error) => error.message,
  };
  const mcp = new McpProtocol({ name: 'k', version: '1', tools: createTools(app) });
  let id = 0;
  const callTool = async (name, args = {}) => {
    const reply = await mcp.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
    const text = reply.result.content.map((c) => c.text).join('\n');
    return { text, isError: !!reply.result.isError };
  };
  const raw = (name, args = {}) => mcp.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
  return { root, app, runner, trashed, callTool, raw };
}

test('lists, reads, writes and edits project files', async () => {
  const f = setup();
  const list = await f.callTool('list_files');
  assert.deepEqual(list.text.split('\n'), ['resources/', 'resources/app.resource', 'tests/', 'tests/login.robot']);
  assert.match((await f.callTool('read_file', { path: 'tests\\login.robot' })).text, /Log {4}one/);

  assert.equal((await f.callTool('write_file', { path: 'tests/new/flow.robot', content: '*** Test Cases ***\n' })).text, 'tests/new/flow.robot created.');
  assert.equal(fs.readFileSync(path.join(f.root, 'tests/new/flow.robot'), 'utf8'), '*** Test Cases ***\n');
  assert.equal((await f.callTool('write_file', { path: 'tests/new/flow.robot', content: 'x' })).text, 'tests/new/flow.robot updated.');

  // The file uses CRLF; the model sends LF.
  const edit = await f.callTool('edit_file', { path: 'tests/login.robot', old_text: 'Login\n    Log    one', new_text: 'Login\n    Log    two' });
  assert.equal(edit.isError, false, edit.text);
  assert.equal(fs.readFileSync(path.join(f.root, 'tests/login.robot'), 'utf8'), '*** Test Cases ***\r\nLogin\r\n    Log    two\r\n');
  const ambiguous = await f.callTool('edit_file', { path: 'tests/login.robot', old_text: 'o', new_text: '0' });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.text, /occurs \d+ times/);
  assert.match((await f.callTool('edit_file', { path: 'tests/login.robot', old_text: 'absent', new_text: '' })).text, /was not found/);
});

test('refuses paths outside the project', async () => {
  const f = setup();
  const result = await f.callTool('write_file', { path: '../outside.robot', content: 'x' });
  assert.equal(result.isError, true);
  assert.equal(fs.existsSync(path.join(f.root, '..', 'outside.robot')), false);
  assert.equal((await f.callTool('read_file', { path: '../../secret.txt' })).isError, true);
});

test('files with unsaved editor changes are protected, also through their folder', async () => {
  const f = setup({ dirty: ['tests/login.robot'] });
  for (const [tool, args] of [
    ['write_file', { path: 'tests/login.robot', content: '' }],
    ['edit_file', { path: 'tests/login.robot', old_text: 'Login', new_text: 'X' }],
    ['delete_path', { path: 'tests' }],
    ['rename_path', { path: 'tests', new_name: 'suites' }],
  ]) {
    const result = await f.callTool(tool, args);
    assert.equal(result.isError, true, tool);
    assert.match(result.text, /unsaved changes in the Keywright editor/);
  }
  assert.match((await f.callTool('read_file', { path: 'tests/login.robot' })).text, /^\(The Keywright editor has unsaved changes/);
  assert.equal((await f.callTool('write_file', { path: 'tests/other.robot', content: '' })).isError, false);
  assert.equal(within('tests/login.robot', 'tests'), true);
  assert.equal(within('tests-old/a.robot', 'tests'), false);
});

test('deletes to the trash and renames in place', async () => {
  const f = setup();
  assert.equal((await f.callTool('rename_path', { path: 'resources/app.resource', new_name: 'shop.resource' })).text, 'Renamed to resources/shop.resource.');
  assert.equal((await f.callTool('delete_path', { path: 'resources/shop.resource' })).text, 'resources/shop.resource moved to the Recycle Bin.');
  assert.deepEqual(f.trashed, ['resources/shop.resource']);
  assert.equal((await f.callTool('delete_path', { path: '' })).isError, true, 'the project folder itself');
});

test('searches files and keywords, project keywords first', async () => {
  const f = setup({
    keywords: [
      { name: 'Fill Text', args: [{ repr: 'selector' }, { repr: 'txt' }], shortdoc: 'Clears and fills the given txt.', library: 'Browser' },
      { name: 'Fill Login Form', args: [{ repr: 'user' }], shortdoc: 'Fills the form.', user: true, source: 'resources/app.resource', lineno: 4 },
      { name: 'Click', args: [], shortdoc: 'Clicks.', library: 'Browser' },
    ],
  });
  assert.match((await f.callTool('search_project', { query: 'no operation' })).text, /^resources\/app\.resource:3: No Operation$/);
  const keywords = (await f.callTool('find_keywords', { query: 'fill' })).text.split('\n');
  assert.equal(keywords[0], 'Fill Login Form    user    [resources/app.resource:4]');
  assert.ok(keywords.includes('Fill Text    selector    txt    [Browser]'));
  assert.ok(!keywords.some((line) => line.startsWith('Click')));
  assert.equal((await f.callTool('find_keywords', { query: 'fill', library: 'Browser' })).text.split('\n')[0], 'Fill Text    selector    txt    [Browser]');
  assert.equal((await f.callTool('check_file', { path: 'tests/login.robot' })).text, 'line 2: ERROR: Bad');
});

test('a run collects test statuses, the failing keyword and the console tail', async () => {
  const runner = new EventEmitter();
  const tracker = new RunTracker(runner);
  await tracker.start(async () => {
    setImmediate(() => {
      runner.emit('output', 'robot output\n');
      runner.emit('event', { type: 'test-start', id: 'Tests.Login' });
      runner.emit('event', { type: 'step-start', id: 's1', name: 'Click', args: ['id=go'], lineno: 7, test: 'Tests.Login' });
      runner.emit('event', { type: 'step-end', id: 's1', status: 'FAIL', test: 'Tests.Login' });
      runner.emit('event', { type: 'test-end', id: 'Tests.Login', status: 'FAIL', message: 'Element not found', elapsed: 1.2 });
      runner.emit('event', { type: 'test-start', id: 'Tests.Home' });
      runner.emit('event', { type: 'test-end', id: 'Tests.Home', status: 'PASS', elapsed: 0.4 });
      runner.emit('finished', { exitCode: 1, stopped: false, outputDir: 'results' });
    });
  });
  const result = await tracker.wait(5);
  assert.equal(result.done, true);
  assert.deepEqual(result.tests.map((t) => [t.name, t.status]), [['Tests.Login', 'FAIL'], ['Tests.Home', 'PASS']]);
  assert.equal(result.tests[0].failedStep, 'Click    id=go (line 7)');
  assert.equal(runner.listenerCount('event'), 0, 'listeners are removed');

  const f = setup();
  f.app.startRun = async () => setImmediate(() => {
    f.runner.emit('event', { type: 'test-start', id: 'Tests.Login' });
    f.runner.emit('event', { type: 'test-end', id: 'Tests.Login', status: 'FAIL', message: 'Boom' });
    f.runner.emit('finished', { exitCode: 1, stopped: false });
  });
  const text = (await f.callTool('run_tests')).text;
  assert.match(text, /^Finished: 0 passed, 1 failed, 0 skipped \(exit code 1\)\./);
  assert.match(text, /FAIL {2}Tests\.Login\n {6}Boom/);
  assert.match(text, /Robot log: .*log\.html/);

  f.runner.running = true;
  assert.match((await f.callTool('run_tests')).text, /already running/);
});

test('a long run returns partial results, and wait_for_run follows it to the end', async () => {
  const f = setup();
  f.app.startRun = async () => setImmediate(() => {
    f.runner.emit('event', { type: 'test-start', id: 'Tests.One' });
    f.runner.emit('event', { type: 'test-end', id: 'Tests.One', status: 'PASS', elapsed: 0.1 });
    f.runner.emit('event', { type: 'test-start', id: 'Tests.Two' });
  });
  const partial = (await f.callTool('run_tests', { wait_seconds: 1 })).text;
  assert.match(partial, /^Still running: 1 passed, 0 failed, 0 skipped so far; now running Tests\.Two\. Call wait_for_run/);
  assert.match(partial, /PASS {2}Tests\.One/);
  assert.doesNotMatch(partial, /Robot log/);

  setTimeout(() => {
    f.runner.emit('event', { type: 'test-end', id: 'Tests.Two', status: 'PASS', elapsed: 1 });
    f.runner.emit('finished', { exitCode: 0, stopped: false });
  }, 50);
  const final = (await f.callTool('wait_for_run', { seconds: 5 })).text;
  assert.match(final, /^Finished: 2 passed, 0 failed, 0 skipped \(exit code 0\)\./);
  assert.equal(f.runner.listenerCount('event'), 0, 'listeners are removed when the run ends');
  assert.match((await f.callTool('wait_for_run')).text, /^Finished: 2 passed/, 'the final result stays available');

  const fresh = setup();
  assert.equal((await fresh.callTool('wait_for_run')).text, 'No run was started with run_tests.');
  fresh.app.startRun = async () => { throw new Error('No project is open.'); };
  const failed = await fresh.callTool('run_tests');
  assert.equal(failed.isError, true);
  assert.equal(fresh.runner.listenerCount('event'), 0);
});

test('test_failure_details shows the failing line in its file, the log and the screenshot', async () => {
  const f = setup();
  const shot = path.join(f.root, 'results', 'browser', 'screenshot', 'fail-1.png');
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  fs.writeFileSync(shot, Buffer.from('89504e470d0a1a0a', 'hex'));
  const { pathToFileURL } = require('url');
  f.app.startRun = async () => setImmediate(() => {
    f.runner.emit('event', { type: 'test-start', id: 'Tests.Login.Login' });
    f.runner.emit('event', { type: 'log', test: 'Tests.Login.Login', level: 'INFO', html: false, text: 'Opening page' });
    f.runner.emit('event', { type: 'step-start', id: 's1', name: 'Log', args: ['one'], lineno: 3, source: 'tests/login.robot', test: 'Tests.Login.Login' });
    f.runner.emit('event', { type: 'log', test: 'Tests.Login.Login', level: 'INFO', html: true, text: '<img src="browser/screenshot/fail-1.png" width="800px">', images: [pathToFileURL(shot).href] });
    f.runner.emit('event', { type: 'log', test: 'Tests.Login.Login', level: 'FAIL', html: false, text: 'Element &quot;x&quot; not found' });
    f.runner.emit('event', { type: 'step-end', id: 's1', status: 'FAIL', test: 'Tests.Login.Login' });
    f.runner.emit('event', { type: 'test-end', id: 'Tests.Login.Login', status: 'FAIL', message: 'Element not found' });
    f.runner.emit('finished', { exitCode: 1, stopped: false });
  });
  const summary = (await f.callTool('run_tests')).text;
  assert.match(summary, /failing keyword: Log {4}one \(tests\/login\.robot:3\)/);
  assert.match(summary, /call test_failure_details/);

  const reply = await f.raw('test_failure_details', {});
  const [text, image] = reply.result.content;
  assert.match(text.text, /^FAIL {2}Tests\.Login\.Login\nMessage: Element not found\nFailing keyword: Log {4}one \(tests\/login\.robot:3\)/);
  assert.match(text.text, /tests\/login\.robot:\n {2}\s+1 {2}\*\*\* Test Cases \*\*\*\n {2}\s+2 {2}Login\n> \s+3 {6}Log {4}one/);
  assert.match(text.text, /INFO {2}\[image browser\/screenshot\/fail-1\.png\]/);
  assert.match(text.text, /FAIL {2}Element &quot;x&quot; not found/, 'plain text messages are kept as written');
  assert.deepEqual(image, { type: 'image', data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'), mimeType: 'image/png' });

  assert.equal((await f.raw('test_failure_details', { test: 'Missing' })).result.isError, true);
  assert.equal((await f.raw('test_failure_details', { test: 'Login' })).result.content[0].text.split('\n')[0], 'FAIL  Tests.Login.Login');
});
