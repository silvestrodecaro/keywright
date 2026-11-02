'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { terminal } = require('./terminal');
const { commandRunner } = require('./command');
const { electronExecutable } = require('./electron-runtime');

async function start({ root = path.resolve(__dirname, '..'), args = [], env = process.env, output = process.stdout, spawn } = {}) {
  const ui = terminal(output, env);
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  ui.banner(version, 'Start');
  const executable = electronExecutable(root);
  const directory = path.join(root, 'out', 'start');
  fs.mkdirSync(directory, { recursive: true });
  const log = path.join(directory, new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid + '.log');
  ui.line(`  Log: ${log}`);
  ui.line();
  const childEnv = { ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const run = commandRunner({ root, env: childEnv, log, ui, spawn });
  await run('Build editor', process.execPath, [path.join(root, 'scripts', 'build.mjs')]);
  ui.line();
  ui.label('START', 'Opening Keywright. Close the app to return to this terminal.');
  await run('Keywright desktop', executable, [root, ...args], { background: true });
}

if (require.main === module)
  start({ args: process.argv.slice(2) }).catch((error) => {
    if (error.name !== 'AbortError') terminal(process.stderr).label('ERROR', error.message, '31');
    process.exitCode = error.exitCode || 1;
  });

module.exports = { start };
