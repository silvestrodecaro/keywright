'use strict';

// The AI's browser in a real Chromium: actions on snapshot refs, the Browser
// steps they produce, assertions, dialogs, frames and popups.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { AgentBrowser } = require('../src/main/mcp/agentBrowser');

const appUrl = pathToFileURL(path.join(__dirname, 'fixtures', 'app.html')).href;

/** The ref of the first snapshot line containing `label`. */
function refOf(snapshot, label) {
  const line = snapshot.split('\n').find((text) => text.includes(label));
  assert.ok(line, `no "${label}" in the snapshot:\n${snapshot}`);
  return /\[ref=(\w+)\]/.exec(line)[1];
}

const stepOf = (result) => result.split('\n\n')[0];

test('browser actions on refs produce the Browser steps of a complete test', { timeout: 90_000 }, async (t) => {
  const browser = new AgentBrowser();
  t.after(() => browser.close());
  await browser.start({ headless: true });
  let snapshot = await browser.navigate(appUrl);
  assert.match(snapshot, /^Robot step:\n {4}Go To {4}file:/);
  assert.match(snapshot, /textbox "User Name" \[ref=e\d+\]/);

  const fill = await browser.fill(refOf(snapshot, 'textbox "User Name"'), 'Ada');
  assert.equal(stepOf(fill), 'Robot step:\n    Fill Text    role=textbox[name="User Name"i]    Ada');
  snapshot = fill;
  const click = await browser.click(refOf(snapshot, 'button "Sign in"'));
  assert.equal(stepOf(click), 'Robot step:\n    Click    [data-testid="sign-in"]');
  snapshot = click;

  const check = await browser.assert(refOf(snapshot, 'Welcome Ada'), 'text', { text: 'Welcome Ada', exact: true });
  assert.match(check, /Get Text {4}.+ {4}== {4}Welcome Ada/);
  snapshot = await browser.snapshot();
  await assert.rejects(browser.assert(refOf(snapshot, 'Welcome Ada'), 'text', { text: 'Goodbye' }), /assertion failed.*It was not added/);

  snapshot = await browser.snapshot();
  const dialog = await browser.click(refOf(snapshot, 'button "Ask"'));
  assert.match(dialog, /Handle Future Dialogs {4}action=dismiss\n {4}Click {4}role=button\[name="Ask"i\]/);
  assert.match(dialog, /A confirm dialog said "Sure\?" and was dismissed\./);
  snapshot = dialog;

  assert.match(stepOf(await browser.select(refOf(snapshot, 'combobox'), ['Green'])), /Select Options By {4}\\#color {4}value {4}g/);
  snapshot = await browser.snapshot();
  assert.match(stepOf(await browser.click(refOf(snapshot, 'button "Inner"'))), /Click {4}iframe >>> role=button\[name="Inner"i\]/);

  snapshot = await browser.snapshot();
  const popup = await browser.click(refOf(snapshot, 'link "Open popup"'));
  assert.match(popup, /Switch Page {4}NEW/);
  assert.match(await browser.tabs(), /^1\. .*\n2\. \(active\)/);

  const robot = browser.steps({ complete: true, testName: 'Sign In' });
  assert.match(robot, /\*\*\* Test Cases \*\*\*\nSign In\n {4}New Browser {4}chromium {4}headless=False\n {4}New Context\n {4}\$\{page\}= {4}New Page {4}file:/);
  assert.match(robot, /Fill Text {4}role=textbox\[name="User Name"i\] {4}Ada\n {4}Click {4}\[data-testid="sign-in"\]\n {4}Get Text/);
});

test('refs need a snapshot of the active page and must be current', { timeout: 60_000 }, async (t) => {
  const browser = new AgentBrowser();
  t.after(() => browser.close());
  await assert.rejects(browser.snapshot(), /No browser is open/);
  await browser.start({ headless: true });
  await assert.rejects(browser.click('e1'), /Take a browser_snapshot/);
  await browser.navigate(appUrl);
  await assert.rejects(browser.click('e999'), /not in the latest snapshot/);
  const failed = browser.actions.length;
  await browser.snapshot();
  await assert.rejects(browser.fill(refOf(await browser.snapshot(), 'heading "Login"'), 'x'), /fill failed/);
  assert.equal(browser.actions.length, failed, 'a failed action is not recorded');

  browser.clearSteps();
  assert.equal(browser.steps(), `New Page    ${appUrl}`);
  await browser.close();
  assert.equal(browser.open, false);
});

test('back, forward and reload move through the history and are recorded', { timeout: 60_000 }, async (t) => {
  const browser = new AgentBrowser();
  t.after(() => browser.close());
  await browser.start({ headless: true });
  await browser.navigate(appUrl);
  await assert.rejects(browser.history('forward'), /no page to go forward to/);
  const popupUrl = pathToFileURL(path.join(__dirname, 'fixtures', 'popup.html')).href;
  await browser.navigate(popupUrl);

  const back = await browser.history('back');
  assert.equal(stepOf(back), 'Robot step:\n    Go Back');
  assert.match(back, /textbox "User Name"/);
  const forward = await browser.history('forward');
  assert.equal(stepOf(forward), 'Robot step:\n    Go Forward');
  assert.match(forward, /button "Popup button"/);
  assert.equal(stepOf(await browser.history('reload')), 'Robot step:\n    Reload');
  await assert.rejects(browser.history('forward'), /no page to go forward to/);

  assert.equal(browser.steps(), [`New Page    ${appUrl}`, `Go To    ${popupUrl}`, 'Go Back', 'Go Forward', 'Reload'].join('\n'));
});

test('back reaches a page of another origin', { timeout: 60_000 }, async (t) => {
  // The Navigation API only lists same-origin entries, so it cannot tell whether
  // a cross-origin page such as about:blank has a previous entry.
  const browser = new AgentBrowser();
  t.after(() => browser.close());
  await browser.start({ headless: true, url: appUrl });
  await browser.navigate('about:blank');

  const back = await browser.history('back');
  assert.equal(stepOf(back), 'Robot step:\n    Go Back');
  assert.match(back, /textbox "User Name"/);
  const forward = await browser.history('forward');
  assert.equal(stepOf(forward), 'Robot step:\n    Go Forward');
  assert.match(forward, /about:blank/);
});
