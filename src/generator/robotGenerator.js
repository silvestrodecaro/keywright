'use strict';

const { escapeArg } = require('./escape');
const { toBrowserSelector } = require('./selectors');

const SEP = '    ';
const INDENT = '    ';

// Playwright encodes modifiers as a bitmask (see toKeyboardModifiers in playwright-core).
const MODIFIERS = [[1, 'Alt'], [2, 'Control'], [4, 'Meta'], [8, 'Shift']];

const DEFAULT_OPTIONS = {
  testName: 'Recorded Test',
  browser: 'chromium',
  channel: null,
  headless: false,
  viewport: null, // { width, height }
};

function modifierNames(mask) {
  return MODIFIERS.filter(([bit]) => mask & bit).map(([, name]) => name);
}

function isBlankUrl(url) {
  return !url || url === 'about:blank' || url === 'chrome://newtab/';
}

function line(keyword, ...args) {
  return [keyword, ...args].join(SEP);
}

function sel(action) {
  return escapeArg(toBrowserSelector(action.selector), { escapeNamedArg: false });
}

function arg(value) {
  return escapeArg(value);
}

/**
 * Translates one recorded action (without page/signal handling) into Browser
 * library keyword lines.
 * @returns {string[]}
 */
function actionLines(action) {
  switch (action.name) {
    case 'navigate':
      return [line('Go To', arg(action.url))];
    case 'click': {
      const modifiers = modifierNames(action.modifiers || 0);
      const button = action.button || 'left';
      if (modifiers.length === 0 && (action.clickCount || 1) === 1)
        return [line('Click', sel(action), ...(button === 'left' ? [] : [button]))];
      const extra = (action.clickCount || 1) === 1 ? [] : [`clickCount=${action.clickCount}`];
      return [line('Click With Options', sel(action), button, ...modifiers, ...extra)];
    }
    case 'hover':
      return [line('Hover', sel(action))];
    case 'check':
      return [line('Check Checkbox', sel(action))];
    case 'uncheck':
      return [line('Uncheck Checkbox', sel(action))];
    case 'fill':
      return [line('Fill Text', sel(action), arg(action.text))];
    case 'press': {
      const shortcut = [...modifierNames(action.modifiers || 0), action.key].join('+');
      return [line('Press Keys', sel(action), arg(shortcut))];
    }
    case 'select':
      return [line('Select Options By', sel(action), 'value', ...action.options.map(arg))];
    case 'setInputFiles':
      if (!action.files || action.files.length === 0)
        return [`# Cleared the file input ${toBrowserSelector(action.selector)}`];
      return [
        '# TODO: replace the file names below with full paths to the files to upload',
        line('Upload File By Selector', sel(action), ...action.files.map(arg)),
      ];
    case 'assertText':
      return [line('Get Text', sel(action), action.substring ? '*=' : '==', arg(action.text))];
    case 'assertChecked':
      return [line('Get Checkbox State', sel(action), '==', action.checked ? 'checked' : 'unchecked')];
    case 'assertVisible':
      return [line('Get Element States', sel(action), 'contains', 'visible')];
    case 'assertValue':
      return [line('Get Property', sel(action), 'value', '==', arg(action.value || ''))];
    case 'assertSnapshot':
      return [line('Get Aria Snapshot', sel(action), 'yaml', '==', arg(action.ariaSnapshot))];
    default:
      return [`# Unsupported recorded action: ${action.name}`];
  }
}

/**
 * Generates a Robot Framework test case using the Browser library from a list
 * of actions recorded by Playwright (the `jsonl` recorder payload: an action
 * plus `pageGuid` and `signals`).
 *
 * @param {Array<object>} recorded
 * @param {Partial<typeof DEFAULT_OPTIONS>} [userOptions]
 * @returns {string}
 */
function generateRobot(recorded, userOptions = {}) {
  const options = { ...DEFAULT_OPTIONS, ...userOptions };
  const browserArgs = [options.browser, `headless=${options.headless ? 'True' : 'False'}`];
  if (options.channel)
    browserArgs.push(`channel=${options.channel}`);
  const body = [line('New Browser', ...browserArgs)];
  if (options.viewport)
    body.push(line('New Context', `viewport={'width': ${options.viewport.width}, 'height': ${options.viewport.height}}`));
  else
    body.push(line('New Context'));
  body.push(...generateSteps(recorded));

  return [
    '*** Settings ***',
    line('Library', 'Browser'),
    '',
    '',
    '*** Test Cases ***',
    escapeArg(options.testName || DEFAULT_OPTIONS.testName, { escapeNamedArg: false }),
    ...body.map((l) => INDENT + l),
    '',
  ].join('\n');
}

/**
 * The keyword calls of a recording, without settings, browser or context: the
 * lines inserted by "Record at cursor" and the body of generateRobot.
 * @param {Array<object>} recorded
 * @returns {string[]} unindented lines
 */
function generateSteps(recorded) {
  // Pages only need variables when the recording switches between them.
  const pageGuids = new Set();
  for (const entry of recorded) {
    if (entry.pageGuid)
      pageGuids.add(entry.pageGuid);
    for (const signal of entry.signals || []) {
      if (signal.name === 'popup')
        pageGuids.add(signal.popupPageGuid);
    }
  }
  const multiPage = pageGuids.size > 1;

  const aliases = new Map(); // pageGuid -> expression accepted by Switch Page
  const nextAlias = () => '${page' + (aliases.size || '') + '}';
  let currentPage = null;
  let downloads = 0;
  const body = [];

  for (let i = 0; i < recorded.length; i++) {
    const entry = recorded[i];
    const guid = entry.pageGuid;

    if (entry.name === 'openPage') {
      if (aliases.has(guid))
        continue; // already registered as a popup
      let url = entry.url;
      const next = recorded[i + 1];
      if (isBlankUrl(url) && next && next.name === 'navigate' && next.pageGuid === guid && !(next.signals || []).length) {
        url = next.url;
        i++;
      }
      const pageArgs = isBlankUrl(url) ? [] : [arg(url)];
      if (multiPage) {
        const alias = nextAlias();
        aliases.set(guid, alias);
        body.push(line(`${alias}=`, 'New Page', ...pageArgs));
      } else {
        aliases.set(guid, null);
        body.push(line('New Page', ...pageArgs));
      }
      currentPage = guid;
      continue;
    }

    if (multiPage && guid !== currentPage && aliases.get(guid)) {
      body.push(line('Switch Page', aliases.get(guid)));
      currentPage = guid;
    }

    if (entry.name === 'closePage') {
      body.push(line('Close Page'));
      currentPage = null;
      continue;
    }

    const signals = entry.signals || [];
    const dialog = signals.find((s) => s.name === 'dialog');
    const download = signals.find((s) => s.name === 'download');
    const popup = signals.find((s) => s.name === 'popup');

    if (dialog)
      body.push(line('Handle Future Dialogs', 'action=dismiss'));
    let downloadVar = null;
    if (download) {
      downloadVar = 'download' + (downloads++ || '');
      body.push(line(`\${${downloadVar}_promise}=`, 'Promise To Wait For Download'));
    }

    body.push(...actionLines(entry));

    if (downloadVar)
      body.push(line(`\${${downloadVar}}=`, 'Wait For', `\${${downloadVar}_promise}`));
    if (popup && !aliases.has(popup.popupPageGuid)) {
      const alias = nextAlias();
      aliases.set(popup.popupPageGuid, `${alias}[0]`);
      body.push(line('Switch Page', 'NEW'));
      body.push(line(`${alias}=`, 'Get Page Ids', 'ACTIVE', 'ACTIVE', 'ACTIVE'));
      currentPage = popup.popupPageGuid;
    }
  }

  return body;
}

module.exports = { generateRobot, generateSteps, DEFAULT_OPTIONS };
