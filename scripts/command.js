'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');

function commandRunner({ root, env, log, ui, spawn: spawnChild = spawn }) {
  const write = (text) => fs.appendFileSync(log, text, 'utf8');
  return (title, executable, args, { cwd = root, allowedCodes = [0], background = false, windowsHide = true } = {}) =>
    ui.task(title, () => new Promise((resolve, reject) => {
      write(`\n${title}\n${JSON.stringify([executable, ...args])}\n`);
      const child = spawnChild(executable, args, { cwd, env, windowsHide, shell: false });
      let output = '';
      let tail = '';
      const failed = (code, reason) => {
        const detail = tail.trim().split(/\r?\n/).slice(-18).join('\n');
        reject(new Error(`${title} failed (${reason || `exit ${code}`}).\n${detail}\nFull log: ${log}`));
      };
      child.stdout.on('data', (data) => { if (!background) output += data.toString(); tail = (tail + data).slice(-12_000); write(data.toString()); });
      child.stderr.on('data', (data) => { tail = (tail + data).slice(-12_000); write(data.toString()); });
      const interrupt = () => child.kill('SIGINT');
      process.once('SIGINT', interrupt);
      child.on('error', (error) => { process.removeListener('SIGINT', interrupt); failed(null, error.message); });
      child.on('close', (code, signal) => {
        process.removeListener('SIGINT', interrupt);
        if (signal === 'SIGINT') {
          const error = new Error(`${title} was interrupted.`);
          error.name = 'AbortError';
          error.exitCode = 130;
          reject(error);
        } else if (!allowedCodes.includes(code)) failed(code, signal ? `signal ${signal}` : undefined);
        else resolve(output);
      });
    }), { background });
}

module.exports = { commandRunner };
