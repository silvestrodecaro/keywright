'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, expect } = require('./desktop');
const { openFile } = require('./workspace');

test.use({ projectOnLaunch: true, recorderAccess: true });

async function requestCode(app) {
  // Drive the browser opened by Keywright through its existing test hook.
  // The recorder, its publications to the editor and the generated Robot are real.
  await app.evaluate(async () => {
    const [site] = global.__keywrightSession._context.pages();
    await site.getByLabel('Work email').fill('ada@example.test');
    await site.getByRole('button', { name: 'Request code' }).click();
    await site.getByRole('heading', { name: 'Check your inbox' }).waitFor();
  });
}

test('records through Test Generator, saves Robot code and replays it from Testing', async ({ desktop }) => {
  const { app, page, project } = desktop;
  const file = path.join(project, 'tests', 'recorded.robot');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, file);

  await page.getByRole('tab', { name: /Test Generator/ }).click();
  const generator = page.locator('#pane-generator');
  await generator.getByRole('textbox', { name: 'Start URL' }).fill(pathToFileURL(path.join(project, 'site/index.html')).href);
  await generator.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(generator.getByRole('button', { name: 'Stop', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(generator.locator('#url')).toBeDisabled();
  await requestCode(app);
  await generator.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(generator.getByRole('button', { name: 'Record', exact: true })).toBeVisible();
  await generator.locator('#test-name').fill('Desktop Recording');
  const code = generator.getByLabel('Generated Robot Framework code');
  await expect(code).toContainText('Desktop Recording');
  await expect(code).toContainText('ada@example.test');
  await expect(code).toContainText('Request code');
  const expectedSource = (await code.locator('.line').allTextContents()).join('\n') + '\n';
  await generator.getByRole('button', { name: 'Save…', exact: true }).click();
  await expect.poll(() => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '', {
    message: 'Saved Robot file matches the complete generated code',
  }).toBe(expectedSource);

  await generator.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(generator.locator('#step-count')).toHaveText('0');
  await page.getByRole('tab', { name: 'Testing', exact: true }).click();
  const recorded = page.locator('#test-tree .is-test').filter({ hasText: 'Desktop Recording' });
  await recorded.hover();
  await recorded.getByTitle('Run Desktop Recording', { exact: true }).click();
  await expect(recorded.locator('.status-pass')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#tests-run-all')).toBeEnabled();
});

test('inserts recorded steps at the editor cursor and undoes them together', async ({ desktop }) => {
  const { app, page, project } = desktop;
  const relative = 'tests/inline-recording.robot';
  const file = path.join(project, relative);
  const original = '*** Test Cases ***\nRecord In This Test\n    No Operation\n';
  fs.writeFileSync(file, original);
  const code = await openFile(page, relative);
  await code.click();
  await page.keyboard.press('Control+End');
  await page.locator('#record-at-cursor').click();
  await page.locator('#record-url').fill(pathToFileURL(path.join(project, 'site/index.html')).href);
  await page.locator('#record-start').click();
  await expect(page.locator('#record-label')).toContainText('Recording into inline-recording.robot', { timeout: 30_000 });
  await requestCode(app);
  await expect(code).toContainText('Request code');
  await page.locator('#record-stop').click();
  await expect(page.locator('#record-stop')).toBeHidden();
  await expect(code).toContainText('ada@example.test');
  expect(fs.readFileSync(file, 'utf8')).toBe(original);
  await code.click();
  await page.keyboard.press('Control+Z');
  await expect(code).not.toContainText('ada@example.test');
  await expect(code).not.toContainText('New Page');
  await expect(code).toContainText('No Operation');
});

test('offers a browser that an update made missing, installs it and does not start recording', async ({ desktop }) => {
  const { app, page } = desktop;
  // No download: only the two main-process answers are replaced.
  await app.evaluate(({ ipcMain }) => {
    let installed = false;
    ipcMain.removeHandler('recorder:missing-browser');
    ipcMain.handle('recorder:missing-browser', (_event, name) => (name === 'firefox' && !installed
      ? { install: 'firefox', message: 'Recording and picking locators need a newer firefox than the one installed.' } : null));
    ipcMain.removeHandler('recorder:install-browser');
    ipcMain.handle('recorder:install-browser', () => { installed = true; return { ok: true }; });
  });
  await page.getByRole('tab', { name: /Test Generator/ }).click();
  const notice = page.locator('#error');
  await page.locator('#browser').selectOption('firefox');
  await expect(notice).toContainText('need a newer firefox');
  await page.locator('#browser').selectOption('msedge');
  await expect(notice).toBeHidden();
  await page.locator('#browser').selectOption('firefox');
  await notice.getByRole('button', { name: 'Install firefox' }).click();
  await expect(notice).toBeHidden();
  await expect(page.locator('#record .label')).toHaveText('Record');
  await page.locator('#browser').selectOption('chromium');
  await page.locator('#browser').selectOption('firefox');
  await expect(notice).toBeHidden();
});
