'use strict';

const { EventEmitter } = require('events');
const playwright = require('playwright-core');
const { toBrowserSelector } = require('../../generator/selectors');
const { generateRobot, generateSteps } = require('../../generator/robotGenerator');
const { normalizeUrl } = require('../recorder');
const { ToolError } = require('./protocol');

const MAX_SNAPSHOT_CHARS = 60_000;
const ASSERT_TIMEOUT = 5_000;
const ACTION_TIMEOUT = 10_000;
const SETTLE_TIMEOUT = 3_000;
const POPUP_WAIT = 600;

// Playwright's modifier bitmask, as in recorded actions (see robotGenerator.js).
const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

const normalizeSpace = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * A headed browser driven by an AI client through the MCP tools. The model reads
 * the page as an aria snapshot with element refs (`[ref=e5]`) and acts on refs.
 *
 * Every action first turns the ref into the resilient locator Playwright's codegen
 * would write (Locator.normalize), acts through that locator, and records the
 * action in the recorder's format. The same generator as the Test Generator then
 * produces the Browser library steps, so what the model did in the browser and
 * what the script does use the same selectors.
 *
 * Events:
 *  - 'state' ({ open: boolean, url?: string })
 *  - 'actions' (actions: object[])
 */
class AgentBrowser extends EventEmitter {
  /** @param {{ headless?: boolean }} [defaults] headless is only meant for tests */
  constructor({ headless = false } = {}) {
    super();
    this.headless = headless;
    this.actions = [];
    this.options = { browser: 'chromium', channel: null, viewport: null };
    this._browser = null;
    this._context = null;
    this._page = null;
    this._pageIds = new WeakMap();
    this._nextPage = 1;
    this._snapshotPages = new WeakSet(); // pages whose refs come from a snapshot
    this._events = []; // dialogs and popups since the last tool result
  }

  get open() {
    return !!this._browser;
  }

  /**
   * @param {{ browser?: string, channel?: string|null, url?: string, viewport?: {width:number,height:number}|null,
   *           headless?: boolean }} options headless is only meant for tests
   */
  async start(options = {}) {
    if (this._browser)
      throw new ToolError('The browser is already open. Use browser_navigate, or browser_close first.');
    const browserType = playwright[options.browser || 'chromium'];
    if (!browserType)
      throw new ToolError(`Unknown browser: ${options.browser}`);
    this.options = { browser: options.browser || 'chromium', channel: options.channel || null, viewport: options.viewport || null };
    this.actions = [];
    this.emit('actions', this.actions);
    const browser = await browserType.launch({ headless: !!(options.headless ?? this.headless), ...(options.channel ? { channel: options.channel } : {}) });
    this._browser = browser;
    browser.on('disconnected', () => this._onClosed(browser));
    try {
      this._context = await browser.newContext({ viewport: options.viewport || { width: 1280, height: 720 } });
      this._context.setDefaultTimeout(ACTION_TIMEOUT);
      this._context.on('page', (page) => this._track(page));
      const page = await this._context.newPage();
      this._track(page);
      this._record({ name: 'openPage', url: 'about:blank' }, page);
      if (options.url)
        await this.navigate(options.url);
      this.emit('state', { open: true });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close() {
    const browser = this._browser;
    if (browser)
      await browser.close().catch(() => {});
    this._onClosed(browser);
  }

  _onClosed(browser) {
    if (!browser || this._browser !== browser)
      return;
    this._browser = null;
    this._context = null;
    this._page = null;
    this.emit('state', { open: false });
  }

  _track(page) {
    if (this._pageIds.has(page))
      return;
    this._pageIds.set(page, `page-${this._nextPage++}`);
    this._page = page;
    page.on('dialog', (dialog) => {
      // Like the recorder: dismissed, and the generated test dismisses it too.
      this._events.push(`A ${dialog.type()} dialog said "${dialog.message()}" and was dismissed.`);
      this._signal({ name: 'dialog', dialogAlias: '' });
      dialog.dismiss().catch(() => {});
    });
    page.on('popup', (popup) => {
      this._track(popup);
      this._events.push(`A new page opened (${popup.url() || 'loading'}) and is now the active page.`);
      this._signal({ name: 'popup', popupPageGuid: this._pageIds.get(popup) });
    });
    page.on('close', () => {
      if (this._page === page)
        this._page = this._context?.pages().at(-1) || null;
      // Closing the last window ends the session, as in the Test Generator.
      if (this._context && this._context.pages().length === 0)
        this.close();
    });
  }

  _signal(signal) {
    const last = this.actions.at(-1);
    if (!last)
      return;
    last.signals = [...(last.signals || []), signal];
    this.emit('actions', this.actions);
  }

  _record(action, page = this._page) {
    const recorded = { ...action, pageGuid: this._pageIds.get(page), signals: [] };
    this.actions.push(recorded);
    this.emit('actions', this.actions);
    return recorded;
  }

  _discard(recorded) {
    const index = this.actions.lastIndexOf(recorded);
    if (index >= 0) {
      this.actions.splice(index, 1);
      this.emit('actions', this.actions);
    }
  }

  _activePage() {
    if (!this._browser)
      throw new ToolError('No browser is open. Call browser_open first.');
    if (!this._page || this._page.isClosed())
      this._page = this._context.pages().at(-1) || null;
    if (!this._page)
      throw new ToolError('The browser has no open page. Call browser_close, then browser_open.');
    return this._page;
  }

  async navigate(url) {
    const page = this._activePage();
    const target = normalizeUrl(String(url));
    const recorded = this._record({ name: 'navigate', url: target }, page);
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (error) {
      this._discard(recorded);
      throw new ToolError(`Could not open ${target}: ${firstLine(error)}`);
    }
    recorded.url = page.url(); // after redirects
    return this._result(recorded);
  }

  /**
   * Moves through the active page's history, or reloads it, recorded as Go Back,
   * Go Forward or Reload.
   * @param {'back' | 'forward' | 'reload'} direction
   */
  async history(direction) {
    const page = this._activePage();
    const options = { waitUntil: 'domcontentloaded', timeout: 30_000 };
    // The Navigation API's canGoBack is no guide here: it only sees same-origin
    // entries, so from about:blank or a file: page it reports false. Playwright
    // returns null without moving when the history has no such entry.
    const name = { back: 'goBack', forward: 'goForward', reload: 'reload' }[direction];
    const before = page.url();
    const recorded = this._record({ name }, page);
    let response;
    try {
      response = direction === 'reload' ? await page.reload(options)
        : direction === 'back' ? await page.goBack(options) : await page.goForward(options);
    } catch (error) {
      this._discard(recorded);
      throw new ToolError(`Could not go ${direction}: ${firstLine(error)}`);
    }
    // Nothing happened when neither a load nor the address changed.
    if (direction !== 'reload' && response === null && page.url() === before) {
      this._discard(recorded);
      throw new ToolError(`There is no page to go ${direction} to in this page's history.`);
    }
    return this._result(recorded);
  }

  /** The page as an aria snapshot with refs, plus its title, address and other pages. */
  async snapshot() {
    const page = this._activePage();
    await page.waitForLoadState('domcontentloaded', { timeout: SETTLE_TIMEOUT }).catch(() => {});
    let yaml = await page.ariaSnapshot({ mode: 'ai' });
    this._snapshotPages.add(page);
    if (yaml.length > MAX_SNAPSHOT_CHARS)
      yaml = `${yaml.slice(0, MAX_SNAPSHOT_CHARS)}\n… (snapshot truncated at ${MAX_SNAPSHOT_CHARS} characters)`;
    const pages = this._context.pages();
    const lines = [`Page: ${await page.title().catch(() => '')} — ${page.url()}`];
    if (pages.length > 1)
      lines.push(`Pages: ${pages.length}, active: ${pages.indexOf(page) + 1} (switch with browser_tabs)`);
    lines.push('', yaml);
    return lines.join('\n');
  }

  /**
   * The locator for `ref` that a script would use, and the Browser selector for it.
   * @returns {Promise<{ page: object, locator: object, selector: string, unique: boolean }>}
   */
  async resolve(ref) {
    const page = this._activePage();
    if (!this._snapshotPages.has(page))
      throw new ToolError('Take a browser_snapshot of this page first: refs come from the latest snapshot.');
    const clean = String(ref).trim().replace(/^\[?ref=/, '').replace(/\]$/, '');
    let normalized;
    try {
      normalized = await page.getByRef(clean).normalize();
    } catch (error) {
      throw new ToolError(`Ref ${clean} is not in the latest snapshot (${firstLine(error)}). Take a new browser_snapshot.`);
    }
    const internal = normalized._selector;
    const count = await normalized.count().catch(() => 0);
    // A locator matching several elements would fail in Browser's strict mode:
    // act on the ref itself and report the selector as needing review.
    return { page, locator: count === 1 ? normalized : page.getByRef(clean), selector: internal, browserSelector: toBrowserSelector(internal), unique: count === 1 };
  }

  async click(ref, { button = 'left', doubleClick = false, modifiers = [] } = {}) {
    const target = await this.resolve(ref);
    const mask = modifiers.reduce((sum, name) => sum | (MODIFIER_BITS[name] || 0), 0);
    const clickCount = doubleClick ? 2 : 1;
    // A popup opens shortly after the click returns: give it a moment, so the
    // step records it and the result reports the new active page.
    const popup = target.page.waitForEvent('popup', { timeout: POPUP_WAIT }).catch(() => null);
    return this._act(target, { name: 'click', button, modifiers: mask, clickCount }, async () => {
      await target.locator.click({ button, clickCount, modifiers });
      await popup;
    });
  }

  async fill(ref, text, { submit = false } = {}) {
    const target = await this.resolve(ref);
    if (!submit)
      return this._act(target, { name: 'fill', text: String(text) }, () => target.locator.fill(String(text)));
    const filled = await this._act(target, { name: 'fill', text: String(text) }, () => target.locator.fill(String(text)), { snapshot: false });
    const pressed = await this._act(target, { name: 'press', key: 'Enter', modifiers: 0 }, () => target.locator.press('Enter'));
    return `${filled}
${pressed}`;
  }

  async press(ref, key) {
    const target = await this.resolve(ref);
    return this._act(target, { name: 'press', key: String(key), modifiers: 0 }, () => target.locator.press(String(key)));
  }

  async hover(ref) {
    const target = await this.resolve(ref);
    return this._act(target, { name: 'hover' }, () => target.locator.hover());
  }

  async setChecked(ref, checked) {
    const target = await this.resolve(ref);
    return this._act(target, { name: checked ? 'check' : 'uncheck' }, () => target.locator.setChecked(!!checked));
  }

  async select(ref, values) {
    const target = await this.resolve(ref);
    const recorded = this._record({ name: 'select', selector: target.selector, options: [] }, target.page);
    try {
      // Matches option values or labels; the script selects by the values found.
      recorded.options = await target.locator.selectOption(values.map(String));
    } catch (error) {
      this._discard(recorded);
      throw new ToolError(`select failed on ${target.browserSelector}: ${firstLine(error)}`);
    }
    return this._result(recorded, target);
  }

  /**
   * Checks the page now (waiting up to 5 s) and records the assertion for the script.
   * @param {'text'|'visible'|'value'|'checked'} kind
   */
  async assert(ref, kind, { text, exact = false, value, checked = true } = {}) {
    const target = await this.resolve(ref);
    const { locator } = target;
    let action;
    let check;
    switch (kind) {
      case 'visible':
        action = { name: 'assertVisible' };
        check = async () => ({ ok: await locator.isVisible(), actual: 'not visible' });
        break;
      case 'text': {
        if (typeof text !== 'string')
          throw new ToolError('kind "text" needs the expected "text".');
        action = { name: 'assertText', text, substring: !exact };
        check = async () => {
          // biome-ignore lint/performance/useDomNodeTextContent: Playwright's Locator.innerText, the rendered text Browser's Get Text compares
          const actual = normalizeSpace(await locator.innerText());
          const expected = normalizeSpace(text);
          return { ok: exact ? actual === expected : actual.includes(expected), actual: `"${actual}"` };
        };
        break;
      }
      case 'value':
        if (typeof value !== 'string')
          throw new ToolError('kind "value" needs the expected "value".');
        action = { name: 'assertValue', value };
        check = async () => {
          const actual = await locator.inputValue();
          return { ok: actual === value, actual: `"${actual}"` };
        };
        break;
      case 'checked':
        action = { name: 'assertChecked', checked: !!checked };
        check = async () => {
          const actual = await locator.isChecked();
          return { ok: actual === !!checked, actual: actual ? 'checked' : 'unchecked' };
        };
        break;
      default:
        throw new ToolError(`Unknown assertion kind: ${kind}`);
    }
    const deadline = Date.now() + ASSERT_TIMEOUT;
    let last = { ok: false, actual: 'unknown' };
    for (;;) {
      last = await check().catch((error) => ({ ok: false, actual: firstLine(error) }));
      if (last.ok || Date.now() > deadline)
        break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!last.ok)
      throw new ToolError(`The assertion failed on ${target.browserSelector}: found ${last.actual}. It was not added to the steps.`);
    const recorded = this._record({ ...action, selector: target.selector }, target.page);
    return this._result(recorded, target, { snapshot: false });
  }

  /** Waits for a text to appear or disappear on the page, or for some seconds. */
  async waitFor({ text, textGone, seconds } = {}) {
    const page = this._activePage();
    if (text)
      await page.getByText(String(text)).first().waitFor({ state: 'visible', timeout: 30_000 })
        .catch(() => { throw new ToolError(`"${text}" did not appear within 30 seconds.`); });
    if (textGone)
      await page.getByText(String(textGone)).first().waitFor({ state: 'hidden', timeout: 30_000 })
        .catch(() => { throw new ToolError(`"${textGone}" was still visible after 30 seconds.`); });
    if (seconds)
      await page.waitForTimeout(Math.min(Number(seconds), 30) * 1000);
    return this.snapshot();
  }

  async screenshot({ fullPage = false } = {}) {
    const page = this._activePage();
    const data = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: !!fullPage });
    return { type: 'image', data: data.toString('base64'), mimeType: 'image/jpeg' };
  }

  /** Lists the pages, or makes page `select` (1-based) the active one. */
  async tabs(select) {
    this._activePage();
    const pages = this._context.pages();
    if (select !== undefined) {
      const page = pages[Number(select) - 1];
      if (!page)
        throw new ToolError(`There is no page ${select}; there ${pages.length === 1 ? 'is 1 page' : `are ${pages.length} pages`}.`);
      this._page = page;
      await page.bringToFront().catch(() => {});
    }
    const lines = [];
    for (const [index, page] of pages.entries())
      lines.push(`${index + 1}. ${page === this._page ? '(active) ' : ''}${await page.title().catch(() => '')} — ${page.url()}`);
    return lines.join('\n');
  }

  /** The Robot steps recorded so far, or a complete test. */
  steps({ testName, complete = false } = {}) {
    if (complete)
      return generateRobot(this.actions, { ...this.options, testName: testName || 'Generated Test', headless: false });
    return generateSteps(this.actions).join('\n');
  }

  clearSteps() {
    // Keep the open page, so later steps still start from a page the script opens.
    const page = this._page && !this._page.isClosed() ? this._page : null;
    this.actions = [];
    if (page)
      this._record({ name: 'openPage', url: page.url() }, page);
    this.emit('actions', this.actions);
  }

  async _act(target, action, perform, options) {
    const recorded = this._record({ ...action, selector: target.selector }, target.page);
    try {
      await perform();
    } catch (error) {
      this._discard(recorded);
      throw new ToolError(`${action.name} failed on ${target.browserSelector}: ${firstLine(error)}`);
    }
    return this._result(recorded, target, options);
  }

  /** The step just recorded, page events, and a fresh snapshot (refs change after actions). */
  async _result(recorded, target = null, { snapshot = true } = {}) {
    const lines = [];
    // A page opened before the step (a non-blank address, so a navigation stays Go To).
    const opened = { name: 'openPage', url: 'https://page.invalid', pageGuid: recorded.pageGuid, signals: [] };
    const step = generateSteps([opened, recorded]).slice(1);
    if (step.length)
      lines.push('Robot step:', ...step.map((line) => `    ${line}`));
    if (target && !target.unique)
      lines.push(`Note: ${target.browserSelector} matches several elements. Browser's strict mode will fail on it; choose a more specific selector in the script.`);
    lines.push(...this._events.splice(0));
    if (snapshot) {
      const page = this._page && !this._page.isClosed() ? this._page : null;
      if (page) {
        await page.waitForLoadState('domcontentloaded', { timeout: SETTLE_TIMEOUT }).catch(() => {});
        lines.push('', await this.snapshot().catch((error) => `Could not take a snapshot: ${firstLine(error)}`));
      }
    }
    return lines.join('\n');
  }
}

function firstLine(error) {
  return String(error?.message || error).split('\n')[0];
}

module.exports = { AgentBrowser };
