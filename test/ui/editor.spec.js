'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('./desktop');
const { goToLine, openFile } = require('./workspace');

test.use({ projectOnLaunch: true });

test('previews project replacements across unsaved buffers and files on disk', async ({ desktop }) => {
  const { page, project } = desktop;
  const openPath = 'notes-open.txt';
  const closedPath = 'notes-closed.txt';
  const diskOpen = path.join(project, openPath);
  const diskClosed = path.join(project, closedPath);
  fs.writeFileSync(diskOpen, 'keep this line\n');
  fs.writeFileSync(diskClosed, 'ticket-42\n');
  fs.writeFileSync(path.join(project, 'ignored.md'), 'ticket-13\n');
  const code = await openFile(page, openPath);
  await code.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('ticket-7');
  await page.keyboard.press('Control+Shift+F');

  const query = page.locator('#search-query');
  const summary = page.locator('#search-summary');
  await expect(query).toBeFocused();
  await page.locator('#search-regex').click();
  await query.fill('[');
  await expect(summary).toContainText('Invalid regular expression');
  await expect(page.locator('#search-replace-all')).toBeDisabled();

  await page.locator('#search-include').fill('*.txt');
  await query.fill('ticket-(\\d+)');
  await page.locator('#search-replace').fill('case-$1');
  await expect(summary).toHaveText('2 results in 2 files');
  const previews = page.locator('#search-results ins');
  await expect(previews).toHaveText(['case-42', 'case-7']);
  await page.getByRole('button', { name: 'Replace all', exact: true }).click();
  await expect(page.locator('#search-replace-all')).toHaveText('Replace 2?');
  await page.locator('#search-replace-all').click();
  await expect(summary).toHaveText('No results.');
  await expect(code).toContainText('case-7');
  expect(fs.readFileSync(diskOpen, 'utf8')).toBe('keep this line\n');
  expect(fs.readFileSync(diskClosed, 'utf8')).toBe('case-42\n');
  expect(fs.readFileSync(path.join(project, 'ignored.md'), 'utf8')).toBe('ticket-13\n');

  await code.click();
  await page.keyboard.press('Control+Z');
  await expect(code).toContainText('ticket-7');
  await page.keyboard.press('Control+S');
  await expect.poll(() => fs.readFileSync(diskOpen, 'utf8')).toMatch(/keep this line\r?\nticket-7/);
});

test('shows live diagnostics, suggests a Robot keyword and formats only the editor buffer', async ({ desktop }) => {
  const { page, project } = desktop;
  const relative = 'tests/editor.robot';
  const file = path.join(project, relative);
  const original = '*** Test Cases ***\nEditor Probe\n  Missing Demo Keyword\n';
  fs.writeFileSync(file, original);
  await page.getByRole('tab', { name: 'Problems', exact: true }).click();
  await page.getByLabel('Robocop', { exact: true }).uncheck();
  const problem = page.locator('#problems-list .problem-row').filter({ hasText: 'Missing Demo Keyword' });
  await expect(problem).toBeVisible({ timeout: 60_000 });
  await problem.click();
  await expect(page.locator('#file-path')).toHaveText(relative);
  const code = page.locator('#pane-file .monaco-editor .view-lines');
  await goToLine(page, code, 3);
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Home');
  await page.keyboard.insertText('No Oper');
  await page.keyboard.press('Control+Space');
  const suggestion = page.locator('.suggest-widget').getByText('No Operation', { exact: true });
  await expect(suggestion).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(code).toContainText('No Operation');
  await expect(problem).toHaveCount(0);
  await page.keyboard.press('Shift+Alt+F');
  await expect(page.locator('#editor-status')).toHaveText('Formatted with Robocop');
  expect(fs.readFileSync(file, 'utf8')).toBe(original);
  await page.keyboard.press('Control+S');
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toMatch(/\n {4}No Operation\r?\n/);
});

test('navigates to and renames a resource keyword across editor and disk', async ({ desktop }) => {
  const { page, project } = desktop;
  const relative = 'tests/navigation.robot';
  const file = path.join(project, relative);
  const resource = 'resources/navigation.resource';
  const resourceFile = path.join(project, resource);
  const caller = '*** Settings ***\nResource    ../resources/navigation.resource\n\n*** Test Cases ***\nNavigation Probe\n    Prepare Navigation Sample\n';
  fs.writeFileSync(file, caller);
  fs.writeFileSync(resourceFile, '*** Keywords ***\nPrepare Navigation Sample\n    No Operation\n');

  const code = await openFile(page, relative);
  await expect(page.locator('#editor-status')).toHaveText(/^\d+ keywords$/, { timeout: 60_000 });
  await goToLine(page, code, 6);
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('F12');
  await expect(page.locator('#file-path')).toHaveText(resource);
  await expect(code).toContainText('Prepare Navigation Sample');

  await goToLine(page, code, 2);
  await page.keyboard.press('F2');
  const rename = page.locator('.rename-box input');
  await expect(rename).toBeFocused();
  await rename.fill('Prepare Renamed Sample');
  await rename.press('Enter');
  await expect(code).toContainText('Prepare Renamed Sample');
  expect(fs.readFileSync(resourceFile, 'utf8')).toContain('Prepare Navigation Sample');
  expect(fs.readFileSync(file, 'utf8')).toBe(caller);
  await page.keyboard.press('Control+S');
  await expect.poll(() => fs.readFileSync(resourceFile, 'utf8')).toContain('Prepare Renamed Sample');
  await page.getByRole('tab', { name: 'navigation.robot, unsaved changes', exact: true }).click();
  await expect(code).toContainText('Prepare Renamed Sample');
  await code.click();
  await page.keyboard.press('Control+S');
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain('    Prepare Renamed Sample');
});
