'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('./desktop');

test('validates project creation, scaffolds a project and manages the recent entry', async ({ desktop }) => {
  const { app, page, project } = desktop;
  const parent = path.dirname(project);
  const created = path.join(parent, 'Regression workspace');
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, parent);

  await page.getByRole('button', { name: /New project/ }).click();
  await page.getByRole('button', { name: /Browse/ }).click();
  await expect(page.locator('#create-location')).toHaveValue(parent);
  const name = page.locator('#create-name');
  const submit = page.getByRole('button', { name: 'Create project', exact: true });
  await page.locator('#opt-venv').uncheck();
  await expect(page.locator('#opt-browsers')).toBeDisabled();
  await page.locator('#opt-git').uncheck();
  await name.fill('project');
  await submit.click();
  await expect(page.locator('#create-error')).toContainText('already exists');
  await name.fill('Regression workspace');
  await expect(page.locator('#create-path')).toHaveText(created);
  await submit.click();
  await expect(page.locator('#setup-result')).toHaveText('Project created.');
  expect(JSON.parse(fs.readFileSync(path.join(created, 'keywright.json'), 'utf8'))).toMatchObject({
    testsDir: 'tests', resourcesDir: 'resources', outputDir: 'results',
  });
  expect(fs.existsSync(path.join(created, '.venv'))).toBe(false);

  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await expect(page.locator('#project-name')).toHaveText('Regression workspace');
  await page.getByRole('button', { name: 'Close project', exact: true }).click();
  const recent = page.locator('#recent').getByRole('button', { name: /Regression workspace/ });
  await recent.click();
  await expect(page.locator('#view-project')).toBeVisible();
  await expect(page.locator('#project-root')).toHaveText(created);
  await page.getByRole('button', { name: 'Close project', exact: true }).click();
  await recent.hover();
  await page.locator('#recent').getByTitle('Remove from list').click();
  await expect(page.getByText('No recent projects.', { exact: true })).toBeVisible();
  expect(fs.existsSync(path.join(created, 'keywright.json'))).toBe(true);
});
