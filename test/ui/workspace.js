'use strict';

const { expect } = require('./desktop');

async function openFile(page, relative) {
  await page.getByRole('tab', { name: 'Explorer', exact: true }).click();
  await page.locator(`#tree [data-tree-id="${relative}"] .tree-row`).click();
  await expect(page.locator('#file-path')).toHaveText(relative);
  const code = page.locator('#pane-file .monaco-editor .view-lines');
  await expect(code).toBeVisible();
  return code;
}

async function goToLine(page, code, line) {
  await code.click();
  await page.keyboard.press('Control+Home');
  for (let previous = 1; previous < line; previous++)
    await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
}

module.exports = { openFile, goToLine };
