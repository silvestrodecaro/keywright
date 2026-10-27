'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { projectFiles, CONFIG_FILE, DEFAULT_CONFIG } = require('./projectTemplate');

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
const IS_WINDOWS = process.platform === 'win32';

// Folders never shown in the explorer.
const HIDDEN_DIRS = new Set(['.git', '.venv', 'venv', 'node_modules', '__pycache__', '.pytest_cache', '.idea', '.vscode']);

// The Browser library installs its browsers deep inside the virtual environment
// (~170 characters below the project root) and Windows cannot start executables
// whose path is longer than 260 characters, even with long paths enabled.
const MAX_WINDOWS_ROOT_WITH_BROWSERS = 85;

/**
 * Returns an error message when the project path is too long for the Browser
 * library browsers on Windows, otherwise null.
 */
function checkProjectPathLength(root, { installBrowsers, platform = process.platform } = {}) {
  if (platform !== 'win32' || !installBrowsers || root.length <= MAX_WINDOWS_ROOT_WITH_BROWSERS)
    return null;
  return `The project path is ${root.length} characters long. On Windows the Browser library browsers `
    + `cannot start from paths this deep: choose a location so that the project path is at most `
    + `${MAX_WINDOWS_ROOT_WITH_BROWSERS} characters (e.g. C:\\Projects\\<name>).`;
}

/** Returns an error message, or null when `name` can be used as a project folder. */
function validateProjectName(name) {
  if (!name || !name.trim())
    return 'Enter a project name.';
  if (!PROJECT_NAME.test(name) || name.endsWith('.') || name.endsWith(' '))
    return 'Use letters, digits, spaces, dots, dashes or underscores (starting with a letter or digit).';
  return null;
}

/**
 * Runs a command, streaming its output to `onLog`.
 * @returns {Promise<void>} rejects when the command fails
 */
function run(command, args, { cwd, onLog = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    onLog(`> ${[command, ...args].join(' ')}\n`);
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      windowsHide: true,
    });
    child.stdout.on('data', (chunk) => onLog(chunk.toString()));
    child.stderr.on('data', (chunk) => onLog(chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

/** Runs a command and returns its trimmed output, or null if it cannot be run. */
function probe(command, args) {
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? output.trim() : null));
  });
}

/**
 * Finds a Python >= 3.10 (required by the Browser library).
 * @returns {Promise<{ command: string, args: string[], version: string } | null>}
 */
async function findPython() {
  const candidates = IS_WINDOWS
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];
  for (const [command, args] of candidates) {
    const output = await probe(command, [...args, '--version']);
    const match = output && /Python (\d+)\.(\d+)\.(\d+)/.exec(output);
    if (match && (Number(match[1]) > 3 || (Number(match[1]) === 3 && Number(match[2]) >= 10)))
      return { command, args, version: `${match[1]}.${match[2]}.${match[3]}` };
  }
  return null;
}

/** Reports which tools needed by the project setup are installed. */
async function detectTools() {
  const [python, node, git] = await Promise.all([findPython(), probe('node', ['--version']), probe('git', ['--version'])]);
  return {
    python: python && python.version,
    node: node,
    git: git && git.replace(/^git version /, ''),
  };
}

function venvPython(root) {
  return IS_WINDOWS ? path.join(root, '.venv', 'Scripts', 'python.exe') : path.join(root, '.venv', 'bin', 'python');
}

/**
 * Creates a project folder and runs the requested setup steps.
 *
 * @param {{ location: string, name: string, createVenv?: boolean,
 *           installBrowsers?: boolean, initGit?: boolean }} request
 * @param {{ onSteps?: (steps: {id:string,title:string}[]) => void,
 *           onStep?: (id: string, status: 'running'|'done'|'failed'|'skipped', detail?: string) => void,
 *           onLog?: (text: string) => void }} [callbacks]
 * @returns {Promise<{ root: string, ok: boolean, error?: string }>}
 */
async function createProject(request, callbacks = {}) {
  const { onSteps = () => {}, onStep = () => {}, onLog = () => {} } = callbacks;
  const name = (request.name || '').trim();
  const nameError = validateProjectName(name);
  if (nameError)
    throw new Error(nameError);
  if (!request.location || !fs.existsSync(request.location))
    throw new Error('Choose an existing location for the project.');
  const root = path.join(request.location, name);
  if (fs.existsSync(root))
    throw new Error(`A file or folder named "${name}" already exists in ${request.location}.`);
  const pathError = checkProjectPathLength(root, { installBrowsers: request.createVenv && request.installBrowsers });
  if (pathError)
    throw new Error(pathError);

  const steps = [{ id: 'files', title: 'Create project files' }];
  if (request.createVenv) {
    steps.push({ id: 'venv', title: 'Create virtual environment (.venv)' });
    steps.push({ id: 'deps', title: 'Install Robot Framework and Browser library' });
    if (request.installBrowsers)
      steps.push({ id: 'browsers', title: 'Install Playwright browsers (rfbrowser init)' });
  }
  if (request.initGit)
    steps.push({ id: 'git', title: 'Initialize git repository' });
  onSteps(steps);

  const python = venvPython(root);
  const actions = {
    files: async () => {
      for (const [relative, content] of Object.entries(projectFiles(name))) {
        const target = path.join(root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, 'utf8');
        onLog(`created ${relative}\n`);
      }
      fs.mkdirSync(path.join(root, DEFAULT_CONFIG.outputDir), { recursive: true });
    },
    venv: async () => {
      const system = await findPython();
      if (!system)
        throw new Error('Python 3.10 or newer was not found on PATH.');
      await run(system.command, [...system.args, '-m', 'venv', '.venv'], { cwd: root, onLog });
    },
    deps: () => run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', 'requirements.txt'], { cwd: root, onLog }),
    browsers: async () => {
      if (!await probe('node', ['--version']))
        throw new Error('Node.js is required by "rfbrowser init" but was not found on PATH.');
      await run(python, ['-m', 'Browser.entry', 'init'], { cwd: root, onLog });
    },
    git: async () => {
      await run('git', ['init'], { cwd: root, onLog });
      await run('git', ['add', '.'], { cwd: root, onLog });
      if (!await probe('git', ['-C', root, 'config', 'user.email'])) {
        onLog('git user.email is not configured: skipping the initial commit.\n');
        return;
      }
      await run('git', ['commit', '-m', 'Initial Robot Framework project'], { cwd: root, onLog });
    },
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    onStep(step.id, 'running');
    try {
      await actions[step.id]();
      onStep(step.id, 'done');
    } catch (error) {
      const message = String(error && error.message || error);
      onLog(`\nERROR: ${message}\n`);
      onStep(step.id, 'failed', message);
      // The folder exists from here on: later steps are skipped but the
      // project can still be opened and fixed by hand.
      for (const rest of steps.slice(i + 1))
        onStep(rest.id, 'skipped');
      return { root, ok: false, error: message };
    }
  }
  return { root, ok: true };
}

/**
 * Loads the project at `root`. Any folder can be opened; rfide.json is optional.
 * @returns {{ root: string, name: string, config: typeof DEFAULT_CONFIG, python: string | null }}
 */
function loadProject(root) {
  const resolved = path.resolve(root);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory())
    throw new Error(`Folder not found: ${resolved}`);
  let config = { ...DEFAULT_CONFIG };
  const configPath = path.join(resolved, CONFIG_FILE);
  if (fs.existsSync(configPath)) {
    try {
      config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
    } catch (error) {
      throw new Error(`Invalid ${CONFIG_FILE}: ${error.message}`);
    }
  }
  const pythonPath = config.python ? path.resolve(resolved, config.python) : venvPython(resolved);
  return {
    root: resolved,
    name: path.basename(resolved),
    config,
    python: fs.existsSync(pythonPath) ? pythonPath : null,
  };
}

/**
 * Lists the project files as a tree (folders first, alphabetical).
 * @returns {{ name: string, path: string, type: 'dir'|'file', children?: object[] }[]}
 */
function listTree(root, relative = '', depth = 0) {
  if (depth > 8)
    return [];
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => !(entry.isDirectory() && HIDDEN_DIRS.has(entry.name)))
    .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
    .map((entry) => {
      const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory())
        return { name: entry.name, path: entryPath, type: 'dir', children: listTree(root, entryPath, depth + 1) };
      return { name: entry.name, path: entryPath, type: 'file' };
    });
}

/** Resolves a project-relative path, refusing paths outside the project. */
function resolveInProject(root, relative) {
  const target = path.resolve(root, relative);
  const fromRoot = path.relative(root, target);
  if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot))
    throw new Error(`Path is outside the project: ${relative}`);
  return target;
}

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

function readProjectFile(root, relative) {
  const target = resolveInProject(root, relative);
  const { size } = fs.statSync(target);
  if (size > MAX_PREVIEW_BYTES)
    return { path: relative, content: null, reason: 'File is too large to preview.' };
  const buffer = fs.readFileSync(target);
  if (buffer.includes(0))
    return { path: relative, content: null, reason: 'Binary file.' };
  return { path: relative, content: buffer.toString('utf8') };
}

function writeProjectFile(root, relative, content) {
  const target = resolveInProject(root, relative);
  fs.writeFileSync(target, content, 'utf8');
}

/** Creates an empty file (and its folders); fails if it already exists. */
function createProjectFile(root, relative) {
  const clean = String(relative || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.endsWith('/'))
    throw new Error('Enter a file name, e.g. tests/login.robot');
  const target = resolveInProject(root, clean);
  if (fs.existsSync(target))
    throw new Error(`${clean} already exists.`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '', { encoding: 'utf8', flag: 'wx' });
  return clean;
}

module.exports = {
  validateProjectName,
  checkProjectPathLength,
  detectTools,
  findPython,
  createProject,
  loadProject,
  listTree,
  readProjectFile,
  writeProjectFile,
  createProjectFile,
  resolveInProject,
};
