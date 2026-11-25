'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('./desktop');
const { goToLine, openFile } = require('./workspace');

test.use({ projectOnLaunch: true });

async function openTesting(page) {
  await page.getByRole('tab', { name: 'Testing', exact: true }).click();
  await expect(page.locator('#tests-run-all')).toBeEnabled();
}

async function expectResult(page, passed, failed) {
  await expect(page.locator('#tests-summary .status-pass')).toHaveText(`✓ ${passed}`, { timeout: 60_000 });
  await expect(page.locator('#tests-summary .status-fail')).toHaveText(`✕ ${failed}`, { timeout: 60_000 });
  await expect(page.locator('#tests-run-all')).toBeEnabled();
}

test('uses tag filters and dry run, then shows a real Browser trace, Robot report and log', async ({ desktop }) => {
  const { page } = desktop;
  await openTesting(page);
  await page.locator('#run-options summary').click();
  await page.locator('#run-include').fill('access');
  await page.locator('#run-dryrun').check();
  await expect(page.locator('#tests-summary .status-tags')).toContainText('1 match tags');
  await page.locator('#tests-run-all').click();
  await expectResult(page, 1, 0);
  const testRow = page.locator('#test-tree .is-test').filter({ hasText: 'Member Can Request A Code' });
  await testRow.click();
  const trace = page.getByRole('button', { name: 'Trace', exact: true });
  await expect(trace).toBeDisabled();

  await page.locator('#run-dryrun').uncheck();
  await testRow.hover();
  await testRow.getByTitle('Run Member Can Request A Code').click();
  await expect(trace).toBeEnabled({ timeout: 60_000 });
  await expectResult(page, 1, 0);
  await trace.click();
  const viewer = page.locator('iframe.trace-frame');
  await expect(viewer).toBeVisible();
  await expect(viewer.contentFrame().getByText('Actions', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Steps/ }).click();

  await page.getByRole('tab', { name: 'Report', exact: true }).click();
  const output = page.locator('#output-frame');
  await expect(output).toBeVisible();
  await expect(output.contentFrame().getByRole('heading', { name: /Report/ }).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Log', exact: true }).click();
  await expect(output.contentFrame().getByRole('heading', { name: /Log/ }).first()).toBeVisible();
});

test('additional arguments that name the suite keep tests, selected runs and results together', async ({ desktop }) => {
  const { page } = desktop;
  await openTesting(page);
  await page.locator('#run-options summary').click();
  const args = page.locator('#run-args');
  await args.fill('--nosuchoption');
  await args.press('Tab');
  await expect(page.locator('#tests-error')).toContainText('nosuchoption');
  await args.fill('--name "Renamed Suite"');
  await args.press('Tab');
  await expect(page.locator('#test-tree')).toContainText('Renamed Suite');
  await page.locator('#run-dryrun').check();
  const row = page.locator('#test-tree .is-test').filter({ hasText: 'Member Can Request A Code' });
  await row.hover();
  await row.getByTitle('Run Member Can Request A Code').click();
  await expectResult(page, 1, 0);
});

test('offers the browser that the tests miss, then runs them once it is installed', async ({ desktop }, testInfo) => {
  const { app, page } = desktop;
  // The real Browser library fails on an empty storage; only the download is replaced.
  await app.evaluate(({ ipcMain }, empty) => {
    const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = empty;
    global.__installed = [];
    ipcMain.removeHandler('tests:install-browsers');
    ipcMain.handle('tests:install-browsers', (_event, names) => {
      global.__installed.push(names);
      if (previous === undefined)
        delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else
        process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
      return { ok: true };
    });
  }, testInfo.outputPath('no-browsers'));
  await openTesting(page);
  const notice = page.locator('#tests-browsers');
  await expect(notice).toBeHidden();
  await page.locator('#tests-run-all').click();
  await expect(notice).toContainText('has no chromium for its version', { timeout: 60_000 });
  await notice.getByRole('button', { name: 'Install chromium' }).click();
  await expect(notice).toContainText('Installed chromium. Run the tests again.');
  expect(await app.evaluate(() => global.__installed)).toEqual([['chromium']]);
  await page.locator('#tests-run-all').click();
  await expectResult(page, 2, 0);
  await expect(notice).toBeHidden();
});

test('pauses at an editor breakpoint, inspects and watches a value, then steps and continues', async ({ desktop }) => {
  const { page, project } = desktop;
  const relative = 'tests/debug-probe.robot';
  fs.writeFileSync(path.join(project, relative), [
    '*** Test Cases ***', 'Inspect A Value', '    ${count}=    Set Variable    ${42}',
    '    Log    ${count}', '    No Operation', '',
  ].join('\n'));
  const code = await openFile(page, relative);
  await goToLine(page, code, 4);
  await page.keyboard.press('F9');
  await expect(page.locator('#pane-file .breakpoint-glyph')).toHaveCount(1);

  await openTesting(page);
  await page.locator('#tests-debug').check();
  await page.locator('#tests-filter').fill('Inspect A Value');
  await expect(page.locator('#test-tree .is-test')).toHaveCount(1);
  await page.getByRole('button', { name: /Run visible/ }).click();
  await expect(page.locator('#debug-status')).toHaveText('Paused at breakpoint: Log', { timeout: 30_000 });
  await expect(page.locator('#debug-stack')).toContainText('Inspect A Value');
  const evaluate = page.getByRole('textbox', { name: 'Evaluate', exact: true });
  await evaluate.fill('$count + 1');
  await evaluate.press('Enter');
  await expect(page.locator('#debug-console .debug-value')).toHaveText('43');
  await page.locator('#debug-console .debug-evaluation').hover();
  await page.getByTitle('Watch: evaluate at every pause').click();
  await expect(page.locator('#debug-watches .debug-value')).toHaveText('43');
  await page.locator('#debug-over').click();
  await expect(page.locator('#debug-status')).toHaveText('Paused: No Operation');
  await expect(page.locator('#debug-watches .debug-value')).toHaveText('43');
  await page.locator('#debug-watches .debug-evaluation').hover();
  await page.getByTitle('Remove watch', { exact: true }).click();
  await expect(page.locator('#debug-watches .debug-value')).toHaveCount(0);
  await page.locator('#debug-continue').click();
  await expectResult(page, 1, 0);
  await expect(page.locator('#debug-panel')).toBeHidden();
});

test('pauses watch for unsaved edits and compares failed and fixed runs after saving', async ({ desktop }) => {
  const { page, project } = desktop;
  const relative = 'tests/watch-probe.robot';
  const file = path.join(project, relative);
  fs.writeFileSync(file, '*** Test Cases ***\nWatch Probe\n    Fail    watch sentinel\n');
  const code = await openFile(page, relative);
  await openTesting(page);
  const watchRow = page.locator('#test-tree .is-test').filter({ hasText: 'Watch Probe' });
  await watchRow.hover();
  await watchRow.getByTitle('Run Watch Probe', { exact: true }).click();
  await expectResult(page, 0, 1);
  await watchRow.hover();
  await watchRow.getByTitle(/Watch Watch Probe:/).click();
  await expect(page.locator('#tests-summary .status-watching')).toHaveText('◉ watching 1');

  await page.getByRole('tab', { name: 'watch-probe.robot', exact: true }).click();
  await goToLine(page, code, 3);
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Home');
  await page.keyboard.insertText('No Operation');
  fs.appendFileSync(path.join(project, 'resources/access.resource'), '\n# Trigger dependency rediscovery\n');
  await expect(page.locator('#tests-notice')).toContainText('Watch paused: save your open changes to resume');
  expect(fs.readFileSync(file, 'utf8')).toContain('Fail    watch sentinel');
  await page.keyboard.press('Control+S');
  await expectResult(page, 1, 0);
  await expect(code).toBeVisible();
  await expect(page.locator('#tests-notice')).toBeHidden();

  await watchRow.click();
  await page.getByRole('tab', { name: /History/ }).click();
  await expect(page.locator('#history-runs .history-run')).toHaveCount(2);
  const fixed = page.locator('#history-detail section').filter({ has: page.getByRole('heading', { name: 'Fixed (1)' }) });
  await expect(fixed).toContainText('Watch Probe');
  await page.locator('#history-runs .history-run').last().click();
  await page.getByText('All tests of this run (1)', { exact: true }).click();
  const failure = page.locator('#history-detail .history-all .history-message');
  await expect(failure).toBeVisible();
  await expect(failure).toHaveText('watch sentinel');
});

test('cancels a run with unsaved changes, saves on request and stops running Robot', async ({ desktop }) => {
  const { app, page, project } = desktop;
  const relative = 'tests/stop-probe.robot';
  const file = path.join(project, relative);
  const original = '*** Test Cases ***\nStop Probe\n    Sleep    60s\n';
  fs.writeFileSync(file, original);
  await app.evaluate(({ dialog }) => {
    const real = dialog.showMessageBox;
    let response = 2;
    dialog.showMessageBox = async (window, options) => {
      if (options.buttons?.[0] !== 'Save All and Run') return real(window, options);
      const answer = { response };
      response = 0;
      return answer;
    };
  });

  const code = await openFile(page, relative);
  await code.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('    Log    saved before run\n');
  await openTesting(page);
  await page.locator('#tests-filter').fill('Stop Probe');
  await expect(page.locator('#test-tree .is-test')).toHaveCount(1);
  const run = page.getByRole('button', { name: /Run visible/ });
  await run.click();
  await expect(page.locator('#tests-notice')).toHaveText('Run cancelled.');
  expect(fs.readFileSync(file, 'utf8')).toBe(original);
  await run.click();
  await expect(page.locator('#results-detail .step-row')).toContainText('Sleep', { timeout: 30_000 });
  expect(fs.readFileSync(file, 'utf8')).toContain('Log    saved before run');
  await page.locator('#tests-stop').click();
  await expect(page.getByText('Execution was stopped.', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#tests-run-all')).toBeEnabled();
});
