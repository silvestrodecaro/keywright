'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('./helpers/tempDir');

const repository = path.resolve(__dirname, '..');
const windows = process.platform === 'win32';

function fixture({ node = '24.16.0', python = '3.13.14' } = {}) {
  const root = path.join(tempDir('setup'), 'OneDrive - Company', 'Desktop', 'Keywright setup check');
  const bin = path.join(root, 'tools');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(bin);
  for (const name of ['setup.bat', 'scripts/setup.ps1']) {
    if (fs.existsSync(path.join(repository, name))) fs.copyFileSync(path.join(repository, name), path.join(root, name));
  }
  const command = (name, text) => fs.writeFileSync(path.join(bin, name + '.cmd'), '@echo off\r\n' + text + '\r\n');
  command('node', 'echo v' + node);
  command('npm', 'echo 12.0.1');
  command('py', 'echo Python ' + python);
  command('git', 'echo git version 2.54.0');
  const marker = path.join(root, 'winget-called');
  command('winget', `echo called > "${marker}"\r\nexit /b 99`);
  const env = { ...process.env, PATH: bin + path.delimiter + path.join(process.env.SystemRoot, 'System32') };
  delete env.CI;
  return { root, marker, env };
}

function run(f, args, input = '') {
  return spawnSync(process.env.ComSpec, ['/d', '/s', '/c', `""${path.join(f.root, 'setup.bat')}" ${args} --no-pause"`], {
    env: f.env, input, encoding: 'utf8', timeout: 30_000, windowsHide: true, windowsVerbatimArguments: true,
  });
}

test('setup checks installed prerequisites from a long folder containing spaces', { skip: !windows }, () => {
  const f = fixture();
  assert.ok(f.root.length > 85);
  const result = run(f, '--check');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /24\.16\.0/);
  assert.match(result.stdout, /3\.13\.14/);
  assert.ok(!fs.existsSync(f.marker));
  assert.ok(!fs.existsSync(path.join(f.root, 'node_modules')));
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
  assert.ok(!fs.existsSync(f.marker));
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
  for (const name of ['scripts/setup.js', 'src/main/browserEnvironment.js', 'package.json', 'package-lock.json']) {
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
