'use strict';

// Quitting stops every service first, each within a time limit, whatever way the app quits.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { stopAll, handleQuit } = require('../src/main/shutdown');

test('every service is stopped; one that hangs or fails does not hold up the others', async () => {
  const stopped = [];
  const logged = [];
  const started = Date.now();
  await stopAll([
    ['quick', () => { stopped.push('quick'); }],
    ['async', async () => { await new Promise((resolve) => setTimeout(resolve, 20)); stopped.push('async'); }],
    ['stuck', () => new Promise(() => {})],
    ['broken', () => { throw new Error('boom'); }],
  ], { timeoutMs: 100, log: (message) => logged.push(message) });
  assert.deepEqual(stopped.sort(), ['async', 'quick']);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(logged.sort(), ['Shutdown: broken: boom', 'Shutdown: stuck did not stop within 0.1 seconds']);
});

function fakeApp() {
  const app = new EventEmitter();
  app.quits = 0;
  app.quit = () => {
    app.quits++;
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    app.emit('before-quit', event);
    app.lastEvent = event;
  };
  return app;
}

test('the first quit waits for the services, then the app quits; quitting again stops them once', async () => {
  const app = fakeApp();
  let stops = 0;
  let release;
  handleQuit(app, { stop: () => { stops++; return new Promise((resolve) => { release = resolve; }); } });
  app.quit();
  assert.equal(app.lastEvent.prevented, true, 'the app waits for the services');
  app.quit(); // e.g. the window closes while the first quit is stopping services
  assert.equal(app.lastEvent.prevented, true);
  assert.equal(stops, 1);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.lastEvent.prevented, false, 'once stopped, the quit goes through');
  assert.equal(app.quits, 3);
});

test('a second instance that hands over to the first quits at once', () => {
  const app = fakeApp();
  handleQuit(app, { stop: () => { throw new Error('nothing to stop'); }, enabled: false });
  app.quit();
  assert.equal(app.lastEvent.prevented, false);
});
