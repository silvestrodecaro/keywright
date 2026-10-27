'use strict';

// Records real interactions with the Playwright recorder, generates a .robot
// file and runs it with the Robot Framework Browser library.
// Requires a Python with robotframework-browser: set RFIDE_PYTHON or create
// .venv in the project root (see README). Skipped when not available.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { RecorderSession } = require('../src/main/recorder');
const { generateRobot } = require('../src/generator/robotGenerator');

const root = path.join(__dirname, '..');
const python = process.env.RFIDE_PYTHON || [
  path.join(root, '.venv', 'Scripts', 'python.exe'),
  path.join(root, '.venv', 'bin', 'python'),
].find((p) => fs.existsSync(p));

const appUrl = pathToFileURL(path.join(__dirname, 'fixtures', 'app.html')).href;

test('recorded session replays with the Browser library', { skip: !python && 'no Python with robotframework-browser', timeout: 180_000 }, async () => {
  const session = new RecorderSession();
  await session.start({ url: appUrl, headless: true });
  const context = session._context;
  context.on('dialog', (dialog) => dialog.dismiss());
  const page = context.pages()[0];
  await page.waitForTimeout(300);

  await page.getByLabel('User Name').pressSequentially('Ada  Lovelace');
  await page.getByLabel('Remember me').check();
  await page.locator('#color').selectOption('g');
  await page.getByTestId('sign-in').click();
  await page.getByRole('button', { name: 'Ask' }).click();
  await page.frameLocator('iframe').getByRole('button', { name: 'Inner' }).click();
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    page.getByRole('link', { name: 'Open popup' }).click(),
  ]);
  await popup.waitForLoadState();
  await popup.getByRole('button', { name: 'Popup button' }).click();
  await page.getByText('Hello  World').click();
  const headingSnapshot = await page.getByRole('heading').ariaSnapshot();
  await page.waitForTimeout(300);
  await session.stop();

  const actions = session.actions;
  const names = actions.map((a) => a.name);
  assert.deepStrictEqual(names, ['openPage', 'navigate', 'fill', 'check', 'select', 'click', 'click', 'click', 'click', 'click', 'click']);

  // Assertions are normally added with the recorder toolbar; append the
  // equivalent actions so the generated assertion keywords are exercised too.
  const mainGuid = actions[0].pageGuid;
  const popupGuid = actions.find((a) => a.signals.some((s) => s.name === 'popup'))
    .signals.find((s) => s.name === 'popup').popupPageGuid;
  const base = { signals: [], pageGuid: mainGuid };
  actions.push(
    { ...base, name: 'assertValue', selector: actions[2].selector, value: 'Ada  Lovelace' },
    { ...base, name: 'assertChecked', selector: actions[3].selector, checked: true },
    { ...base, name: 'assertVisible', selector: actions[5].selector },
    { ...base, name: 'assertText', selector: '#out', text: 'no', substring: false },
    { ...base, name: 'assertSnapshot', selector: 'internal:role=heading[name="Login"i]', ariaSnapshot: headingSnapshot },
    // The popup button was renamed to "Clicked" by the recorded click.
    { ...base, name: 'assertText', selector: 'internal:role=button', text: 'Clicked', substring: false, pageGuid: popupGuid },
  );

  const robotSource = generateRobot(actions, { testName: 'Replay Recording', headless: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfide-e2e-'));
  const file = path.join(dir, 'recorded.robot');
  fs.writeFileSync(file, robotSource);

  const result = spawnSync(python, ['-m', 'robot', '--outputdir', dir, '--console', 'dotted', file], {
    encoding: 'utf8',
    timeout: 150_000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  assert.strictEqual(result.status, 0, `robot failed:\n${robotSource}\n${result.stdout}\n${result.stderr}`);
});
