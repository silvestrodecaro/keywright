'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSettings, validateSettings, writeSettings } = require('../src/main/projectSettings');

function project(t, config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keywright-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'tests'));
  fs.mkdirSync(path.join(root, 'suites', 'web'), { recursive: true });
  fs.mkdirSync(path.join(root, 'env', 'Scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'env', 'Scripts', 'python.exe'), '');
  if (config !== undefined)
    fs.writeFileSync(path.join(root, 'keywright.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return root;
}

const values = (overrides = {}) => ({ testsDir: 'tests', resourcesDir: 'resources', outputDir: 'results', python: '', ...overrides });

test('settings without keywright.json are the defaults', (t) => {
  assert.deepStrictEqual(readSettings(project(t)), { testsDir: 'tests', resourcesDir: 'resources', outputDir: 'results', python: null });
});

test('settings are read from keywright.json over the defaults', (t) => {
  const root = project(t, { testsDir: 'suites', python: 'env/Scripts/python.exe' });
  assert.deepStrictEqual(readSettings(root), { testsDir: 'suites', resourcesDir: 'resources', outputDir: 'results', python: 'env/Scripts/python.exe' });
});

test('an invalid keywright.json is reported instead of being replaced', (t) => {
  const root = project(t, '{ "testsDir": ');
  assert.throws(() => readSettings(root), /keywright\.json is not valid JSON/);
  assert.throws(() => writeSettings(root, values()), /keywright\.json is not valid JSON/);
  assert.strictEqual(fs.readFileSync(path.join(root, 'keywright.json'), 'utf8'), '{ "testsDir": ');
});

test('paths are written relative to the project with forward slashes', (t) => {
  const root = project(t);
  const { settings, errors } = validateSettings(root, values({
    testsDir: ` ${path.join(root, 'suites', 'web')}\\ `,
    resourcesDir: '.\\shared\\',
    outputDir: './out/',
    python: path.join(root, 'env', 'Scripts', 'python.exe'),
  }));
  assert.deepStrictEqual(errors, {});
  assert.deepStrictEqual(settings, { testsDir: 'suites/web', resourcesDir: 'shared', outputDir: 'out', python: 'env/Scripts/python.exe' });
});

test('the project folder itself is "." for tests and resources', (t) => {
  const root = project(t);
  const { settings, errors } = validateSettings(root, values({ testsDir: root, resourcesDir: './' }));
  assert.deepStrictEqual(errors, {});
  assert.strictEqual(settings.testsDir, '.');
  assert.strictEqual(settings.resourcesDir, '.');
});

test('each field explains what is wrong with it', (t) => {
  const root = project(t);
  const outside = path.dirname(root);
  assert.deepStrictEqual(validateSettings(root, values({ testsDir: '', resourcesDir: ' ', outputDir: '' })).errors, {
    testsDir: 'Enter a folder.', resourcesDir: 'Enter a folder.', outputDir: 'Enter a folder.',
  });
  assert.deepStrictEqual(validateSettings(root, values({ testsDir: 'missing', resourcesDir: '../shared' })).errors, {
    testsDir: 'Folder not found in the project: missing',
    resourcesDir: 'Choose a folder inside the project.',
  });
  assert.deepStrictEqual(validateSettings(root, values({ testsDir: outside })).errors, { testsDir: 'Choose a folder inside the project.' });
  assert.deepStrictEqual(validateSettings(root, values({ outputDir: '.' })).errors, { outputDir: 'Use a separate folder for results, not the project folder.' });
  assert.deepStrictEqual(validateSettings(root, values({ outputDir: 'tests' })).errors, { outputDir: 'Use a folder separate from the tests folder.' });
  assert.deepStrictEqual(validateSettings(root, values({ python: 'env/python.exe' })).errors, { python: 'File not found: env/python.exe' });
});

test('results and the interpreter may be outside the project', (t) => {
  const root = project(t);
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'keywright-python-'));
  t.after(() => fs.rmSync(shared, { recursive: true, force: true }));
  const python = path.join(shared, 'python.exe');
  fs.writeFileSync(python, '');
  const results = path.join(shared, 'results');
  const { settings, errors } = validateSettings(root, values({ outputDir: results, python }));
  assert.deepStrictEqual(errors, {});
  assert.strictEqual(settings.outputDir, results.replace(/\\/g, '/'));
  assert.strictEqual(settings.python, python.replace(/\\/g, '/'));
});

test('saving keeps other properties and their order, and writes the defaults first', (t) => {
  const root = project(t, { custom: { keep: true }, outputDir: 'old', version: 1 });
  assert.deepStrictEqual(writeSettings(root, values({ testsDir: 'suites' })), { ok: true, errors: {} });
  const written = fs.readFileSync(path.join(root, 'keywright.json'), 'utf8');
  assert.deepStrictEqual(Object.keys(JSON.parse(written)), ['version', 'testsDir', 'resourcesDir', 'outputDir', 'python', 'custom']);
  assert.deepStrictEqual(JSON.parse(written), {
    version: 1, testsDir: 'suites', resourcesDir: 'resources', outputDir: 'results', python: null, custom: { keep: true },
  });
  assert.match(written, /\n {2}"testsDir": "suites",\n/);
  assert.ok(written.endsWith('}\n'));
});

test('invalid settings are not written', (t) => {
  const root = project(t);
  const result = writeSettings(root, values({ testsDir: 'missing' }));
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(Object.keys(result.errors), ['testsDir']);
  assert.ok(!fs.existsSync(path.join(root, 'keywright.json')));
});
