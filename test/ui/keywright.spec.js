'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('./desktop');

async function openExample({ app, page, project }) {
  // Electron's folder chooser is native OS UI. Only its selected path is supplied;
  // the welcome button, IPC, project loading and renderer remain real.
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, project);
  await page.getByRole('button', { name: /Open folder/ }).click();
  await expect(page.locator('#view-project')).toBeVisible();
  await expect(page.locator('#view-welcome')).toBeHidden();
  await page.getByRole('tab', { name: 'Testing', exact: true }).click();
  await expect(page.locator('#test-tree .is-test')).toHaveCount(2);
  await expect(page.locator('#tests-run-all')).toBeEnabled();
}

// The crash dialog is native UI: record its options and choose Reload Window.
async function answerCrashDialog(app) {
  await app.evaluate(({ dialog }) => {
    global.__crashDialogs = [];
    dialog.showMessageBox = async (_window, options) => {
      global.__crashDialogs.push(options);
      return { response: 0 };
    };
  });
}

async function runAll(page, passed, failed) {
  await page.getByRole('button', { name: /Run all$/ }).click();
  await expect(page.locator('#tests-summary .status-pass')).toHaveText(`✓ ${passed}`, { timeout: 90_000 });
  await expect(page.locator('#tests-summary .status-fail')).toHaveText(`✕ ${failed}`, { timeout: 90_000 });
  await expect(page.locator('#tests-summary .status-running')).toHaveCount(0);
  await expect(page.locator('#tests-run-all')).toBeEnabled();
}

test('opens the example from a clean profile and runs both tests through the UI', async ({ desktop }, testInfo) => {
  const { page } = desktop;
  const updates = page.locator('#source-update-help');
  await updates.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(updates.locator('pre code')).toContainText('git pull');
  await expect(updates.locator('pre code')).toContainText('.\\setup.bat');
  await expect(updates).toContainText('ZIP');
  await page.screenshot({ path: testInfo.outputPath('source-update-help.png') });
  await updates.locator('summary').click();
  await openExample(desktop);
  await runAll(page, 2, 0);
  await expect(page.locator('#test-tree .is-test .status-pass')).toHaveCount(2);
  await expect(page.locator('#pane-results')).toBeVisible();
});

test('logs startup state and renderer errors before a renderer crash', async ({ desktop }) => {
  const { app, page, processLog } = desktop;
  await expect.poll(() => processLog.join('')).toMatch(/\[startup\] page-state .*"bridgeAvailable":true/);
  await expect.poll(() => processLog.join('')).toMatch(/\[startup\] page-state .*"visibleViews":\["view-welcome"\]/);
  await page.evaluate(() => console.error('Keywright renderer diagnostic probe'));
  await expect.poll(() => processLog.join('')).toMatch(/\[startup\] renderer-console .*Keywright renderer diagnostic probe/);
  await answerCrashDialog(app);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
  await expect.poll(() => processLog.join('')).toMatch(/\[startup\] render-process-gone .*"reason":"(?:crashed|killed)"/);
});

test('a window crash saves a report and reloads, offering the unsaved changes', async ({ desktop }) => {
  const { app, page, profile } = desktop;
  await openExample(desktop);
  await page.getByRole('tab', { name: 'Explorer', exact: true }).click();
  await page.locator('#tree [data-tree-id="tests/access.robot"] .tree-row').click();
  await page.locator('#pane-file .monaco-editor .view-lines').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\nPrivate Test Body\n    Log    not in the crash report');
  const recovery = path.join(profile, 'recovery');
  await expect.poll(() => fs.existsSync(recovery) && fs.readdirSync(recovery).length).toBe(1);

  await answerCrashDialog(app);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());

  const reports = path.join(profile, 'crash-reports');
  await expect.poll(() => fs.existsSync(reports) && fs.readdirSync(reports).length).toBe(1);
  const report = fs.readFileSync(path.join(reports, fs.readdirSync(reports)[0]), 'utf8');
  expect(report).toMatch(/^Event: Window stopped\nreason: (?:crashed|killed)\n/m);
  expect(report).toMatch(/Keywright 0\.\d+\.\d+, Electron \d+/);
  expect(report).toMatch(/ render-process-gone /);
  expect(report).not.toContain('Private Test Body');

  const [dialog] = await app.evaluate(() => global.__crashDialogs);
  expect(dialog.message).toBe('The Keywright window stopped unexpectedly.');
  expect(dialog.buttons).toEqual(['Reload Window', 'Show Crash Report', 'Quit']);
  expect(dialog.detail).toContain(reports);

  // Reload Window: the project opens again and offers the unsaved file. Playwright's
  // page does not survive the crash, so the new page is read through Electron.
  const notice = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
    "document.querySelector('#recovery-notice').hidden ? '' : document.querySelector('#recovery-notice-text').textContent",
  )).catch(() => '');
  await expect.poll(notice, { timeout: 30_000 }).toContain('1 file');
});

test('logs a failed page load instead of losing its error', async ({ desktop }) => {
  const { app, project, processLog } = desktop;
  await app.evaluate(async ({ BrowserWindow }, missing) => {
    await BrowserWindow.getAllWindows()[0].loadFile(missing).catch(() => {});
  }, path.join(project, 'missing-startup-page.html'));
  await expect.poll(() => processLog.join('')).toMatch(/\[startup\] load-failed .*ERR_FILE_NOT_FOUND/);
});

test('logs a preload failure with its original error', async ({ desktop }) => {
  const { app, project, processLog } = desktop;
  const preload = path.join(project, 'broken-preload.js');
  fs.writeFileSync(preload, "throw new Error('Keywright preload diagnostic probe');");
  await app.evaluate(async ({ BrowserWindow }, preload) => {
    const probe = new BrowserWindow({ show: false, webPreferences: {
      preload, sandbox: true, contextIsolation: true, nodeIntegration: false,
    } });
    await probe.loadURL('data:text/html,<title>Startup diagnostic probe</title>');
  }, preload);
  await expect.poll(() => processLog.join('')).toMatch(/\[startup\] preload-error .*Keywright preload diagnostic probe/);
});

test('shows a failed assertion and its screenshot, then navigates to the test source', async ({ desktop }) => {
  const { page, project } = desktop;
  const source = path.join(project, 'tests/access.robot');
  const original = fs.readFileSync(source, 'utf8');
  const changed = original.replace('==    Check your inbox', '==    Welcome back');
  expect(changed).not.toBe(original);
  fs.writeFileSync(source, changed);

  await openExample(desktop);
  await runAll(page, 1, 1);
  await page.locator('#test-tree .is-test').filter({ hasText: 'Member Can Request A Code' }).click();
  await expect(page.locator('#results-detail h2')).toHaveText('Member Can Request A Code');
  const message = page.locator('#results-detail .results-message');
  await expect(message).toContainText('Check your inbox');
  await expect(message).toContainText('Welcome back');
  await expect(page.locator('#results-detail .step-row.is-failed')).toContainText('Get Text');

  const screenshot = page.locator('#results-detail .results-images img').first();
  await expect(screenshot).toBeVisible();
  await screenshot.scrollIntoViewIfNeeded();
  await expect.poll(() => screenshot.evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Go to source', exact: true }).click();
  await expect(page.locator('#pane-file')).toBeVisible();
  await expect(page.locator('#file-path')).toHaveText('tests/access.robot');
  await expect(page.getByRole('tab', { name: 'access.robot', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#pane-file .monaco-editor .view-lines')).toContainText('Welcome back');
});

test('reloads library documentation changed outside the project', async ({ desktop }) => {
  const { page, project } = desktop;
  // A library outside the project folder is not watched, as with an installed package.
  const library = path.join(path.dirname(project), 'external', 'ExternalKeywords.py');
  fs.mkdirSync(path.dirname(library), { recursive: true });
  fs.writeFileSync(library, 'def first_external_keyword():\n    pass\n');
  fs.writeFileSync(path.join(project, 'resources/external.resource'),
    `*** Settings ***\nLibrary    ${library.replace(/\\/g, '/')}\n`);

  await openExample(desktop);
  const status = page.locator('#editor-status');
  await expect(status).toHaveText(/^\d+ keywords$/, { timeout: 60_000 });
  const before = Number((await status.textContent()).match(/\d+/)[0]);

  fs.writeFileSync(library, 'def first_external_keyword():\n    pass\n\ndef second_external_keyword():\n    pass\n');
  await page.getByRole('button', { name: 'Reload libraries' }).click();
  await expect(status).toHaveText(`${before + 1} keywords`, { timeout: 60_000 });
});

test('the command palette opens files and runs commands from the keyboard', async ({ desktop }, testInfo) => {
  const { page } = desktop;
  const palette = page.locator('#palette');
  const input = page.locator('#palette-input');
  const options = page.locator('#palette-list [role="option"]');

  // Without a project only commands are offered, also through Ctrl+P.
  await page.keyboard.press('Control+P');
  await expect(palette).toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('placeholder', 'Type a command');
  await input.pressSequentially('open fold');
  await expect(options.first()).toHaveText('Project: Open Folder…');
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();

  await openExample(desktop);
  await page.getByRole('tab', { name: 'Explorer', exact: true }).click();
  await page.locator('#tree [data-tree-id="tests/access.robot"] .tree-row').click();
  const code = page.locator('#pane-file .monaco-editor').first();
  await page.locator('#pane-file .monaco-editor .view-lines').click();
  await expect(code).toHaveClass(/\bfocused\b/);

  // Ctrl+P from the code editor: files, best match first, then Enter opens it.
  await page.keyboard.press('Control+P');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('');
  await input.pressSequentially('acres');
  await expect(options.first()).toHaveText('access.resourceresources');
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(page.getByRole('tab', { name: 'access.resource', exact: true })).toHaveAttribute('aria-selected', 'true');

  // Ctrl+Shift+P: commands; arrows move the selection.
  await page.keyboard.press('Control+Shift+P');
  await expect(input).toHaveValue('>');
  await input.pressSequentially('show');
  await expect(options.nth(0)).toHaveText('View: Show Explorer');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true');
  await expect(input).toHaveAttribute('aria-activedescendant', await options.nth(2).getAttribute('id'));
  await expect(options.nth(2)).toHaveText('View: Show Problems');
  await page.screenshot({ path: testInfo.outputPath('command-palette.png') });
  await page.keyboard.press('Enter');
  await expect(page.locator('#sidebar-problems')).toBeVisible();

  // Commands that do not apply now are not listed.
  await page.keyboard.press('Control+Shift+P');
  await input.pressSequentially('step over');
  await expect(options).toHaveCount(0);
  await expect(page.locator('#palette-empty')).toHaveText('No matching commands');
  await page.locator('#palette').click({ position: { x: 5, y: 5 } }); // outside the box
  await expect(palette).toBeHidden();

  // Escape closes without running anything and gives the focus back.
  await page.locator('#pane-file .monaco-editor .view-lines').click();
  await page.keyboard.press('Control+Shift+P');
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  await expect(code).toHaveClass(/\bfocused\b/);
});

test('project settings are validated, saved to keywright.json and applied by reopening the project', async ({ desktop }, testInfo) => {
  const { app, page, project } = desktop;
  const config = path.join(project, 'keywright.json');
  // The fixture selects the repository's Python through keywright.json.
  const { python } = JSON.parse(fs.readFileSync(config, 'utf8'));
  fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, 'utf8')), custom: 'kept' }, null, 2));
  fs.mkdirSync(path.join(project, 'suites'));
  fs.writeFileSync(path.join(project, 'suites', 'smoke.robot'), '*** Test Cases ***\nOnly Smoke Test\n    Log    smoke\n');
  await openExample(desktop);

  const dialog = page.getByRole('dialog', { name: 'Project settings' });
  const tests = dialog.getByRole('textbox', { name: 'Tests folder' });
  await page.getByRole('button', { name: 'Project settings' }).click();
  await expect(dialog).toBeVisible();
  await expect(tests).toBeFocused();
  await expect(tests).toHaveValue('tests');
  await expect(dialog.getByRole('textbox', { name: 'Results folder' })).toHaveValue('results');
  await expect(dialog.getByRole('textbox', { name: 'Python interpreter' })).toHaveValue(python);
  await page.screenshot({ path: testInfo.outputPath('project-settings.png') });

  // A missing folder is reported on its field and nothing is written.
  const before = fs.readFileSync(config, 'utf8');
  await tests.fill('missing');
  await dialog.getByRole('button', { name: 'Save and reopen' }).click();
  await expect(dialog.locator('#settings-tests-error')).toHaveText('Folder not found in the project: missing');
  await expect(tests).toHaveAttribute('aria-invalid', 'true');
  await expect(tests).toBeFocused();
  expect(fs.readFileSync(config, 'utf8')).toBe(before);

  // Browse returns an absolute path; the field shows it relative to the project.
  await app.evaluate(({ dialog: native }, folder) => {
    native.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, path.join(project, 'suites'));
  await dialog.getByRole('button', { name: 'Browse for the tests folder' }).click();
  await expect(tests).toHaveValue('suites');

  await dialog.getByRole('button', { name: 'Save and reopen' }).click();
  await expect(dialog).toBeHidden();
  const saved = JSON.parse(fs.readFileSync(config, 'utf8'));
  expect(saved).toMatchObject({ testsDir: 'suites', resourcesDir: 'resources', outputDir: 'results', python: python.replace(/\\/g, '/'), custom: 'kept' });

  // The reopened project discovers the suites in the new folder.
  await page.getByRole('tab', { name: 'Testing', exact: true }).click();
  await expect(page.locator('#test-tree .is-test')).toHaveCount(1);
  await expect(page.locator('#test-tree')).toContainText('Only Smoke Test');

  // Escape closes without saving.
  await page.keyboard.press('Control+Shift+P');
  await page.locator('#palette-input').pressSequentially('project settings');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(tests).toHaveValue('suites');
  await tests.fill('tests');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(JSON.parse(fs.readFileSync(config, 'utf8')).testsDir).toBe('suites');
});

test('offers unsaved changes again after the window crashes', async ({ desktop }) => {
  let { page } = desktop;
  const { project, profile, relaunch } = desktop;
  const source = path.join(project, 'tests/access.robot');
  const original = fs.readFileSync(source, 'utf8');
  await openExample(desktop);
  await page.getByRole('tab', { name: 'Explorer', exact: true }).click();
  await page.locator('#tree [data-tree-id="tests/access.robot"] .tree-row').click();
  await page.locator('#pane-file .monaco-editor .view-lines').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\nRecovered Test\n    Log    kept after a crash');
  await expect(page.getByRole('tab', { name: 'access.robot, unsaved changes' })).toBeVisible();
  const recovery = path.join(profile, 'recovery');
  await expect.poll(() => fs.existsSync(recovery) && fs.readdirSync(recovery).length).toBe(1);

  ({ page } = await relaunch());
  const notice = page.locator('#recovery-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('1 file');
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(notice).toBeHidden();
  await expect(page.getByRole('tab', { name: 'access.robot, unsaved changes' })).toBeVisible();
  await expect(page.locator('#pane-file .monaco-editor .view-lines')).toContainText('kept after a crash');
  expect(fs.readFileSync(source, 'utf8')).toBe(original); // restored as unsaved, not written

  await page.keyboard.press('Control+S');
  await expect(page.getByRole('tab', { name: 'access.robot', exact: true })).toBeVisible();
  expect(fs.readFileSync(source, 'utf8')).toContain('kept after a crash');
  await expect.poll(() => fs.readdirSync(recovery).length).toBe(0);
});

test('discarding recovered changes keeps the files on disk unchanged', async ({ desktop }) => {
  let { page } = desktop;
  const { project, profile, relaunch } = desktop;
  const source = path.join(project, 'tests/access.robot');
  const original = fs.readFileSync(source, 'utf8');
  await openExample(desktop);
  await page.getByRole('tab', { name: 'Explorer', exact: true }).click();
  await page.locator('#tree [data-tree-id="tests/access.robot"] .tree-row').click();
  await page.locator('#pane-file .monaco-editor .view-lines').click();
  await page.keyboard.insertText('# unsaved\n');
  const recovery = path.join(profile, 'recovery');
  await expect.poll(() => fs.existsSync(recovery) && fs.readdirSync(recovery).length).toBe(1);

  ({ page } = await relaunch());
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.locator('#recovery-notice')).toBeHidden();
  await expect.poll(() => fs.readdirSync(recovery).length).toBe(0);
  expect(fs.readFileSync(source, 'utf8')).toBe(original);
});

test('a save conflict can be compared side by side and saved as a combined version', async ({ desktop }) => {
  const { app, page, project } = desktop;
  const source = path.join(project, 'tests/access.robot');
  await openExample(desktop);
  await page.getByRole('tab', { name: 'Explorer', exact: true }).click();
  await page.locator('#tree [data-tree-id="tests/access.robot"] .tree-row').click();
  await page.locator('#pane-file .monaco-editor .view-lines').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n# added in Keywright');
  fs.writeFileSync(source, '# added on disk\n' + fs.readFileSync(source, 'utf8'));
  // The native conflict dialog is OS UI: only its answer, Compare, is supplied.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  // At the minimum window width the comparison must stay side by side, as its labels say.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 700));

  await page.keyboard.press('Control+S');
  const view = page.getByRole('dialog', { name: 'tests/access.robot changed on disk' });
  await expect(view).toBeVisible();
  await expect(view.locator('.editor.original .view-lines')).toContainText('# added on disk');
  await expect(view.locator('.editor.original')).toBeVisible();
  await expect(view.locator('.editor.modified .line-delete')).toHaveCount(0); // no inline view
  await expect(view.locator('.editor.modified .view-lines:not(.line-delete)')).toContainText('# added in Keywright');
  await view.locator('.editor.modified .view-lines:not(.line-delete)').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.insertText('# added on disk\n');
  await view.getByRole('button', { name: 'Save Your Version' }).click();

  await expect(view).toBeHidden();
  await expect(page.getByRole('tab', { name: 'access.robot', exact: true })).toBeVisible();
  const saved = fs.readFileSync(source, 'utf8');
  expect(saved.startsWith('# added on disk\n')).toBe(true);
  expect(saved).toContain('# added in Keywright');
  await expect(page.locator('#pane-file .monaco-editor .view-lines').first()).toContainText('# added on disk');
});

test.describe('a project supplied on startup', () => {
  test.use({ projectOnLaunch: true });

  test('opens the requested project when Electron debugger switches precede the app path', async ({ desktop }) => {
    const { page, project } = desktop;
    await expect(page.locator('#view-project')).toBeVisible();
    await expect(page.locator('#view-welcome')).toBeHidden();
    await expect(page.locator('#project-root')).toHaveText(project);
    await page.getByRole('tab', { name: 'Testing', exact: true }).click();
    await expect(page.locator('#test-tree .is-test')).toHaveCount(2);
  });
});

test('web links open in the system browser instead of an app window', async ({ desktop }) => {
  const { app, page } = desktop;
  // The system browser is outside the test: record what would be handed to it.
  await app.evaluate(({ shell }) => {
    globalThis.openedExternally = [];
    shell.openExternal = async (url) => { globalThis.openedExternally.push(url); };
  });
  const start = page.url();

  // As a link in keyword documentation does when clicked.
  await page.evaluate(() => window.open('https://robotframework-browser.org/', '_blank'));
  await expect.poll(() => app.evaluate(() => globalThis.openedExternally)).toEqual(['https://robotframework-browser.org/']);
  expect(app.windows()).toHaveLength(1);

  // Other schemes are neither opened nor loaded in the app.
  await page.evaluate(() => window.open('file:///C:/Windows/notepad.exe'));
  await page.evaluate(() => { location.href = 'https://example.com/'; });
  await page.waitForTimeout(500);
  expect(page.url()).toBe(start);
  expect(app.windows()).toHaveLength(1);
  expect(await app.evaluate(() => globalThis.openedExternally)).toEqual(['https://robotframework-browser.org/', 'https://example.com/']);
});
