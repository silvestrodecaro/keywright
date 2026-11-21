'use strict';

// JSON files the application keeps (recovery, recent projects, MCP settings, run
// history): a damaged file is kept aside, never silently replaced.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJsonAtomic } = require('../src/main/jsonFile');
const { RecoveryStore } = require('../src/main/recoveryStore');
const { RecentProjects } = require('../src/main/recentProjects');
const { McpSettings } = require('../src/main/mcp/settings');
const { RunHistory, FILE_NAME } = require('../src/main/runHistory');
const projects = require('../src/main/projects');
const { tempDir } = require('./helpers/tempDir');

const asideCopies = (file) => fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(`${path.basename(file)}.corrupt-`));

test('readJson tells a missing file from a damaged one and reads a file with a BOM', () => {
  const dir = tempDir('json');
  const file = path.join(dir, 'data.json');
  assert.deepEqual(readJson(file), { status: 'missing' });

  fs.writeFileSync(file, '\uFEFF{"a": 1}');
  assert.deepEqual(readJson(file), { status: 'ok', value: { a: 1 } });

  fs.writeFileSync(file, '{"a": 1');
  const damaged = readJson(file);
  assert.equal(damaged.status, 'corrupt');
  assert.equal(fs.existsSync(file), false, 'the damaged file is moved aside');
  assert.equal(fs.readFileSync(damaged.movedTo, 'utf8'), '{"a": 1');
});

test('writeJsonAtomic replaces a file whole, and leaves nothing behind when it cannot', () => {
  const dir = tempDir('json-write');
  const file = path.join(dir, 'nested', 'data.json');
  writeJsonAtomic(file, { a: 1 });
  writeJsonAtomic(file, { a: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 2 });

  const blocked = path.join(dir, 'blocked');
  fs.mkdirSync(path.join(blocked, 'not-empty'), { recursive: true });
  assert.throws(() => writeJsonAtomic(blocked, { a: 3 }));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['blocked', 'nested']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'nested')), ['data.json']);
});

test('a damaged recovery file is kept aside, not deleted by the next save', () => {
  const dir = tempDir('recovery-damaged');
  const store = new RecoveryStore(dir);
  const root = path.join(dir, 'project');
  store.write(root, [{ path: 'a.robot', content: 'unsaved', revision: null }]);
  const [file] = fs.readdirSync(dir);
  fs.writeFileSync(path.join(dir, file), '{"root": "truncated');
  assert.deepEqual(store.read(root), []);
  store.write(root, []);
  assert.equal(asideCopies(path.join(dir, file)).length, 1);
});

test('a damaged recent projects list is kept aside before a new one is written', () => {
  const dir = tempDir('recent-damaged');
  const file = path.join(dir, 'recent.json');
  fs.writeFileSync(file, '[{"root": "C:/x"');
  const recent = new RecentProjects(file);
  recent.add(dir);
  assert.equal(asideCopies(file).length, 1);
  assert.deepEqual(recent.list().map((entry) => entry.root), [dir]);
});

test('MCP settings saved with a BOM keep their token', () => {
  const dir = tempDir('mcp-bom');
  const token = 'x'.repeat(43);
  fs.writeFileSync(path.join(dir, 'mcp.json'), `\uFEFF${JSON.stringify({ enabled: true, token, port: 47811 })}`);
  const settings = new McpSettings(dir).read();
  assert.equal(settings.token, token);
  assert.equal(settings.enabled, true);
});

test('a damaged run history is kept aside, not replaced by the next run', () => {
  const dir = tempDir('history-damaged');
  fs.writeFileSync(path.join(dir, FILE_NAME), '[{"id": "a"');
  const history = new RunHistory();
  history.start(dir, {});
  history.record({ type: 'test-end', id: 'Suite.Test', status: 'PASS' });
  history.finish({ exitCode: 0, stopped: false });
  assert.equal(asideCopies(path.join(dir, FILE_NAME)).length, 1);
  assert.equal(history.list(dir).length, 1);
});

test('keywright.json saved with a BOM opens', () => {
  const dir = tempDir('config-bom');
  fs.writeFileSync(path.join(dir, 'keywright.json'), '\uFEFF{"testsDir": "suites"}');
  assert.equal(projects.loadProject(dir).config.testsDir, 'suites');
});
