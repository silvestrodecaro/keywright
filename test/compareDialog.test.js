'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { create } = require('../src/renderer/compareDialog');

/** The elements the dialog uses, as plain objects. */
function setup() {
  const focused = [];
  const opener = { focus: () => focused.push('opener') };
  const nodes = {};
  for (const id of ['#compare-view', '#compare-title', '#compare-editor', '#compare-save', '#compare-reload', '#compare-cancel'])
    nodes[id] = { id, hidden: true, textContent: '', onclick: null, onkeydown: null };
  const doc = { activeElement: opener, querySelector: (selector) => nodes[selector] };
  const calls = [];
  const editor = {
    createComparison(container, options) {
      calls.push(['create', container.id, options]);
      return { content: () => 'merged text', dispose: () => calls.push(['dispose']) };
    },
  };
  return { nodes, doc, calls, focused, compareVersions: create({ editor, doc }).compareVersions };
}

const cleared = (nodes) => ['#compare-save', '#compare-reload', '#compare-cancel'].every((id) => nodes[id].onclick === null)
  && nodes['#compare-view'].onkeydown === null && nodes['#compare-view'].hidden;

test('the dialog shows both versions and Save returns the edited text', async () => {
  const { nodes, calls, focused, compareVersions } = setup();
  const result = compareVersions({ path: 'tests/a.robot', disk: 'disk', mine: 'mine' });
  assert.strictEqual(nodes['#compare-view'].hidden, false);
  assert.strictEqual(nodes['#compare-title'].textContent, 'tests/a.robot changed on disk');
  assert.deepStrictEqual(calls, [['create', '#compare-editor', { path: 'tests/a.robot', disk: 'disk', mine: 'mine' }]]);
  nodes['#compare-save'].onclick();
  assert.deepStrictEqual(await result, { choice: 'save', content: 'merged text' });
  assert.deepStrictEqual(calls.at(-1), ['dispose']);
  assert.ok(cleared(nodes));
  assert.deepStrictEqual(focused, ['opener']);
});

test('Reload and Cancel return only the choice', async () => {
  for (const [button, choice] of [['#compare-reload', 'reload'], ['#compare-cancel', 'cancel']]) {
    const { nodes, compareVersions } = setup();
    const result = compareVersions({ path: 'a.robot', disk: '', mine: '' });
    nodes[button].onclick();
    assert.deepStrictEqual(await result, { choice });
    assert.ok(cleared(nodes));
  }
});

test('Escape cancels unless another handler took it', async () => {
  const { nodes, compareVersions } = setup();
  const result = compareVersions({ path: 'a.robot', disk: '', mine: '' });
  let prevented = 0;
  nodes['#compare-view'].onkeydown({ key: 'Escape', defaultPrevented: true, preventDefault: () => prevented++ });
  nodes['#compare-view'].onkeydown({ key: 'Enter', defaultPrevented: false, preventDefault: () => prevented++ });
  assert.strictEqual(nodes['#compare-view'].hidden, false);
  nodes['#compare-view'].onkeydown({ key: 'Escape', defaultPrevented: false, preventDefault: () => prevented++ });
  assert.deepStrictEqual(await result, { choice: 'cancel' });
  assert.strictEqual(prevented, 1);
});
