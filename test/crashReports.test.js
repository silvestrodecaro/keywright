'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CrashReports } = require('../src/main/crashReports');

function temporary(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'keywright-crash-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return path.join(folder, 'crash-reports');
}

const versions = { keywright: '0.1.0', electron: '45.2.1', chromium: '142.0', node: '24.1.0', os: 'Windows_NT 10.0.26300 x64' };

test('a report names the failure, the versions and the recent app events', (t) => {
  let clock = Date.parse('2026-11-03T10:00:00.000Z');
  const reports = new CrashReports(temporary(t), { versions, now: () => new Date(clock) });
  reports.note('page-loaded', { windowId: 1 });
  clock += 1500;
  reports.note('renderer-console', { level: 'error', message: 'TypeError: x is undefined' });

  const file = reports.write('Window stopped', { reason: 'crashed', exitCode: -1073741819 });
  assert.match(path.basename(file), /^2026-11-03T10-00-01-500Z-window-stopped\.txt$/);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^Keywright crash report\n/);
  assert.match(text, /Event: Window stopped\n/);
  assert.match(text, /reason: crashed\n/);
  assert.match(text, /exitCode: -1073741819\n/);
  assert.match(text, /Keywright 0\.1\.0, Electron 45\.2\.1, Chromium 142\.0, Node\.js 24\.1\.0\n/);
  assert.match(text, /System: Windows_NT 10\.0\.26300 x64\n/);
  assert.match(text, /10:00:00\.000Z page-loaded \{"windowId":1\}\n/);
  assert.match(text, /10:00:01\.500Z renderer-console \{"level":"error","message":"TypeError: x is undefined"\}\n/);
});

test('only the most recent events are kept', (t) => {
  const reports = new CrashReports(temporary(t), { versions, events: 3 });
  for (let i = 1; i <= 5; i++)
    reports.note(`event-${i}`);
  const text = fs.readFileSync(reports.write('Test'), 'utf8');
  assert.doesNotMatch(text, /event-[12]\b/);
  assert.match(text, /event-3[\s\S]*event-4[\s\S]*event-5/);
});

test('long event details are shortened', (t) => {
  const reports = new CrashReports(temporary(t), { versions });
  reports.note('renderer-console', { message: 'x'.repeat(5000) });
  const text = fs.readFileSync(reports.write('Test'), 'utf8');
  assert.ok(text.length < 2500, `report is ${text.length} characters`);
  assert.match(text, /x…/);
});

test('old reports are removed, newest kept', (t) => {
  let clock = Date.parse('2026-11-03T10:00:00.000Z');
  const folder = temporary(t);
  const reports = new CrashReports(folder, { versions, keep: 2, now: () => new Date(clock += 1000) });
  const files = ['First', 'Second', 'Third'].map((event) => reports.write(event));
  assert.deepStrictEqual(fs.readdirSync(folder).sort(), files.slice(1).map((file) => path.basename(file)));
  fs.writeFileSync(path.join(folder, 'notes.md'), 'not a report');
  reports.write('Fourth');
  assert.ok(fs.existsSync(path.join(folder, 'notes.md')), 'other files are left alone');
});
