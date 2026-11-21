'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { finished } = require('node:stream/promises');
const { run } = require('node:test');
const { spec } = require('node:test/reporters');
const { browserEnvironment } = require('../src/main/browserEnvironment');

const root = path.resolve(__dirname, '..');
const uiReport = path.join(root, 'out', 'ui-tests', 'results.json');

async function checkNode() {
  let summary;
  const files = fs.globSync('test/*.test.js', { cwd: root }).map((file) => path.join(root, file));
  if (!files.length) throw new Error('No Node tests were found.');
  const tests = run({ files, concurrency: true });
  tests.on('test:summary', (result) => {
    if (!result.file) summary = result;
  });
  const output = tests.compose(spec);
  output.pipe(process.stdout, { end: false });
  await finished(output);
  if (!summary?.counts.tests) throw new Error('Node did not report any test results.');
  const { skipped, todo } = summary.counts;
  if (skipped || todo) console.error(`Node regression checks require all tests to run (${skipped} skipped, ${todo} TODO).`);
  return summary.success && skipped === 0 && todo === 0;
}

function node(args, env) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status === 0;
}

function checkDesktop(env) {
  if (!node(['scripts/build.mjs'], env)) return false;
  fs.rmSync(uiReport, { force: true });
  if (!node([require.resolve('@playwright/test/cli'), 'test'], { ...env, PLAYWRIGHT_JSON_OUTPUT_FILE: uiReport })) return false;
  const { stats } = JSON.parse(fs.readFileSync(uiReport, 'utf8'));
  // A flaky test passed only on a retry: it counts as a failure here.
  if (!stats.expected || stats.skipped || stats.flaky) {
    console.error(`Desktop regression checks require all tests to run and pass the first time (${stats.expected} passed, ${stats.skipped} skipped, ${stats.flaky || 0} flaky).`);
    return false;
  }
  return true;
}

// --node-only and --desktop-only run one layer, as CI does in separate steps.
async function main() {
  const env = browserEnvironment();
  process.env.PLAYWRIGHT_BROWSERS_PATH = env.PLAYWRIGHT_BROWSERS_PATH;
  const args = new Set(process.argv.slice(2));
  const nodePassed = args.has('--desktop-only') || await checkNode();
  const desktopPassed = args.has('--node-only') || checkDesktop(env);
  if (!nodePassed || !desktopPassed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
