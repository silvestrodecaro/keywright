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
    throw new Error('The installed Electron executable is missing or blocked. If antivirus quarantined it, keep it quarantined and contact your IT/security team. Setup will not download it again. See docs/troubleshooting.md#antivirus-detects-electronexe.');
}

function electronExecutable(root) {
  assertRuntimeNotRemoved(root);
  const { executable } = runtimePaths(root);
  if (!fs.existsSync(executable))
    throw new Error('Electron is not installed. Run setup.bat first. If antivirus removed the executable, keep it quarantined and see docs/troubleshooting.md#antivirus-detects-electronexe.');
  return executable;
}

module.exports = { assertRuntimeNotRemoved, electronExecutable };
