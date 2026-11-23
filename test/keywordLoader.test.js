'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { create, keywordStatus } = require('../src/renderer/keywordLoader');

// The renderer announces each load on window.
globalThis.window = new EventTarget();

test('the status counts keywords and import problems', () => {
  assert.deepStrictEqual(keywordStatus({ ok: true, keywords: [{}, {}], errors: [] }),
    { text: '2 keywords', isError: false, title: '' });
  assert.deepStrictEqual(keywordStatus({ ok: true, keywords: [{}], errors: [{ import: 'Lib', error: 'missing' }, { source: 'a.resource', error: 'bad' }] }),
    { text: '1 keywords · 2 import problem(s)', isError: true, title: 'Lib: missing\na.resource: bad' });
  assert.deepStrictEqual(keywordStatus({ ok: false, error: 'No Python' }), { text: 'No Python', isError: true });
});

function harness(results) {
  const events = [];
  const listeners = {};
  const button = { disabled: false };
  const doc = { querySelector: (selector) => ({ addEventListener: (type, fn) => { listeners[selector + type] = fn; } }) };
  const api = {
    projectKeywords: async () => results.shift(),
    reloadLibraries: async () => events.push(['reload', button.disabled]),
  };
  const editor = {
    setKeywords: (keywords, options) => events.push(['set', keywords.length, options.complete]),
    revalidate: () => events.push(['revalidate']),
  };
  const index = create({ api, editor, doc, status: (text, isError = false) => events.push(['status', text, isError]),
    statusTitle: (title) => events.push(['title', title]) });
  const reload = () => listeners['#reload-librariesclick']({ currentTarget: button });
  return { index, events, button, reload };
}

test('loading sets the keywords, complete only when no library import failed', async () => {
  const { index, events } = harness([
    { ok: true, keywords: [{}], errors: [{ source: 'a.resource', error: 'bad' }] },
    { ok: true, keywords: [{}], errors: [{ import: 'Lib', error: 'missing' }] },
    { ok: false, keywords: [], error: 'No Python' },
  ]);
  await index.load();
  await index.load();
  await index.load();
  assert.deepStrictEqual(events.filter(([kind]) => kind === 'set'), [['set', 1, true], ['set', 1, false], ['set', 0, false]]);
  assert.deepStrictEqual(events.slice(-2), [['revalidate'], ['status', 'No Python', true]]);
});

test('Reload libraries disables the button and cancels a scheduled load', async () => {
  const { index, events, button, reload } = harness([{ ok: true, keywords: [], errors: [] }]);
  index.schedule();
  await reload();
  assert.strictEqual(button.disabled, false);
  await new Promise((resolve) => setTimeout(resolve, 600));
  // One load only: the scheduled one was cancelled.
  assert.deepStrictEqual(events.filter(([kind]) => kind !== 'revalidate'), [
    ['status', 'Reloading libraries…', false], ['reload', true], ['set', 0, true], ['status', '0 keywords', false], ['title', ''],
  ]);
});
