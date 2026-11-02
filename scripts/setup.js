'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { parseArgs } = require('node:util');
const { browserEnvironment } = require('../src/main/browserEnvironment');

async function main() {
  const { values } = parseArgs({ options: { python: { type: 'string' }, npm: { type: 'string' } } });
  if (!values.python || !values.npm) throw new Error('Run setup.bat to select Python and npm.');
  const root = path.resolve(__dirname, '..');
  for (const file of ['package.json', 'package-lock.json'])
    if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing ${file}. Extract or clone the complete repository first.`);

  const logDirectory = path.join(root, 'out', 'setup');
  fs.mkdirSync(logDirectory, { recursive: true });
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
  const log = path.join(logDirectory, id + '.log');
  const env = browserEnvironment({ ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
  delete env.ELECTRON_RUN_AS_NODE;
  const writeLog = (text) => fs.appendFileSync(log, text, 'utf8');
  console.log(`Setup log: ${log}`);

  function run(title, executable, args, { cwd = root, allowedCodes = [0] } = {}) {
    console.log(`\n[RUN] ${title}`);
    writeLog(`\n${title}\n${JSON.stringify([executable, ...args])}\n`);
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd, env, windowsHide: true, shell: false });
      let output = '';
      let tail = '';
      child.stdout.on('data', (data) => {
        output += data.toString();
        tail = (tail + data).slice(-12_000);
        writeLog(data.toString());
      });
      child.stderr.on('data', (data) => {
        tail = (tail + data).slice(-12_000);
        writeLog(data.toString());
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (!allowedCodes.includes(code)) {
          reject(new Error(`${title} failed (exit ${code}).\n${tail.trim().split(/\r?\n/).slice(-18).join('\n')}\nFull log: ${log}`));
        } else {
          console.log(`[OK] ${title}`);
          resolve(output);
        }
      });
    });
  }

  try {
    const cache = env.PLAYWRIGHT_BROWSERS_PATH;
    if (cache !== '0') {
      if (!path.isAbsolute(cache)) throw new Error('PLAYWRIGHT_BROWSERS_PATH must be an absolute folder or 0.');
      fs.mkdirSync(cache, { recursive: true });
      const probe = path.join(cache, `.keywright-write-check-${randomUUID()}`);
      fs.writeFileSync(probe, '', { flag: 'wx' });
      fs.unlinkSync(probe);
    }
    console.log(`Browser storage: ${cache === '0' ? 'project-local (explicit override)' : cache}`);
    const npm = (title, args, options) => run(title, process.execPath, [values.npm, ...args], options);
    await npm('Install locked app dependencies', ['ci', '--no-audit', '--no-fund']);
    await npm('Install the Electron runtime', ['exec', '--', 'install-electron']);
    await run('Check the Electron executable', process.execPath, [path.join(root, 'node_modules/electron/cli.js'), '--version']);
    await npm('Install the recorder browser', ['run', 'install-browsers']);

    const example = path.join(root, 'examples', 'browser-walkthrough');
    const python = path.join(example, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    if (!fs.existsSync(python))
      await run('Create the example Python environment', values.python, ['-m', 'venv', path.join(example, '.venv')]);
    const version = await run('Check the example Python', python, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])']);
    if (version.trim() !== '3.13')
      throw new Error(`The existing example .venv uses Python ${version.trim()}. Rename that .venv if you want setup to create one with Python 3.13. Existing environments are not deleted.`);
    await run('Install the example Python dependencies', python,
      ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', 'requirements.txt'], { cwd: example });
    await run('Prepare Browser and Chromium in shared storage', python,
      ['-m', 'Browser.entry', 'init', 'chromium'], { cwd: example });
    await npm('Build the editor', ['run', 'build']);
    await run('Run the two supplied browser tests', python,
      ['-m', 'robot', '--outputdir', 'results', 'tests/access.robot'], { cwd: example });

    let audit;
    try {
      audit = JSON.parse(await npm('Check dependency advisories', ['audit', '--json'], { allowedCodes: [0, 1] }));
      if (!audit.metadata?.vulnerabilities) throw new Error('The registry returned no audit summary.');
    } catch (error) {
      console.log(`[WARN] Dependency audit could not be completed. See ${log}`);
      writeLog(`Audit unavailable: ${error.message}\n`);
      audit = null;
    }
    if (audit) {
      const count = audit.metadata.vulnerabilities;
      console.log(`Advisories: ${count.moderate} moderate, ${count.high} high, ${count.critical} critical.`);
      if (count.high || count.critical)
        throw new Error('High or critical dependency advisories need review. Update to a reviewed repository revision or report this setup log.');
      if (count.total)
        console.log('[WARN] Dependency findings remain. See docs/dependency-review.md; setup does not force dependency upgrades.');
    }
    const report = {
      completedAt: new Date().toISOString(), node: process.versions.node, python,
      browserStorage: cache, editorBuild: 'passed', exampleTests: 'passed',
      advisories: audit?.metadata.vulnerabilities || 'unavailable', log,
    };
    fs.writeFileSync(path.join(logDirectory, id + '.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('\nSetup complete. The bundled example is ready to open in Keywright.');
    console.log('To start later, open a terminal in this folder and run: npm.cmd start');
    console.log('If system tools were installed, use a new terminal so it receives their updated PATH.');
  } catch (error) {
    writeLog(`\nSETUP FAILED: ${error.stack || error.message}\n`);
    throw error;
  }
}

main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 1;
});
