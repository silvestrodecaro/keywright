'use strict';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test/ui',
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 120_000,
  globalTimeout: 600_000,
  expect: { timeout: 15_000 },
  outputDir: './out/ui-tests',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'out/ui-report', open: 'never' }],
  ],
});
