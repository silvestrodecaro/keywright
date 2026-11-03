'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('./helpers/tempDir');

const repository = path.resolve(__dirname, '..');
const windows = process.platform === 'win32';

function fixture({ node = '24.16.0', python = '3.13.14', pythonCommands = {}, banner = true } = {}) {
  const root = path.join(tempDir('setup'), 'OneDrive - Company', 'Desktop', 'Keywright setup check');
  const bin = path.join(root, 'tools');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(bin);
  for (const name of ['setup.bat', 'scripts/setup.ps1', 'package.json', ...(banner ? ['scripts/banner.txt'] : [])]) {
    if (fs.existsSync(path.join(repository, name))) fs.copyFileSync(path.join(repository, name), path.join(root, name));
  }
  const command = (name, text) => fs.writeFileSync(path.join(bin, name + '.cmd'), '@echo off\r\n' + text + '\r\n');
  command('node', 'echo v' + node);
  command('npm', 'echo 12.0.1');
  const pythonCalls = path.join(root, 'python-probes.log');
  // Cover every candidate: an absent fallback would consult the runner's tools
  // and PowerShell command discovery instead of the simulated environment.
  for (const name of ['py', 'python', 'python3'])
    command(name, `echo ${name}>> "${pythonCalls}"\r\necho Python ${pythonCommands[name] ?? python}\r\nexit /b 0`);
  command('git', 'echo git version 2.54.0');
  const marker = path.join(root, 'winget-called');
  command('winget', `echo called > "${marker}"\r\nexit /b 99`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = bin + path.delimiter + path.join(process.env.SystemRoot, 'System32');
  delete env.CI;
  return { root, marker, env, pythonCalls };
}

function run(f, args, input = '') {
  const result = spawnSync(process.env.ComSpec, ['/d', '/s', '/c', `""${path.join(f.root, 'setup.bat')}" ${args} --no-pause"`], {
    env: f.env, input, encoding: 'utf8', timeout: 30_000, windowsHide: true, windowsVerbatimArguments: true,
  });
  if (result.error) {
    result.error.message += `\n${result.stdout || ''}${result.stderr || ''}`;
    throw result.error;
  }
  return result;
}

test('setup checks installed prerequisites from a long folder containing spaces', { skip: !windows }, () => {
  const f = fixture();
  assert.ok(f.root.length > 85);
  const result = run(f, '--check');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const reportedFolder = result.stdout.match(/^Folder: (.+)$/m)?.[1].trim();
  assert.ok(reportedFolder, result.stdout);
  assert.equal(fs.realpathSync.native(reportedFolder).toLowerCase(), fs.realpathSync.native(f.root).toLowerCase());
  assert.match(result.stdout, /24\.16\.0/);
  assert.match(result.stdout, /3\.13\.14/);
  // Redirected output gets the plain title rather than the pixel-art banner.
  assert.match(result.stdout, /^ {2}KEYWRIGHT {2}\d+\.\d+\.\d+$/m);
  assert.match(result.stdout, /^ {2}Record, edit and run Robot Framework web tests {2}· {2}Setup for Windows$/m);
  assert.doesNotMatch(result.stdout, /[▀▄█]/);
  assert.ok(!fs.existsSync(f.marker));
  assert.ok(!fs.existsSync(path.join(f.root, 'node_modules')));
  assert.ok(fs.readdirSync(path.join(f.root, 'out/setup')).some((name) => name.startsWith('bootstrap-')));
});

test('declining a prerequisite installation stops setup without invoking WinGet', { skip: !windows }, () => {
  const f = fixture({ node: '18.0.0' });
  const result = run(f, '', 'n\r\n');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /declined/i);
  assert.ok(!fs.existsSync(f.marker));
});

test('unattended setup fails clearly on an unsupported Python without installing it', { skip: !windows }, () => {
  const f = fixture({ python: '3.9.0' });
  const result = run(f, '--non-interactive');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Python 3\.13/);
  assert.deepEqual(fs.readFileSync(f.pythonCalls, 'utf8').trim().split(/\r?\n/), ['py', 'python', 'python3']);
  assert.ok(!fs.existsSync(f.marker));
});

for (const [candidate, expectedCalls] of [
  ['python', ['py', 'python']],
  ['python3', ['py', 'python', 'python3']],
]) {
  test(`setup can find Python 3.13 through ${candidate} when earlier candidates are unsupported`, { skip: !windows }, () => {
    const f = fixture({ python: '3.9.0', pythonCommands: { [candidate]: '3.13.14' } });
    const result = run(f, '--check');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Python 3\.13\.14/);
    assert.deepEqual(fs.readFileSync(f.pythonCalls, 'utf8').trim().split(/\r?\n/), expectedCalls);
    assert.ok(!fs.existsSync(f.marker));
  });
}

test('setup continues with its plain title when the banner file is missing', { skip: !windows }, () => {
  const f = fixture({ banner: false });
  const result = run(f, '--check');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^ {2}KEYWRIGHT {2}\d+\.\d+\.\d+$/m);
  assert.match(result.stdout, /Prerequisite checks passed/);
});

test('setup rejects unknown options instead of performing an installation', { skip: !windows }, () => {
  const f = fixture();
  const result = run(f, '--unknown');
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /usage|unknown/i);
  assert.ok(!fs.existsSync(f.marker));
});

test('a confirmed WinGet installation failure is reported and stops setup', { skip: !windows }, () => {
  const f = fixture({ node: '18.0.0' });
  fs.writeFileSync(path.join(f.root, 'tools/winget.cmd'), [
    '@echo off',
    'if not "%~3"=="OpenJS.NodeJS.LTS" exit /b 99',
    'if "%~1"=="show" (',
    '  echo 28.0.0',
    '  echo 26.13.0',
    '  echo 24.16.0',
    '  exit /b 0',
    ')',
    'if "%~1"=="install" (',
    '  echo %* | findstr /l /c:"--version 26.13.0" >nul',
    '  if errorlevel 1 exit /b 99',
    '  exit /b 37',
    ')',
    'exit /b 99',
  ].join('\r\n'));
  const result = run(f, '', 'y\r\n');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /exit 37/);
  assert.ok(!fs.existsSync(path.join(f.root, 'node_modules')));
});

test('a dependency installation failure preserves its diagnostic and stops later stages', () => {
  const root = tempDir('setup-failed-install');
  for (const name of ['scripts/setup.js', 'scripts/terminal.js', 'scripts/command.js', 'scripts/electron-runtime.js', 'src/main/browserEnvironment.js', 'package.json', 'package-lock.json']) {
    const source = path.join(repository, name);
    if (!fs.existsSync(source)) continue;
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.copyFileSync(source, path.join(root, name));
  }
  const npm = path.join(root, 'fake-npm.js');
  fs.writeFileSync(npm, `if (process.argv[2] !== 'ci') process.exit(91); console.error('Registry unavailable for setup test'); process.exit(17);`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/setup.js'), '--python', process.execPath, '--npm', npm], {
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'browsers') }, encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Registry unavailable for setup test/);
  assert.match(result.stdout + result.stderr, /17/);
  assert.ok(!fs.existsSync(path.join(root, 'examples/browser-walkthrough/.venv')));
  const logs = fs.readdirSync(path.join(root, 'out/setup'));
  assert.ok(logs.some((name) => fs.readFileSync(path.join(root, 'out/setup', name), 'utf8').includes('Registry unavailable for setup test')));
});

test('setup stops before reinstalling a runtime whose installed executable was removed', { skip: !windows }, () => {
  const root = tempDir('setup-removed-runtime');
  const marker = path.join(root, 'npm-called');
  for (const name of fs.readdirSync(path.join(repository, 'scripts'))) {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(repository, 'scripts', name), path.join(root, 'scripts', name));
  }
  fs.mkdirSync(path.join(root, 'src/main'), { recursive: true });
  fs.copyFileSync(path.join(repository, 'src/main/browserEnvironment.js'), path.join(root, 'src/main/browserEnvironment.js'));
  for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(repository, name), path.join(root, name));
  const dist = path.join(root, 'node_modules/electron/dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'version'), '45.2.1');
  const npm = path.join(root, 'fake-npm.js');
  fs.writeFileSync(npm, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called'); process.exit(17);`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/setup.js'), '--python', process.execPath, '--npm', npm], {
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'browsers') }, encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /quarantin|blocked/i);
  assert.ok(!fs.existsSync(marker), 'setup must not download the removed runtime again');
});
