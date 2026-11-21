'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const { ChildProcesses, killTree } = require('../src/main/processes');

// A Node process that starts a grandchild, as Robot starts Browser's Node and
// browsers, and prints the grandchild's PID.
function parentWithGrandchild() {
  const script = `
    const { spawn } = require('child_process');
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    console.log(grandchild.pid);
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', script], {
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  const grandchild = new Promise((resolve) => child.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim()))));
  return { child, grandchild };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid) {
  for (let i = 0; i < 50 && alive(pid); i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  return !alive(pid);
}

test('killTree ends a process and the processes it started', async () => {
  const { child, grandchild } = parentWithGrandchild();
  const grandchildPid = await grandchild;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  await killTree(child);
  await exited;
  assert.ok(await gone(grandchildPid), 'the grandchild is still running');
});

test('killTree of an exited process resolves', async () => {
  const child = spawn(process.execPath, ['-e', ''], { windowsHide: true });
  await new Promise((resolve) => child.once('exit', resolve));
  await killTree(child);
});

test('ChildProcesses stops every tracked process and forgets exited ones', async () => {
  const processes = new ChildProcesses();
  const first = parentWithGrandchild();
  const second = parentWithGrandchild();
  const quick = spawn(process.execPath, ['-e', ''], { windowsHide: true });
  processes.track(first.child);
  processes.track(second.child);
  processes.track(quick);
  await new Promise((resolve) => quick.once('exit', resolve));
  assert.strictEqual(processes.size, 2);

  const grandchildren = await Promise.all([first.grandchild, second.grandchild]);
  await processes.killAll();
  assert.strictEqual(processes.size, 0);
  for (const pid of [first.child.pid, second.child.pid, ...grandchildren])
    assert.ok(await gone(pid), `process ${pid} is still running`);
});
