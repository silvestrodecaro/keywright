'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const projects = require('../src/main/projects');
const { RunHistory } = require('../src/main/runHistory');
const { pythonEnv } = require('../src/main/pythonHelper');
const { tempDir } = require('./helpers/tempDir');
const { spawnSync } = require('node:child_process');
const { environmentValue } = require('../src/main/compatibility');

test('Keywright configuration selects its test layout and Python', () => {
  const root = tempDir('modern-config');
  fs.writeFileSync(path.join(root, 'python.exe'), 'test interpreter placeholder');
  fs.writeFileSync(path.join(root, 'keywright.json'), JSON.stringify({ testsDir: 'acceptance', outputDir: 'artifacts', python: 'python.exe' }));
  const project = projects.loadProject(root);
  assert.equal(project.config.testsDir, 'acceptance');
  assert.equal(project.config.outputDir, 'artifacts');
  assert.equal(project.python, path.join(root, 'python.exe'));
});

test('legacy project configuration remains readable without rewriting the project', () => {
  const root = tempDir('legacy-config');
  const content = '{"testsDir":"legacy-tests","outputDir":"legacy-output"}\n';
  fs.writeFileSync(path.join(root, 'rfide.json'), content);
  const project = projects.loadProject(root);
  assert.equal(project.config.testsDir, 'legacy-tests');
  assert.equal(project.config.outputDir, 'legacy-output');
  assert.equal(fs.readFileSync(path.join(root, 'rfide.json'), 'utf8'), content);
  assert.ok(!fs.existsSync(path.join(root, 'keywright.json')));
});

test('modern project configuration takes precedence without merging stale legacy values', () => {
  const root = tempDir('config-precedence');
  fs.writeFileSync(path.join(root, 'rfide.json'), '{"testsDir":"old-tests","outputDir":"old-output"}');
  fs.writeFileSync(path.join(root, 'keywright.json'), '{"outputDir":"new-output"}');
  const project = projects.loadProject(root);
  assert.equal(project.config.testsDir, 'tests');
  assert.equal(project.config.outputDir, 'new-output');
});

test('invalid modern configuration is reported instead of silently loading the legacy file', () => {
  const root = tempDir('invalid-modern-config');
  fs.writeFileSync(path.join(root, 'rfide.json'), '{}');
  fs.writeFileSync(path.join(root, 'keywright.json'), '{broken');
  assert.throws(() => projects.loadProject(root), /Invalid keywright\.json/);
});

const previous = {
  id: 'legacy-run', startedAt: '2026-11-01T12:00:00.000Z',
  options: { select: [], include: [], exclude: [], dryrun: false, debug: false },
  tests: { 'Suite.Previous': { status: 'PASS', elapsed: 1 } },
  duration: 1, exitCode: 0, stopped: false,
};

test('a new run carries legacy history into the modern file without modifying the old file', () => {
  const root = tempDir('legacy-history');
  const original = JSON.stringify([previous]);
  fs.writeFileSync(path.join(root, '.rfide-history.json'), original);
  const history = new RunHistory();
  assert.deepEqual(history.list(root), [previous]);
  history.start(root);
  history.record({ type: 'test-end', id: 'Suite.Current', status: 'PASS', elapsed: 0.5 });
  const current = history.finish({ exitCode: 0 });
  const saved = JSON.parse(fs.readFileSync(path.join(root, '.keywright-history.json'), 'utf8'));
  assert.deepEqual(saved.map((run) => run.id), [current.id, 'legacy-run']);
  assert.equal(saved[0].tests['Suite.Current'].status, 'PASS');
  assert.equal(fs.readFileSync(path.join(root, '.rfide-history.json'), 'utf8'), original);
});

test('an explicitly empty modern history does not resurrect legacy runs', () => {
  const root = tempDir('history-precedence');
  fs.writeFileSync(path.join(root, '.rfide-history.json'), JSON.stringify([previous]));
  fs.writeFileSync(path.join(root, '.keywright-history.json'), '[]');
  assert.deepEqual(new RunHistory().list(root), []);
});

test('Python processes receive modern environment names from legacy overrides', () => {
  const env = pythonEnv({ RFIDE_DEBUG: '1', RFIDE_SELECT: '["Suite.Example"]' });
  assert.equal(env.KEYWRIGHT_DEBUG, '1');
  assert.equal(env.KEYWRIGHT_SELECT, '["Suite.Example"]');
  assert.ok(!('RFIDE_DEBUG' in env));
  assert.ok(!('RFIDE_SELECT' in env));
});

test('modern environment overrides win even when deliberately empty', () => {
  const env = pythonEnv({ KEYWRIGHT_DEBUG: '', RFIDE_DEBUG: '1' });
  assert.equal(env.KEYWRIGHT_DEBUG, '');
  assert.ok(!('RFIDE_DEBUG' in env));
});

test('application environment migration leaves unrelated project variables unchanged', () => {
  const env = pythonEnv({ RFIDE_CUSTOM_VALUE: 'project data', PROJECT_OPTION: 'unchanged' });
  assert.equal(env.RFIDE_CUSTOM_VALUE, 'project data');
  assert.equal(env.PROJECT_OPTION, 'unchanged');
  assert.ok(!('KEYWRIGHT_CUSTOM_VALUE' in env));
});

const python = environmentValue(process.env, 'PYTHON') || [
  path.join(__dirname, '../.venv/Scripts/python.exe'),
  path.join(__dirname, '../.venv/bin/python'),
].find((file) => fs.existsSync(file));

for (const modern of [false, true]) {
  test(modern ? 'Python selection prefers modern variables to conflicting legacy variables'
    : 'Python selection still accepts legacy variables with the renamed helper', { skip: !python && 'no Robot Python' }, () => {
    const root = tempDir('python-alias');
    fs.writeFileSync(path.join(root, 'selection.robot'),
      '*** Test Cases ***\nSelected\n    No Operation\nOther\n    Fail    This test must not run\n');
    const env = pythonEnv();
    delete env.KEYWRIGHT_SELECT;
    env.RFIDE_SELECT = JSON.stringify([modern ? 'Selection.Other' : 'Selection.Selected']);
    if (modern) env.KEYWRIGHT_SELECT = '["Selection.Selected"]';
    const result = spawnSync(python, ['-m', 'robot', '--prerunmodifier', 'keywright_runner.SelectTests',
      '--output', 'NONE', '--log', 'NONE', '--report', 'NONE', 'selection.robot'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /1 test, 1 passed, 0 failed/);
  });
}
