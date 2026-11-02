'use strict';

const fs = require('node:fs');
const path = require('node:path');

function runtimePaths(root) {
  const dist = path.join(root, 'node_modules', 'electron', 'dist');
  const name = process.platform === 'win32' ? 'electron.exe'
    : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron';
  return { executable: path.join(dist, name), version: path.join(dist, 'version') };
}

function assertRuntimeNotRemoved(root) {
  const runtime = runtimePaths(root);
  if (fs.existsSync(runtime.version) && !fs.existsSync(runtime.executable))
    throw new Error('The installed Electron executable is missing or blocked. Check your antivirus protection history and follow the recovery steps in docs/troubleshooting.md#antivirus-detects-electronexe. Setup will not download it again.');
}

function electronExecutable(root) {
  assertRuntimeNotRemoved(root);
  const { executable } = runtimePaths(root);
  if (!fs.existsSync(executable))
    throw new Error('Electron is not installed. Run setup.bat first. If antivirus removed the executable, follow the recovery steps in docs/troubleshooting.md#antivirus-detects-electronexe before reinstalling.');
  return executable;
}

module.exports = { assertRuntimeNotRemoved, electronExecutable };
