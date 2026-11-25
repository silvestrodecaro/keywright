'use strict';

// The Testing panel in the main process: runs and their events, run history, the
// debugger's commands, and the URLs of Robot reports and Playwright traces (tests:*).

const path = require('path');
const { existsSync } = require('fs');
const { pathToFileURL } = require('url');
const { screenshotsFromHtml } = require('../testRunner');
const { RunHistory } = require('../runHistory');
const { Batch } = require('../eventBatch');

/**
 * @param {object} context
 * @param {{ handle: Function }} context.ipcMain
 * @param {(channel: string, payload: unknown) => void} context.send
 * @param {import('../testRunner').TestRunner} context.runner
 * @param {import('../traceServer').TraceServer} context.traceServer
 * @param {() => object | null} context.project the open project
 * @param {() => string | null} context.refreshProject reads it again; the error, if any
 * @param {(project: object, options?: { extraArgs?: string }) => Promise<object>} context.discoverTests
 * @param {(project: object, names: string[], onLog: Function) => Promise<void>} context.installBrowsers
 *   installs browsers for the project's Browser library
 * @param {(file: string) => Promise<string>} context.openPath opens a file in its program
 * @param {number} [context.batchMs]
 * @returns {{ startRun: (options?: object) => Promise<void> }}
 */
function createTestsIpc(context) {
  const { ipcMain, send, runner, traceServer } = context;
  const runHistory = new RunHistory();
  let runOutputDir = null;
  const installing = new Set(); // projects whose browsers are being installed
  const outputDir = (project) => path.resolve(project.root, project.config.outputDir);

  // A run can log thousands of messages a second: the Testing panel receives them in
  // batches, a few IPC messages a second, rather than one each.
  const batchMs = context.batchMs ?? 50;
  const testEvents = new Batch((events) => send('tests:events', events), batchMs);
  const testOutput = new Batch((chunks) => send('tests:output', chunks.join('')), batchMs);
  function flushRunMessages() {
    testOutput.flush();
    testEvents.flush();
  }

  runner.on('event', (event) => {
    runHistory.record(event);
    if (event.type === 'log' && event.html && runOutputDir) {
      const images = screenshotsFromHtml(event.text, runOutputDir).filter((file) => existsSync(file));
      if (images.length)
        event.images = images.map((file) => pathToFileURL(file).href);
    }
    testEvents.push(event);
    // The debugger's pause and the end of a test are shown at once; the rest is batched.
    if (event.type.startsWith('debug-'))
      flushRunMessages();
  });
  runner.on('output', (text) => testOutput.push(text));
  runner.on('finished', (result) => {
    const run = runHistory.finish(result);
    flushRunMessages(); // every event and output line arrives before the end of the run
    send('tests:finished', result);
    if (run)
      send('tests:history-added', run);
  });

  ipcMain.handle('tests:history', () => {
    const project = context.project();
    return project ? runHistory.list(outputDir(project)) : [];
  });

  ipcMain.handle('tests:discover', (_event, options = {}) => {
    if (!context.project())
      return { ok: false, error: 'No project is open.' };
    // Reload: the virtual environment may have been created since the project was opened.
    const unreadable = context.refreshProject();
    if (unreadable)
      return { ok: false, error: unreadable };
    return context.discoverTests(context.project(), { extraArgs: options.extraArgs || '' });
  });

  /** Starts a run for the Testing panel or an AI client; throws when it cannot start. */
  async function startRun(options = {}) {
    const project = context.project();
    if (!project)
      throw new Error('No project is open.');
    if (runner.running) // before touching the history of the run in progress
      throw new Error('Tests are already running.');
    if (installing.has(project.root))
      throw new Error('The browsers of this project are being installed. Run the tests when it has finished.');
    runOutputDir = outputDir(project);
    traceServer.allow([runOutputDir]);
    runHistory.start(runOutputDir, { ...options, debug: !!options.debug });
    await runner.run(project, runOptions(options)).catch((error) => {
      runHistory.cancel();
      throw error;
    });
  }

  ipcMain.handle('tests:run', async (_event, options = {}) => {
    try {
      await startRun(options);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // Browsers of the project's Browser library, when a run found them missing. Tests do not
  // start meanwhile: the installation replaces the library's Node.js dependencies.
  ipcMain.handle('tests:install-browsers', async (_event, names) => {
    const project = context.project();
    if (!project)
      return { ok: false, error: 'No project is open.' };
    if (runner.running)
      return { ok: false, error: 'Tests are running: install the browsers when they have finished.' };
    if (installing.has(project.root))
      return { ok: false, error: 'The browsers of this project are already being installed.' };
    installing.add(project.root);
    try {
      await context.installBrowsers(project, names, (text) => send('tests:browsers-log', text));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      installing.delete(project.root);
    }
  });

  ipcMain.handle('tests:stop', () => runner.stop());

  // Debugger: continue / over / into / out / pause, new breakpoints or options, evaluate.
  ipcMain.handle('tests:debug-command', (_event, command) => runner.debugCommand(command));

  ipcMain.handle('tests:trace-url', async (_event, traceFile) => {
    if (!traceFile || !existsSync(traceFile))
      return { ok: false, error: 'The trace is written when the browser context is closed: at the end of the test, or of the suite when the context was created in a suite setup.' };
    try {
      // Traces of the open project's results, also of runs before it was reopened.
      const project = context.project();
      if (project)
        traceServer.allow([outputDir(project)]);
      return { ok: true, url: await traceServer.urlFor(traceFile) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // Robot's report.html / log.html of the project, shown in the Test Results tab.
  ipcMain.handle('tests:output-url', async (_event, file) => {
    const project = context.project();
    if (!project || !['log.html', 'report.html'].includes(file))
      return { ok: false, error: 'No project is open.' };
    const folder = outputDir(project);
    if (!existsSync(path.join(folder, file)))
      return { ok: false, error: `There is no ${file} yet: run some tests first.` };
    return { ok: true, url: await traceServer.outputUrl(folder, file) };
  });

  ipcMain.handle('tests:open-output', async (_event, file) => {
    const project = context.project();
    if (!project || !['log.html', 'report.html'].includes(file))
      return 'No results yet.';
    return context.openPath(path.join(outputDir(project), file));
  });

  return { startRun };
}

/** The runner's options for the Run options of the Testing panel. */
function runOptions(options) {
  return {
    select: options.select || [],
    variables: {
      ...(options.headed ? { HEADLESS: 'False' } : {}),
      ...(options.browser ? { BROWSER: options.browser } : {}), // used by the project template's New Browser
    },
    trace: !!options.trace,
    include: options.include || [],
    exclude: options.exclude || [],
    dryrun: !!options.dryrun,
    extraArgs: options.extraArgs || '',
    debug: options.debug ? { breakpoints: options.debug.breakpoints || {}, pauseOnFailure: !!options.debug.pauseOnFailure } : undefined,
  };
}

module.exports = { createTestsIpc };
