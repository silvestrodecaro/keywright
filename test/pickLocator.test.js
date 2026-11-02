'use strict';

// Picks locators with Playwright's picker (page.pickLocator), in a browser
// without recording and during a recording.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { RecorderSession } = require('../src/main/recorder');
const { toBrowserSelector } = require('../src/generator/selectors');

const appUrl = pathToFileURL(path.join(__dirname, 'fixtures', 'app.html')).href;

/** Hovers and clicks an element the way a user would while picking. */
async function clickWhilePicking(page, locator) {
  await locator.waitFor();
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x - 2, y - 2);
  await page.mouse.move(x, y);
  await page.waitForTimeout(100);
  await page.mouse.click(x, y);
}

async function pick(session, page, locator) {
  const picked = session.pickLocator();
  await page.waitForTimeout(300); // picking mode is enabled asynchronously
  await clickWhilePicking(page, locator);
  return picked;
}

test('picks locators without recording', { timeout: 60_000 }, async () => {
  const session = new RecorderSession();
  await session.start({ url: appUrl, headless: true, record: false });
  try {
    const page = session._context.pages()[0];
    assert.strictEqual(toBrowserSelector(await pick(session, page, page.getByRole('button', { name: 'Ask' }))), 'role=button[name="Ask"i]');
    assert.strictEqual(toBrowserSelector(await pick(session, page, page.getByTestId('sign-in'))), '[data-testid="sign-in"]');
    const inner = page.frameLocator('iframe').getByRole('button', { name: 'Inner' });
    assert.strictEqual(toBrowserSelector(await pick(session, page, inner)), 'iframe >>> role=button[name="Inner"i]');
    assert.deepStrictEqual(session.actions, []);

    // Cancelled picks resolve to null.
    const cancelled = session.pickLocator();
    await page.waitForTimeout(300);
    assert.ok(session.picking);
    await session.cancelPick();
    assert.strictEqual(await cancelled, null);
    assert.ok(!session.picking);
  } finally {
    await session.stop();
  }
});

test('picking during a recording keeps recording', { timeout: 60_000 }, async () => {
  const session = new RecorderSession();
  await session.start({ url: appUrl, headless: true });
  try {
    const page = session._context.pages()[0];
    while (!session.actions.some((action) => action.name === 'navigate'))
      await page.waitForTimeout(100); // openPage and navigate of the start URL
    const before = session.actions.length;
    assert.strictEqual(toBrowserSelector(await pick(session, page, page.getByRole('button', { name: 'Ask' }))), 'role=button[name="Ask"i]');
    assert.deepStrictEqual(session.actions.slice(before).map((a) => a.name), [], 'the picking click is not recorded');
    page.on('dialog', (dialog) => dialog.dismiss());
    await page.getByTestId('sign-in').click();
    await page.waitForTimeout(500);
    assert.deepStrictEqual(session.actions.slice(before).map((a) => a.name), ['click']);
  } finally {
    await session.stop();
  }
});
