'use strict';

const path = require('path');
const { execFile } = require('child_process');

// In the packaged app the helper is unpacked from app.asar (see "asarUnpack" in
// package.json): it is run by the project's Python, which cannot read archives.
const HELPER_DIR = path.join(__dirname, '..', 'python').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const HELPER = path.join(HELPER_DIR, 'rfide_runner.py');

/** Environment for the project's Python, with rfide_runner importable. */
function pythonEnv(extra = {}) {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', ...extra };
  env.PYTHONPATH = [HELPER_DIR, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  return env;
}

/**
 * Runs `rfide_runner.py <args>` with the project's Python. The helper prints
 * its JSON result on the last line of stdout.
 * @returns {Promise<object>} the parsed result, or { ok: false, error }
 */
function runHelper(python, args, { cwd } = {}) {
  return new Promise((resolve) => {
    execFile(python, [HELPER, ...args], { cwd, env: pythonEnv(), windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const line = String(stdout).trim().split('\n').pop();
        try {
          resolve(JSON.parse(line));
        } catch {
          const output = String(stderr || (error && error.message) || '');
          const missing = /No module named '?robot'?/.test(output);
          resolve({ ok: false, error: missing
            ? 'Robot Framework is not installed in this project\'s virtual environment: run pip install -r requirements.txt'
            : (output || 'The Python helper failed.').trim() });
        }
      });
  });
}

module.exports = { HELPER_DIR, HELPER, pythonEnv, runHelper };
