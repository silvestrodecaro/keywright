'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RecorderSession } = require('../src/main/recorder');

async function recording() {
  const session = new RecorderSession();
  let callbacks;
  const context = {
    _startRecording: async (_options, handlers) => { callbacks = handlers; },
    _stopRecording: async () => {},
  };
  const browser = { close: async () => { session._onClosed(browser); } };
  session._context = context;
  session._browser = browser;
  await session._startRecordingActions();
  const code = JSON.stringify({ pageGuid: 'page-1', signals: [] });
  return { session, browser, context, callbacks, code };
}

test('stopping the recorder does not record the pages closed by browser shutdown', async () => {
  const f = await recording();
  f.callbacks.actionAdded({}, { name: 'click', selector: 'id=submit' }, f.code);
  f.browser.close = async () => {
    f.callbacks.actionAdded({}, { name: 'closePage' }, f.code);
    f.callbacks.actionAdded({}, { name: 'closePage' }, f.code);
    f.session._onClosed(f.browser);
  };
  await f.session.stop();
  assert.deepEqual(f.session.actions.map((action) => action.name), ['click']);
});

test('late recorder updates and signals cannot mutate the completed recording', async () => {
  const f = await recording();
  f.callbacks.actionAdded({}, { name: 'click', selector: 'id=submit' }, f.code);
  await f.session.stop();
  f.callbacks.actionUpdated({}, { name: 'closePage' }, f.code);
  f.callbacks.signalAdded({}, {}, JSON.stringify({ pageGuid: 'page-1', signals: [{ name: 'popup' }] }));
  assert.equal(f.session.actions[0].name, 'click');
  assert.deepEqual(f.session.actions[0].signals, []);
});

test('stop keeps the final user action flushed by the recorder before browser shutdown', async () => {
  const f = await recording();
  f.callbacks.actionAdded({}, { name: 'fill' }, f.code);
  f.context._stopRecording = async () => {
    f.callbacks.actionAdded({}, { name: 'click', selector: 'id=submit' }, f.code);
  };
  await f.session.stop();
  assert.deepEqual(f.session.actions.map((action) => action.name), ['fill', 'click']);
});

test('a callback from a previous recording cannot append to a new session', async () => {
  const f = await recording();
  await f.session.stop();
  f.session._context = f.context;
  f.session._browser = f.browser;
  await f.session._startRecordingActions();
  f.callbacks.actionAdded({}, { name: 'closePage' }, f.code);
  assert.deepEqual(f.session.actions, []);
});

test('closing a page while recording remains a real recorded action', async () => {
  const f = await recording();
  f.callbacks.actionAdded({}, { name: 'closePage' }, f.code);
  assert.deepEqual(f.session.actions.map((action) => action.name), ['closePage']);
  await f.session.stop();
});
