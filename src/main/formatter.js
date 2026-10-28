'use strict';

// Formatting of .robot/.resource content with Robocop's formatter (the former
// Robotidy), run with the project's Python. The content (unsaved edits
// included) is formatted in a temporary file outside the project, so the
// project watcher does not see it; the project's Robocop configuration applies.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PACKAGE = 'robotframework-robocop';

function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', (error) => resolve({ code: -1, output: error.message }));
    child.on('close', (code) => resolve({ code, output }));
  });
}

/** The project's Robocop configuration file, if any. */
function configFile(root) {
  for (const name of ['robocop.toml', 'pyproject.toml', 'robot.toml']) {
    const file = path.join(root, name);
    if (!fs.existsSync(file))
      continue;
    // pyproject.toml and robot.toml only when they configure Robocop.
    if (name === 'robocop.toml' || /\[tool\.robocop/.test(fs.readFileSync(file, 'utf8')))
      return file;
  }
  return null;
}

/**
 * @param {{ root: string, python: string | null }} project
 * @param {string} relative file path, for its extension (.robot or .resource)
 * @returns {Promise<{ ok: true, formatted: string } | { ok: false, error: string, missing?: boolean }>}
 *   missing: Robocop is not installed in the project's virtual environment
 */
async function formatRobot(project, relative, text) {
  if (!project.python)
    return { ok: false, error: 'This project has no virtual environment (.venv) to run Robocop with.' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfide-format-'));
  try {
    const file = path.join(dir, path.basename(relative));
    fs.writeFileSync(file, text);
    const args = ['-m', 'robocop', 'format', '--overwrite', '--no-diff', '--silent'];
    const config = configFile(project.root);
    if (config)
      args.push('--config', config);
    args.push(file);
    const { code, output } = await run(project.python, args, project.root);
    if (/No module named robocop/i.test(output))
      return { ok: false, missing: true, error: `Robocop is not installed in this project's virtual environment (${PACKAGE}).` };
    if (code !== 0)
      return { ok: false, error: output.trim().split('\n').slice(-3).join('\n') || `Robocop exited with code ${code}.` };
    const eol = text.includes('\r\n') ? '\r\n' : '\n'; // Robocop writes the platform's line endings
    return { ok: true, formatted: fs.readFileSync(file, 'utf8').replace(/\r?\n/g, eol) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Installs Robocop in the project's virtual environment. */
async function installRobocop(project) {
  if (!project.python)
    return { ok: false, error: 'This project has no virtual environment (.venv).' };
  const { code, output } = await run(project.python, ['-m', 'pip', 'install', '--disable-pip-version-check', PACKAGE], project.root);
  return code === 0 ? { ok: true } : { ok: false, error: output.trim().split('\n').slice(-3).join('\n') };
}

module.exports = { formatRobot, installRobocop, PACKAGE };
