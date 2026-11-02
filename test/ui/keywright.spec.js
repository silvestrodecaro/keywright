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

async function runAll(page, passed, failed) {
  await page.getByRole('button', { name: /Run all$/ }).click();
  await expect(page.locator('#tests-summary .status-pass')).toHaveText(`✓ ${passed}`, { timeout: 90_000 });
  await expect(page.locator('#tests-summary .status-fail')).toHaveText(`✕ ${failed}`, { timeout: 90_000 });
  await expect(page.locator('#tests-summary .status-running')).toHaveCount(0);
  await expect(page.locator('#tests-run-all')).toBeEnabled();
}

test('opens the example from a clean profile and runs both tests through the UI', async ({ desktop }) => {
  const { page } = desktop;
  await openExample(desktop);
  await runAll(page, 2, 0);
  await expect(page.locator('#test-tree .is-test .status-pass')).toHaveCount(2);
  await expect(page.locator('#pane-results')).toBeVisible();
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
