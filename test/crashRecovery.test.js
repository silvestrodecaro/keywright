'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { create, recoveryEntries, restoredTab, noticeText, restoredStatus } = require('../src/renderer/crashRecovery');

test('only unsaved buffers of open tabs are copied, with the revision they started from', () => {
  const tabs = [{ path: 'a.robot', revision: 'r1' }, { path: 'b.robot' }];
  assert.deepStrictEqual(recoveryEntries(['a.robot', 'b.robot', 'closed.robot'], tabs, (path) => `text of ${path}`), [
    { path: 'a.robot', content: 'text of a.robot', revision: 'r1' },
    { path: 'b.robot', content: 'text of b.robot', revision: null },
  ]);
});

test('a restored file keeps its revision only when the disk has not changed since', () => {
  const entry = { path: 'a.robot', content: 'edited', revision: 'r1' };
  assert.deepStrictEqual(restoredTab(entry, { content: 'saved', revision: 'r1' }), { path: 'a.robot', content: 'saved', revision: 'r1' });
  assert.deepStrictEqual(restoredTab(entry, { content: 'other', revision: 'r2' }), { path: 'a.robot', content: 'other', revision: 'r1' });
  // Deleted since the crash: saving recreates it.
  assert.deepStrictEqual(restoredTab(entry, null), { path: 'a.robot', content: '', revision: null });
  // Not text (too large or binary): cannot be restored.
  assert.strictEqual(restoredTab(entry, { content: null, revision: 'r3' }), null);
});

test('notice and status texts', () => {
  assert.strictEqual(noticeText([{ path: 'a.robot' }]), 'Keywright closed with unsaved changes in 1 file: a.robot');
  assert.strictEqual(noticeText([{ path: 'a' }, { path: 'b' }]), 'Keywright closed with unsaved changes in 2 files: a, b');
  assert.deepStrictEqual(restoredStatus([{}, {}], []), { text: 'Restored unsaved changes in 2 files. Save to keep them.', isError: false });
  assert.deepStrictEqual(restoredStatus([{}], ['big.robot']), { text: 'Could not restore big.robot', isError: true });
});

function harness({ copies, disk, tabs = [] }) {
  const events = [];
  const elements = {};
  const element = (selector) => (elements[selector] ||= { hidden: true, dataset: {}, textContent: '', listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; } });
  const editor = {
    dirty: [],
    dirtyPaths() { return this.dirty; },
    getContent: (path) => `buffer of ${path}`,
    restoreContent: (path, content) => { editor.dirty.push(path); events.push(['restore', path, content]); },
    onDirtyChange: (fn) => { editor.changed = fn; },
  };
  const api = {
    readRecovery: async () => copies,
    readProjectFile: async (path) => { if (!(path in disk)) throw new Error('missing'); return disk[path]; },
    storeRecovery: async (entries) => events.push(['store', entries.map((e) => e.path)]),
    reportDirtyFiles: (paths) => events.push(['dirty', paths]),
  };
  const recovery = create({
    api, editor, tabs: () => tabs,
    addTab: (tab) => tabs.push(tab),
    showRestored: (path) => events.push(['show', path]),
    renderTabs: () => events.push(['render']),
    status: (text, isError) => events.push(['status', text, isError]),
    doc: { querySelector: element },
  });
  return { api, recovery, events, editor, tabs, notice: element('#recovery-notice'), click: (id) => element(id).listeners.click() };
}

test('copies already saved are skipped, and nothing is stored until the offer is answered', async () => {
  const { recovery, events, notice, click, tabs } = harness({
    copies: [{ path: 'saved.robot', content: 'same' }, { path: 'a.robot', content: 'edited', revision: 'r1' }],
    disk: { 'saved.robot': { content: 'same' }, 'a.robot': { content: 'old', revision: 'r1' } },
  });
  await recovery.offer();
  assert.strictEqual(notice.hidden, false);
  assert.deepStrictEqual(JSON.parse(notice.dataset.entries).map((e) => e.path), ['a.robot']);
  await recovery.store();
  assert.deepStrictEqual(events.filter(([kind]) => kind === 'store'), []);

  await click('#recovery-restore');
  assert.strictEqual(notice.hidden, true);
  assert.deepStrictEqual(tabs, [{ path: 'a.robot', content: 'old', revision: 'r1' }]);
  assert.deepStrictEqual(events.filter(([kind]) => kind !== 'dirty'), [
    ['show', 'a.robot'], ['restore', 'a.robot', 'edited'], ['render'],
    ['status', 'Restored unsaved changes in 1 file. Save to keep them.', false],
    ['store', ['a.robot']],
  ]);
  // Reported once when it changes: the first report, then the restored file.
  assert.deepStrictEqual(events.filter(([kind]) => kind === 'dirty'), [['dirty', []], ['dirty', ['a.robot']]]);
});

test('without copies storing starts at once; suspend stops it and hides the notice', async () => {
  const { recovery, events, editor, notice, tabs } = harness({ copies: [], disk: {}, tabs: [{ path: 'a.robot' }] });
  await recovery.offer();
  editor.dirty = ['a.robot'];
  await recovery.store();
  assert.deepStrictEqual(events.filter(([kind]) => kind === 'store'), [['store', []], ['store', ['a.robot']]]);
  notice.hidden = false;
  recovery.suspend();
  assert.strictEqual(notice.hidden, true);
  await recovery.store();
  assert.strictEqual(events.filter(([kind]) => kind === 'store').length, 2);
  assert.strictEqual(tabs.length, 1);
});

/** A promise resolved from the test, to overlap requests. */
function deferred() {
  const result = {};
  result.promise = new Promise((resolve) => { result.resolve = resolve; });
  return result;
}

test('an offer overtaken by another project neither stores nor shows its copies', async () => {
  const h = harness({ copies: [], disk: {} });
  const first = deferred();
  const second = deferred();
  const reads = [first.promise, second.promise];
  h.api.readRecovery = () => reads.shift();
  const offerA = h.recovery.offer();
  const offerB = h.recovery.offer();
  first.resolve([{ path: 'a.robot', content: 'project A' }]);
  await offerA;
  assert.strictEqual(h.notice.hidden, true);
  second.resolve([{ path: 'b.robot', content: 'project B' }]);
  await offerB;
  assert.deepStrictEqual(JSON.parse(h.notice.dataset.entries).map((e) => e.path), ['b.robot']);
  await h.recovery.store();
  assert.deepStrictEqual(h.events.filter(([kind]) => kind === 'store'), []);
});

test('an offer still loading when the project closes is dropped', async () => {
  for (const copies of [[], [{ path: 'a.robot', content: 'edited' }]]) {
    const h = harness({ copies: [], disk: {} });
    const read = deferred();
    h.api.readRecovery = () => read.promise;
    const offer = h.recovery.offer();
    h.recovery.suspend();
    read.resolve(copies);
    await offer;
    await h.recovery.store();
    assert.strictEqual(h.notice.hidden, true);
    assert.deepStrictEqual(h.events.filter(([kind]) => kind === 'store'), []);
  }
});

test('a restore overtaken by another project leaves its tabs and copies alone', async () => {
  const h = harness({ copies: [{ path: 'a.robot', content: 'project A' }], disk: {} });
  await h.recovery.offer();
  const read = deferred();
  h.api.readProjectFile = () => read.promise;
  const restoring = h.click('#recovery-restore');
  h.recovery.suspend();
  h.api.readProjectFile = async () => ({ content: 'old', revision: 'r1' });
  h.api.readRecovery = async () => [{ path: 'b.robot', content: 'project B' }];
  await h.recovery.offer();
  read.resolve({ content: 'disk', revision: 'r1' });
  await restoring;
  assert.deepStrictEqual(h.tabs, []);
  assert.strictEqual(h.notice.hidden, false);
  await h.recovery.store();
  assert.deepStrictEqual(h.events.filter(([kind]) => kind !== 'dirty'), []);
});
