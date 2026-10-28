'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');
const { pythonEnv, runHelper } = require('./pythonHelper');

/**
 * Builds the suite/test tree of `project` with Robot's own parser.
 * @returns {Promise<{ ok: true, suite: object } | { ok: false, error: string }>}
 */
function discoverTests(project) {
  if (!project.python)
    return Promise.resolve({ ok: false, error: 'This project has no virtual environment (.venv) with Robot Framework.' });
  const testsPath = path.join(project.root, project.config.testsDir);
  if (!fs.existsSync(testsPath))
    return Promise.resolve({ ok: false, error: `Tests folder not found: ${project.config.testsDir}` });
  return runHelper(project.python, ['discover', testsPath, project.root], { cwd: project.root });
}

/** Kills a process and all its children (the Browser library starts Node and browsers). */
function killTree(child) {
  if (!child || child.exitCode !== null)
    return;
  if (process.platform === 'win32')
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}

/**
 * Runs Robot Framework for a project and reports progress.
 *
 * Events:
 *  - 'event'  (event)   a listener event (suite/test/step start and end, log)
 *  - 'output' (text)    console output of the robot process
 *  - 'finished' ({ exitCode, stopped, outputDir })
 */
class TestRunner extends EventEmitter {
  constructor() {
    super();
    this._child = null;
    this._server = null;
    this._socket = null; // the listener's connection
    this._root = null;
    this._stopped = false;
  }

  get running() {
    return !!this._child;
  }

  /**
   * @param {{ root: string, python: string|null, config: object }} project
   * @param {{ select?: string[], variables?: Record<string,string>, trace?: boolean,
   *           debug?: { breakpoints: Record<string, number[]> } }} [options]
   *   select: full names of tests or suites to run (all when empty);
   *   debug: stop at breakpoints (project-relative path -> lines) and accept debugCommand()
   */
  async run(project, options = {}) {
    if (this._child)
      throw new Error('Tests are already running.');
    if (!project.python)
      throw new Error('This project has no virtual environment (.venv) with Robot Framework.');

    const port = await this._listen();
    this._root = fs.realpathSync.native(project.root); // Robot reports long paths, not 8.3 short names
    const breakpoints = options.debug ? this._absoluteBreakpoints(options.debug.breakpoints) : null;
    const outputDir = path.resolve(project.root, project.config.outputDir);
    const args = [
      '-m', 'robot',
      '--listener', 'rfide_runner.Listener',
      '--outputdir', outputDir,
      '--consolecolors', 'off',
      '--consolemarkers', 'off',
    ];
    if (options.select && options.select.length)
      args.push('--prerunmodifier', 'rfide_runner.SelectTests');
    for (const [name, value] of Object.entries(options.variables || {}))
      args.push('--variable', `${name}:${value}`);
    args.push(path.join(project.root, project.config.testsDir));

    this._stopped = false;
    const child = spawn(project.python, args, {
      cwd: project.root,
      env: pythonEnv({
        RFIDE_PORT: String(port),
        RFIDE_SELECT: JSON.stringify(options.select || []),
        // Browser library: record a Playwright trace for every `New Context`.
        ...(options.trace ? { ROBOT_FRAMEWORK_BROWSER_TRACING: 'true' } : {}),
        ...(breakpoints ? { RFIDE_DEBUG: '1', RFIDE_BREAKPOINTS: JSON.stringify(breakpoints) } : {}),
      }),
      windowsHide: true,
      detached: process.platform !== 'win32', // own process group, so killTree can reach the children
    });
    this._child = child;
    this.emit('output', `> robot ${args.slice(2).join(' ')}\n`);
    child.stdout.on('data', (chunk) => this.emit('output', chunk.toString()));
    child.stderr.on('data', (chunk) => this.emit('output', chunk.toString()));
    child.on('error', (error) => this.emit('output', `\n${error.message}\n`));
    child.on('close', (exitCode) => {
      this._child = null;
      this._closeServer();
      this.emit('finished', { exitCode, stopped: this._stopped, outputDir });
    });
  }

  /**
   * Sends a debugger command to the running tests: { command: 'continue' | 'over' | 'into' | 'out' | 'pause' }
   * or { command: 'breakpoints', breakpoints } with project-relative paths.
   */
  debugCommand(command) {
    if (!this._socket || this._socket.destroyed)
      return false;
    const payload = command.command === 'breakpoints'
      ? { ...command, breakpoints: this._absoluteBreakpoints(command.breakpoints) } : command;
    this._socket.write(JSON.stringify(payload) + '\n');
    return true;
  }

  _absoluteBreakpoints(breakpoints = {}) {
    return Object.fromEntries(Object.entries(breakpoints).map(([file, lines]) => [path.resolve(this._root, file), lines]));
  }

  /** Paths in debugger events relative to the project, like the rest of the IDE. */
  _relative(source) {
    if (!source || !this._root)
      return source;
    let real = source;
    try {
      real = fs.realpathSync.native(source); // Robot keeps the form of the path it was given (8.3 or long)
    } catch {
      // not a file on disk: keep it as is
    }
    const relative = path.relative(this._root, real);
    return relative.startsWith('..') || path.isAbsolute(relative) ? source : relative.split(path.sep).join('/');
  }

  stop() {
    if (!this._child)
      return;
    this._stopped = true;
    killTree(this._child);
  }

  _listen() {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        this._socket = socket;
        let buffer = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
          buffer += chunk;
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (!line.trim())
              continue;
            try {
              const event = JSON.parse(line);
              if (event.type === 'debug-paused') {
                event.source = this._relative(event.source);
                event.frames = (event.frames || []).map((frame) => ({ ...frame, source: this._relative(frame.source) }));
              }
              this.emit('event', event);
            } catch {
              // ignore malformed lines
            }
          }
        });
        socket.on('error', () => {});
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this._server = server;
        resolve(server.address().port);
      });
    });
  }

  _closeServer() {
    this._socket = null;
    if (this._server) {
      this._server.close();
      this._server = null;
    }
  }
}

/**
 * Extracts screenshots embedded by the Browser library in HTML log messages
 * (`<img src="browser/screenshot/...">`, relative to the output directory).
 * @returns {string[]} absolute file paths
 */
function screenshotsFromHtml(html, outputDir) {
  const files = [];
  for (const match of String(html).matchAll(/<img[^>]+src="([^"]+)"/gi)) {
    const src = match[1];
    if (/^(data|https?):/i.test(src))
      continue;
    files.push(path.resolve(outputDir, decodeURIComponent(src.replace(/^file:\/\/\/?/i, ''))));
  }
  return files;
}

module.exports = { discoverTests, TestRunner, screenshotsFromHtml };
