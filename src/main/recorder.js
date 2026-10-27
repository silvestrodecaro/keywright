'use strict';

const { EventEmitter } = require('events');
const playwright = require('playwright-core');

/**
 * Drives a headed Playwright browser with the recorder enabled and keeps the
 * list of recorded actions.
 *
 * NOTE: this relies on BrowserContext._startRecording/_stopRecording, a
 * private Playwright API (the one behind the recorder toolbar). playwright-core
 * is pinned to an exact version in package.json; re-check this file whenever it
 * is upgraded.
 *
 * Events:
 *  - 'actions' (actions: object[])  the recorded action list changed
 *  - 'stopped' ()                   the browser was closed or stop() was called
 */
class RecorderSession extends EventEmitter {
  constructor() {
    super();
    this.actions = [];
    this._browser = null;
    this._context = null;
    this._stopping = null;
  }

  get recording() {
    return !!this._browser;
  }

  /**
   * @param {{ browser?: 'chromium'|'firefox'|'webkit', channel?: string|null,
   *           url?: string, viewport?: {width:number,height:number}|null,
   *           headless?: boolean }} options  headless is only meant for tests
   */
  async start(options = {}) {
    if (this._browser)
      throw new Error('A recording is already in progress.');
    const browserType = playwright[options.browser || 'chromium'];
    if (!browserType)
      throw new Error(`Unknown browser: ${options.browser}`);

    this.actions = [];
    this.emit('actions', this.actions);

    const browser = await browserType.launch({
      headless: !!options.headless,
      ...(options.channel ? { channel: options.channel } : {}),
    });
    this._browser = browser;
    browser.on('disconnected', () => this._onClosed(browser));
    try {
      const context = await browser.newContext({
        viewport: options.viewport || { width: 1280, height: 720 },
      });
      this._context = context;
      await context._startRecording({ language: 'jsonl' }, {
        actionAdded: (_page, data, code) => this._add(data, code),
        actionUpdated: (_page, data, code) => this._replaceLast(data, code),
        signalAdded: (_page, _data, code) => this._addSignal(code),
      });
      // Closing the last recorded page ends the recording, like Playwright codegen.
      context.on('page', (page) => page.on('close', () => {
        if (context.pages().length === 0)
          this.stop();
      }));
      const page = await context.newPage();
      if (options.url)
        await page.goto(normalizeUrl(options.url));
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop() {
    if (!this._browser)
      return;
    if (!this._stopping) {
      const browser = this._browser;
      this._stopping = browser.close().catch(() => {});
    }
    await this._stopping;
  }

  /** Removes the recorded action at `index` (e.g. an unwanted click). */
  removeAction(index) {
    if (index < 0 || index >= this.actions.length)
      return;
    this.actions.splice(index, 1);
    this.emit('actions', this.actions);
  }

  clear() {
    this.actions = [];
    this.emit('actions', this.actions);
  }

  _onClosed(browser) {
    if (this._browser !== browser)
      return;
    this._browser = null;
    this._context = null;
    this._stopping = null;
    this.emit('stopped');
  }

  _add(data, code) {
    const action = parseAction(data, code);
    if (!action)
      return;
    this.actions.push(action);
    this.emit('actions', this.actions);
  }

  _replaceLast(data, code) {
    const action = parseAction(data, code);
    if (!action)
      return;
    if (this.actions.length === 0)
      this.actions.push(action);
    else
      this.actions[this.actions.length - 1] = action;
    this.emit('actions', this.actions);
  }

  // For signals (popup, download, dialog) `code` is the regenerated last action.
  _addSignal(code) {
    const last = this.actions[this.actions.length - 1];
    if (!last)
      return;
    const updated = parseAction(last, code);
    if (!updated)
      return;
    this.actions[this.actions.length - 1] = updated;
    this.emit('actions', this.actions);
  }
}

/**
 * Builds a recorded action from the recorder payload: `data` is the full
 * action, while the first `jsonl` line of `code` carries pageGuid and signals.
 */
function parseAction(data, code) {
  let context;
  try {
    context = JSON.parse(String(code).split('\n')[0]);
  } catch {
    return null;
  }
  const action = { ...data, pageGuid: context.pageGuid, signals: context.signals || [] };
  // The page snapshot is attached to every action but only assertSnapshot needs it.
  if (action.name !== 'assertSnapshot')
    delete action.ariaSnapshot;
  return action;
}

function normalizeUrl(url) {
  const trimmed = url.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed))
    return trimmed;
  return 'https://' + trimmed;
}

module.exports = { RecorderSession, normalizeUrl };
