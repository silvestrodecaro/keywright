'use strict';

const { test: base, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');

const test = base.extend({
  projectOnLaunch: [false, { option: true }],
  desktop: async ({ projectOnLaunch }, use, testInfo) => {
    const python = process.env.KEYWRIGHT_PYTHON || [
      path.join(root, '.venv/Scripts/python.exe'),
      path.join(root, '.venv/bin/python'),
    ].find((file) => fs.existsSync(file));
    assert.ok(python, 'UI tests require KEYWRIGHT_PYTHON or a repository .venv with Robot Framework and Browser.');
    execFileSync(python, ['-c', 'import robot, Browser'], { windowsHide: true, timeout: 15_000 });

    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'keywright-ui-'));
    const project = path.join(temporary, 'project');
    const profile = path.join(temporary, 'profile');
    const processLog = [];
    const rendererErrors = [];
    let app;
    let page;
    let tracing = false;
    let fixtureFailed = false;
    try {
      fs.cpSync(path.join(root, 'examples/browser-walkthrough'), project, {
        recursive: true,
        filter: (source) => !['.venv', 'results', '__pycache__'].includes(path.basename(source)),
      });
      const configPath = path.join(project, 'keywright.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      fs.writeFileSync(configPath, JSON.stringify({ ...config, python: path.resolve(python) }));
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      app = await electron.launch({
        executablePath: require('electron'),
        args: [root, `--user-data-dir=${profile}`, ...(projectOnLaunch ? [project] : [])],
        cwd: root,
        env,
        timeout: 30_000,
      });
      for (const stream of ['stdout', 'stderr'])
        app.process()[stream]?.on('data', (chunk) => processLog.push(`[${stream}] ${chunk}`));
      processLog.push('[launch] ' + JSON.stringify(await app.evaluate(({ app }) => ({
        argv: process.argv, isPackaged: app.isPackaged, defaultApp: process.defaultApp, appPath: app.getAppPath(),
      }))) + '\n');
      page = await app.firstWindow();
      page.setDefaultTimeout(15_000);
      page.on('pageerror', (error) => rendererErrors.push(error.stack || error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') processLog.push(`[renderer] ${message.text()}\n`);
      });
      await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
      tracing = true;
      if (!projectOnLaunch) {
        await expect(page.locator('#view-welcome')).toBeVisible();
        await expect(page.getByText('No recent projects.', { exact: true })).toBeVisible();
      }

      await use({ app, page, project, profile });
      expect(rendererErrors, 'Unexpected renderer exceptions').toEqual([]);
    } catch (error) {
      fixtureFailed = true;
      throw error;
    } finally {
      const failed = fixtureFailed || testInfo.status !== testInfo.expectedStatus || rendererErrors.length > 0;
      if (failed && page && !page.isClosed()) {
        const screenshot = testInfo.outputPath('keywright.png');
        await page.screenshot({ path: screenshot }).then(() =>
          testInfo.attach('Keywright window', { path: screenshot, contentType: 'image/png' })
        ).catch((error) => processLog.push(`[screenshot] ${error.message}\n`));
      }
      if (tracing) {
        const trace = failed ? testInfo.outputPath('keywright-trace.zip') : undefined;
        await app.context().tracing.stop(trace ? { path: trace } : {}).catch((error) =>
          processLog.push(`[trace] ${error.message}\n`));
        if (trace && fs.existsSync(trace))
          await testInfo.attach('trace', { path: trace, contentType: 'application/zip' });
      }
      try {
        if (app) await app.close();
      } finally {
        if (failed) {
          fs.mkdirSync(testInfo.outputDir, { recursive: true });
          const log = testInfo.outputPath('electron.log');
          fs.writeFileSync(log, processLog.join('') + rendererErrors.join('\n'));
          await testInfo.attach('Electron log', { path: log, contentType: 'text/plain' });
          const results = path.join(project, 'results');
          if (fs.existsSync(results))
            fs.cpSync(results, testInfo.outputPath('robot-results'), { recursive: true });
        }
        const resolved = fs.realpathSync(temporary);
        assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith('keywright-ui-'));
        fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
  },
});

module.exports = { test, expect };
