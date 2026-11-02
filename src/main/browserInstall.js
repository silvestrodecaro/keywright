'use strict';

const path = require('path');
const { spawn } = require('child_process');

const INSTALLABLE = new Set(['chromium', 'firefox', 'webkit']);

/** playwright-core's CLI (unpacked from app.asar in the packaged app, see "asarUnpack"). */
function playwrightCli() {
  const cli = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'cli.js');
  return cli.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

/**
 * Downloads a Playwright browser for the Test Generator. Runs playwright-core's
 * CLI with the app's own executable in Node mode, so Node.js is not required.
 * @param {string} name chromium | firefox | webkit
 * @param {(text: string) => void} onLog
 * @returns {Promise<void>}
 */
function installBrowser(name, onLog = () => {}) {
  if (!INSTALLABLE.has(name))
    return Promise.reject(new Error(`Unknown browser: ${name}`));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [playwrightCli(), 'install', name], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    });
    child.stdout.on('data', (chunk) => onLog(chunk.toString()));
    child.stderr.on('data', (chunk) => onLog(chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Browser installation failed (exit code ${code}).`)));
  });
}

module.exports = { installBrowser, INSTALLABLE };
