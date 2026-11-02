'use strict';


const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { KeywordIndex } = require('../src/main/keywordIndex');
const { tempDir } = require('./helpers/tempDir');
const { spawnSync } = require('node:child_process');

const python = process.env.KEYWRIGHT_PYTHON || [
  path.join(__dirname, '../.venv/Scripts/python.exe'),
  path.join(__dirname, '../.venv/bin/python'),
].find((file) => fs.existsSync(file));
const skip = !python && 'no Python with Robot Framework';

function project(importName = './local_library.py') {
  const root = tempDir('keyword-cache');
  fs.writeFileSync(path.join(root, 'suite.robot'), `*** Settings ***\nLibrary    ${importName}\n*** Test Cases ***\nExample\n    No Operation\n`);
  return { root, python };
}

const names = (result) => result.keywords.map((keyword) => keyword.name);

test('completion refreshes after the source of a Python library changes', { skip }, async () => {
  const fixture = project();
  const source = path.join(fixture.root, 'local_library.py');
  fs.writeFileSync(source, 'def first_keyword():\n    pass\n');
  const index = new KeywordIndex();
  assert.ok(names(await index.build(fixture)).includes('First Keyword'));
  fs.writeFileSync(source, 'def replacement_keyword():\n    pass\n');
  const updated = await index.build(fixture);
  assert.ok(names(updated).includes('Replacement Keyword'));
  assert.ok(!names(updated).includes('First Keyword'));
});

test('a repaired Python library is retried after an import failure', { skip }, async () => {
  const fixture = project();
  const source = path.join(fixture.root, 'local_library.py');
  fs.writeFileSync(source, 'raise RuntimeError("temporarily unavailable")\n');
  const index = new KeywordIndex();
  const failed = await index.build(fixture);
  assert.ok(failed.errors.some((error) => /temporarily unavailable/.test(error.error)));
  fs.writeFileSync(source, 'def repaired_keyword():\n    pass\n');
  const repaired = await index.build(fixture);
  assert.ok(names(repaired).includes('Repaired Keyword'));
  assert.deepEqual(repaired.errors, []);
});

test('projects sharing a Python keep project-dependent library documentation separate', { skip }, async () => {
  const source = path.join(tempDir('shared-library'), 'SharedLibrary.py');
  fs.writeFileSync(source, 'from pathlib import Path\nclass SharedLibrary:\n    def get_keyword_names(self):\n        return [Path("keyword-name.txt").read_text().strip()]\n    def run_keyword(self, name, args):\n        pass\n');
  const first = project(source.replace(/\\/g, '/'));
  const second = project(source.replace(/\\/g, '/'));
  fs.writeFileSync(path.join(first.root, 'keyword-name.txt'), 'First Project Keyword');
  fs.writeFileSync(path.join(second.root, 'keyword-name.txt'), 'Second Project Keyword');
  const index = new KeywordIndex();
  const a = await index.build(first);
  assert.deepEqual(a.errors, []);
  assert.ok(names(a).includes('First Project Keyword'));
  const b = await index.build(second);
  assert.deepEqual(b.errors, []);
  assert.ok(names(b).includes('Second Project Keyword'));
  assert.ok(!names(b).includes('First Project Keyword'));
});

test('removing a documented library reports the failed import instead of stale keywords', { skip }, async () => {
  const fixture = project();
  const source = path.join(fixture.root, 'local_library.py');
  fs.writeFileSync(source, 'def removed_keyword():\n    pass\n');
  const index = new KeywordIndex();
  assert.ok(names(await index.build(fixture)).includes('Removed Keyword'));
  fs.unlinkSync(source);
  const removed = await index.build(fixture);
  assert.ok(!names(removed).includes('Removed Keyword'));
  assert.ok(removed.errors.some((error) => error.import.endsWith('local_library.py')));
});

test('completion does not reuse stale Python bytecode after a same-size source edit', { skip }, async () => {
  const fixture = project();
  const source = path.join(fixture.root, 'local_library.py');
  fs.writeFileSync(source, 'def first_keyword():\n    pass\n');
  const compiled = spawnSync(python, ['-c', 'import py_compile, sys; py_compile.compile(sys.argv[1], doraise=True)', source]);
  assert.equal(compiled.status, 0, compiled.stderr?.toString());
  const original = fs.statSync(source);
  const index = new KeywordIndex();
  assert.ok(names(await index.build(fixture)).includes('First Keyword'));
  fs.writeFileSync(source, 'def other_keyword():\n    pass\n');
  fs.utimesSync(source, original.atime, original.mtime);
  const updated = await index.build(fixture);
  assert.ok(names(updated).includes('Other Keyword'));
  assert.ok(!names(updated).includes('First Keyword'));
});

test('unchanged library documentation stays cached between index builds', { skip }, async () => {
  const fixture = project();
  fs.writeFileSync(path.join(fixture.root, 'local_library.py'),
    'from pathlib import Path\np = Path("imports.txt")\np.write_text(p.read_text() + "x" if p.exists() else "x")\ndef cached_keyword():\n    pass\n');
  const index = new KeywordIndex();
  await index.build(fixture);
  const second = await index.build(fixture);
  assert.ok(names(second).includes('Cached Keyword'));
  assert.equal(fs.readFileSync(path.join(fixture.root, 'imports.txt'), 'utf8'), 'x');
});

test('invalidation during libdoc discards the in-flight result and rebuilds current source', { skip, timeout: 20_000 }, async () => {
  const fixture = project();
  const source = path.join(fixture.root, 'local_library.py');
  const started = path.join(fixture.root, 'import-started');
  const release = path.join(fixture.root, 'continue-import');
  fs.writeFileSync(source, 'from pathlib import Path\nimport time\ndef old_keyword():\n    pass\nPath("import-started").touch()\nwhile not Path("continue-import").exists():\n    time.sleep(0.01)\n');
  const index = new KeywordIndex();
  const building = index.build(fixture);
  let result;
  try {
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(started)) {
      assert.ok(Date.now() < deadline, 'Python did not start documenting the fixture library');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    fs.writeFileSync(source, 'def current_keyword_after_invalidation():\n    pass\n');
    index.clear();
  } finally {
    fs.writeFileSync(release, 'continue');
    result = await building;
  }
  assert.ok(names(result).includes('Current Keyword After Invalidation'));
  assert.ok(!names(result).includes('Old Keyword'));
  assert.ok(names(await index.build(fixture)).includes('Current Keyword After Invalidation'));
});
