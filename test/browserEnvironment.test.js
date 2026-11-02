'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { pythonEnv } = require('../src/main/pythonHelper');

test('Robot processes use browser storage outside the project and its virtual environment', () => {
  const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
  delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  try {
    const env = pythonEnv();
    assert.ok(env.PLAYWRIGHT_BROWSERS_PATH, 'Robot must receive a browser cache path');
    assert.ok(path.isAbsolute(env.PLAYWRIGHT_BROWSERS_PATH));
    assert.ok(!env.PLAYWRIGHT_BROWSERS_PATH.startsWith(path.resolve(__dirname, '..')));
    assert.ok(!env.PLAYWRIGHT_BROWSERS_PATH.includes('site-packages'));
    assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, undefined);
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
  }
});

test('an explicit browser location, including hermetic mode, reaches Robot unchanged', () => {
  for (const location of [path.join(os.tmpdir(), 'custom browser cache'), '0']) {
    const env = pythonEnv({ PLAYWRIGHT_BROWSERS_PATH: location, PROJECT_OPTION: 'kept' });
    assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, location);
    assert.equal(env.PROJECT_OPTION, 'kept');
  }
});
