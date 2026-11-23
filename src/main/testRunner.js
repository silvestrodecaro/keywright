'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { pythonEnv, runHelper } = require('./pythonHelper');
const { killTree } = require('./processes');
const { randomUUID, timingSafeEqual } = require('crypto');

// How long output may still arrive after Robot has exited.
const OUTPUT_AFTER_EXIT_MS = 2000;

/**
 * Builds the suite/test tree of `project` with Robot's own parser, as a run with the same
 * `extraArgs` reads and names it.
 * @returns {Promise<{ ok: true, suite: object } | { ok: false, error: string }>}
 */
function discoverTests(project, { extraArgs = '' } = {}) {
  if (!project.python)
    return Promise.resolve({ ok: false, error: 'This project has no virtual environment (.venv) with Robot Framework.' });
  const testsPath = path.join(project.root, project.config.testsDir);
  if (!fs.existsSync(testsPath))
    return Promise.resolve({ ok: false, error: `Tests folder not found: ${project.config.testsDir}` });
  return runHelper(project.python, ['discover', testsPath, project.root, ...splitArgs(extraArgs)], { cwd: project.root });
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
    this._starting = false; // between run() and the spawn, so a second run() is refused
    this._finished = null; // resolves when the running process has exited
  }

  get running() {
    return this._starting || !!this._child;
  }

  /**
   * @param {{ root: string, python: string|null, config: object }} project
   * @param {{ select?: string[], variables?: Record<string,string>, trace?: boolean,
   *           include?: string[], exclude?: string[], dryrun?: boolean, extraArgs?: string,
   *           debug?: { breakpoints: Record<string, number[]>, pauseOnFailure?: boolean } }} [options]
   *   select: full names of tests or suites to run (all when empty);
   *   debug: stop at breakpoints (project-relative path -> lines) and accept debugCommand()
   */
  async run(project, options = {}) {
    if (this.running)
      throw new Error('Tests are already running.');
    if (!project.python)
      throw new Error('This project has no virtual environment (.venv) with Robot Framework.');
    this._starting = true;
    this._stopped = false;
    try {
      await this._start(project, options);
    } catch (error) {
      this._closeServer();
      throw error;
    } finally {
      this._starting = false;
    }
  }

  async _start(project, options) {
    const port = await this._listen();
    this._root = fs.realpathSync.native(project.root); // Robot reports long paths, not 8.3 short names
    this._relativeCache = new Map();
    const breakpoints = options.debug ? this._absoluteBreakpoints(options.debug.breakpoints) : null;
    const outputDir = path.resolve(project.root, project.config.outputDir);
    const args = [
      '-m', 'robot',
      '--listener', 'keywright_runner.Listener',
      '--outputdir', outputDir,
      '--consolecolors', 'off',
      '--consolemarkers', 'off',
    ];
    if (options.select && options.select.length)
      args.push('--prerunmodifier', 'keywright_runner.SelectTests');
    for (const [name, value] of Object.entries(options.variables || {}))
      args.push('--variable', `${name}:${value}`);
    for (const pattern of options.include || [])
      args.push('--include', pattern);
    for (const pattern of options.exclude || [])
      args.push('--exclude', pattern);
    if (options.dryrun)
      args.push('--dryrun');
    args.push(...splitArgs(options.extraArgs));
    args.push(path.join(project.root, project.config.testsDir));

    const child = spawn(project.python, args, {
      cwd: project.root,
      env: pythonEnv({
        KEYWRIGHT_PORT: String(port),
        KEYWRIGHT_TOKEN: this._token,
        KEYWRIGHT_SELECT: JSON.stringify(options.select || []),
        // Browser library: record a Playwright trace for every `New Context`.
        ...(options.trace ? { ROBOT_FRAMEWORK_BROWSER_TRACING: 'true' } : {}),
        ...(breakpoints ? {
          KEYWRIGHT_DEBUG: '1',
          KEYWRIGHT_BREAKPOINTS: JSON.stringify(breakpoints),
          KEYWRIGHT_PAUSE_ON_FAILURE: options.debug.pauseOnFailure ? '1' : '0',
        } : {}),
      }),
      windowsHide: true,
      detached: process.platform !== 'win32', // own process group, so killTree can reach the children
    });
    this._child = child;
    let finish;
    this._finished = new Promise((resolve) => { finish = resolve; });
    this.emit('output', `> robot ${args.slice(2).join(' ')}\n`);
    // Decoded as a stream, so a character split between two chunks stays whole.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text) => this.emit('output', text));
    child.stderr.on('data', (text) => this.emit('output', text));
    child.on('error', (error) => this.emit('output', `\n${error.message}\n`));
    let ended = false;
    let exitTimer = null;
    const end = (exitCode) => {
      if (ended)
        return;
      ended = true;
      clearTimeout(exitTimer);
      this._child = null;
      this._finished = null;
      this._closeServer();
      this.emit('finished', { exitCode, stopped: this._stopped, outputDir });
      finish();
    };
    // 'close' waits until every holder of Robot's output has closed it. A process a test
    // started can inherit it and keep running: after Robot exits, the rest of its output
    // has a moment to arrive, then the run is over.
    child.on('exit', (exitCode) => {
      exitTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        end(exitCode);
      }, OUTPUT_AFTER_EXIT_MS);
    });
    child.on('close', (exitCode) => end(exitCode));
    if (this._stopped) // stop() was called while the run was starting
      killTree(child);
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
    // Every step reports its file: each one is resolved once per run.
    if (this._relativeCache.has(source))
      return this._relativeCache.get(source);
    let real = source;
    try {
      real = fs.realpathSync.native(source); // Robot keeps the form of the path it was given (8.3 or long)
    } catch {
      // not a file on disk: keep it as is
    }
    const relative = path.relative(this._root, real);
    const result = relative.startsWith('..') || path.isAbsolute(relative) ? source : relative.split(path.sep).join('/');
    this._relativeCache.set(source, result);
    return result;
  }

  /** Stops the running tests. @returns {Promise<void>} resolves once Robot has exited */
  async stop() {
    if (this._starting)
      this._stopped = true; // the run kills its process as soon as it has one
    if (!this._child)
      return;
    this._stopped = true;
    const finished = this._finished;
    await killTree(this._child);
    await finished;
  }

  _listen() {
    // The listener's first line presents this token; other local connections are closed.
    this._token = randomUUID();
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        let accepted = false;
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
            if (!accepted) {
              if (this._socket || !this._isHello(line)) {
                socket.destroy();
                return;
              }
              accepted = true;
              this._socket = socket;
              continue;
            }
            try {
              const event = JSON.parse(line);
              if (event.type === 'step-start' && event.source)
                event.source = this._relative(event.source);
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

  _isHello(line) {
    try {
      const hello = JSON.parse(line);
      return hello?.type === 'hello' && typeof hello.token === 'string'
        && hello.token.length === this._token.length
        && timingSafeEqual(Buffer.from(hello.token), Buffer.from(this._token));
    } catch {
      return false;
    }
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

/** Splits extra command line arguments like a shell: spaces separate, quotes group. */
function splitArgs(text) {
  const args = [];
  for (const match of String(text || '').matchAll(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g))
    args.push(match[0].replace(/"([^"]*)"|'([^']*)'/g, '$1$2'));
  return args;
}

module.exports = { discoverTests, TestRunner, screenshotsFromHtml, splitArgs };
