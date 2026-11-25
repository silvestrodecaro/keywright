'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { missingBrowser } = require('../src/main/browserInstall');
const { tempDir } = require('./helpers/tempDir');

test('a missing browser build is told apart from one left by another Playwright version', () => {
  const cache = path.join(tempDir('browsers'), 'ms-playwright');
  const executable = path.join(cache, 'chromium-1255', 'chrome-win64', 'chrome.exe');
  const playwright = { chromium: { executablePath: () => executable } };
  assert.deepEqual(missingBrowser('chromium', playwright), { outdated: false }, 'no storage');
  fs.mkdirSync(path.join(cache, 'chromium_headless_shell-1254'), { recursive: true });
  fs.mkdirSync(path.join(cache, 'firefox-1555'));
  assert.deepEqual(missingBrowser('chromium', playwright), { outdated: false }, 'other browsers only');
  fs.mkdirSync(path.join(cache, 'chromium-1254'));
  assert.deepEqual(missingBrowser('chromium', playwright), { outdated: true });
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, '');
  assert.equal(missingBrowser('chromium', playwright), null);
});

test('the pinned Playwright gives the path of each browser it installs', () => {
  const playwright = require('playwright-core');
  for (const name of ['chromium', 'firefox', 'webkit'])
    assert.match(path.normalize(playwright[name].executablePath()), new RegExp(`${name}-\\d+`));
});

test('a browser that Playwright cannot provide or does not know is not offered', () => {
  assert.equal(missingBrowser('webkit', { webkit: { executablePath: () => { throw new Error('unsupported'); } } }), null);
  assert.equal(missingBrowser('opera', {}), null);
});
