'use strict';

// The Test Generator in the main process: recording, locator picking and saving the
// generated test (recorder:*, locator:*, generator:set-options, file:save). The recorder
// sessions themselves belong to main.js, which also stops them when a project changes.

const fs = require('fs/promises');
const path = require('path');
const { generateRobot, generateSteps, DEFAULT_OPTIONS } = require('../../generator/robotGenerator');
const { toBrowserSelector } = require('../../generator/selectors');
const { escapeArg } = require('../../generator/escape');

// Browser choices offered in the UI: the Playwright browser to record with and
// the matching `New Browser` arguments of the generated test.
const BROWSERS = {
  chromium: { browser: 'chromium', channel: null },
  chrome: { browser: 'chromium', channel: 'chrome' },
  msedge: { browser: 'chromium', channel: 'msedge' },
  firefox: { browser: 'firefox', channel: null },
  webkit: { browser: 'webkit', channel: null },
};

/** @returns {{ error: string, install?: string }} install: the Playwright browser that can be downloaded */
function explainLaunchError(error, browser) {
  const message = String(error && error.message || error).split('\n')[0];
  if (/Executable doesn't exist|browserType\.launch: .*not found|is not found/i.test(message)) {
    const target = BROWSERS[browser] || BROWSERS.chromium;
    if (target.channel)
      return { error: `${message}\nThis browser does not seem to be installed on this machine.` };
    return { error: `The ${target.browser} browser used by the Test Generator is not installed yet.`, install: target.browser };
  }
  return { error: message };
}

function describeStep(action) {
  switch (action.name) {
    case 'openPage': return action.url && action.url !== 'about:blank' ? action.url : 'new page';
    case 'navigate': return action.url;
    case 'fill': return `${toBrowserSelector(action.selector)} ← "${action.text}"`;
    case 'press': return `${toBrowserSelector(action.selector)} ⌨ ${action.key}`;
    case 'select': return `${toBrowserSelector(action.selector)} → ${action.options.join(', ')}`;
    case 'assertText': return `${toBrowserSelector(action.selector)} ${action.substring ? 'contains' : 'is'} "${action.text}"`;
    case 'assertValue': return `${toBrowserSelector(action.selector)} = "${action.value || ''}"`;
    default: return action.selector ? toBrowserSelector(action.selector) : '';
  }
}

/**
 * @param {object} context
 * @param {{ handle: Function }} context.ipcMain
 * @param {(channel: string, payload: unknown) => void} context.send
 * @param {import('../recorder').RecorderSession} context.session the Test Generator's recording
 * @param {import('../recorder').RecorderSession} context.pickerSession a browser kept for picking
 * @param {() => object | null} context.project the open project
 * @param {() => string} context.documentsPath where tests are saved without a project
 * @param {(options: object) => Promise<{ canceled: boolean, filePath?: string }>} context.showSaveDialog
 * @param {() => void} context.showWindow brings Keywright back after picking
 * @param {(event: string, details: object) => void} context.note for crash reports
 * @param {(name: string, onLog: Function) => Promise<void>} context.install installs a browser
 */
function createGeneratorIpc(context) {
  const { ipcMain, send, session, pickerSession } = context;
  let options = { ...DEFAULT_OPTIONS };
  let pickingSession = null;

  function publishCode() {
    send('recorder:code', {
      code: generateRobot(session.actions, options),
      lines: generateSteps(session.actions), // for "Record at cursor" in the editor
      steps: session.actions.map((action) => ({
        name: action.name,
        detail: describeStep(action),
        signals: (action.signals || []).map((s) => s.name),
      })),
    });
  }

  function publishState(extra = {}) {
    send('recorder:state', { recording: session.recording, ...extra });
  }

  function publishPickState() {
    send('locator:state', { picking: !!pickingSession });
  }

  session.on('actions', publishCode);
  session.on('stopped', () => publishState());
  session.on('unreadable-action', (detail) => {
    console.error(`The recorder sent an action Keywright cannot read; it was not recorded: ${detail}`);
    context.note('unreadable-recorder-action', { detail });
  });

  ipcMain.handle('recorder:start', async (_event, request) => {
    const target = BROWSERS[request.browser] || BROWSERS.chromium;
    options = { ...options, ...target, viewport: request.viewport || null };
    try {
      await session.start({ ...target, url: request.url, viewport: request.viewport });
      publishState();
      return { ok: true };
    } catch (error) {
      publishState();
      return { ok: false, ...explainLaunchError(error, request.browser) };
    }
  });

  ipcMain.handle('recorder:install-browser', async (_event, name) => {
    try {
      await context.install(name, (text) => send('recorder:install-log', text));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('recorder:stop', () => session.stop());
  ipcMain.handle('recorder:clear', () => session.clear());
  ipcMain.handle('recorder:remove-step', (_event, index) => session.removeAction(index));

  // Pick locator: in the Test Generator's browser while it records, otherwise in
  // a browser opened just for picking (kept open for the next picks).
  ipcMain.handle('locator:pick', async (_event, request = {}) => {
    if (pickingSession)
      return { ok: false, error: 'Already picking a locator.' };
    const target = session.recording ? session : pickerSession;
    pickingSession = target;
    publishPickState();
    try {
      if (!target.recording) {
        const browser = BROWSERS[request.browser] || BROWSERS.chromium;
        await pickerSession.start({ ...browser, url: request.url, viewport: request.viewport, record: false });
      }
      const selector = await target.pickLocator();
      if (!selector)
        return { ok: true, cancelled: true };
      const browserSelector = toBrowserSelector(selector);
      context.showWindow();
      return { ok: true, selector: browserSelector, cell: escapeArg(browserSelector, { escapeNamedArg: false }) };
    } catch (error) {
      return { ok: false, ...explainLaunchError(error, request.browser) };
    } finally {
      pickingSession = null;
      publishPickState();
    }
  });

  ipcMain.handle('locator:cancel', () => pickingSession && pickingSession.cancelPick());

  ipcMain.handle('generator:set-options', (_event, changes) => {
    options = { ...options, ...changes };
    publishCode();
  });

  function suggestedFileName() {
    const slug = (options.testName || 'recorded test')
      .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return `${slug || 'recorded_test'}.robot`;
  }

  ipcMain.handle('file:save', async (_event, code) => {
    const project = context.project();
    const folder = project ? path.join(project.root, project.config.testsDir) : context.documentsPath();
    const { canceled, filePath } = await context.showSaveDialog({
      title: 'Save Robot Framework test',
      defaultPath: path.join(folder, suggestedFileName()),
      filters: [{ name: 'Robot Framework', extensions: ['robot'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (canceled || !filePath)
      return null;
    await fs.writeFile(filePath, code, 'utf8');
    return filePath;
  });

  return { publishCode, publishState };
}

module.exports = { createGeneratorIpc, explainLaunchError, BROWSERS };
