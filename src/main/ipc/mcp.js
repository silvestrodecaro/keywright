'use strict';

// The MCP server in the main process: the service and its tools, the log of the AI's file
// changes, and the IPC channels behind the MCP dialog (mcp:*). What it needs from the rest
// of the main process comes in `context`, so this part is tested on its own.

const path = require('path');
const { McpService } = require('../mcp/service');
const { createTools } = require('../mcp/tools');
const { ChangeLog } = require('../mcp/changes');
const { clientConfigs, clientLocations, clientStates, connectionPlan } = require('../mcp/clients');
const { testConnection, testHttpConnection } = require('../mcp/connectionTest');

/**
 * @param {object} context
 * @param {{ handle: Function }} context.ipcMain
 * @param {string} context.userData Electron's user-data folder
 * @param {string} context.version
 * @param {(channel: string, payload: unknown) => void} context.send to the window
 * @param {(options: object) => Promise<{ response: number }>} context.showMessageBox
 * @param {(wanted: boolean) => void} [context.attention] asks for the user's attention, or no longer
 * @param {number} [context.confirmWaitMs] how long a tool call waits for the user's answer
 * @param {(entry: string) => Promise<void>} context.trash moves an entry to the Recycle Bin
 * @param {() => object | null} context.project the open project
 * @param {() => string | null} context.refreshProject reads it again; the error, if any
 * @param {() => string[]} context.dirtyPaths files with unsaved editor changes
 * @param {{ build: Function }} context.keywordIndex
 * @param {() => object | null} context.languageWorker
 * @param {(project: object) => Promise<object>} context.discoverTests
 * @param {import('events').EventEmitter} context.runner
 * @param {(options: object) => Promise<void>} context.startRun
 * @param {object} context.agentBrowser
 * @param {object} context.browsers
 * @param {(error: Error) => string} context.launchError
 * @param {string} [context.clientHome] another home folder for client files (tests)
 */
function createMcpIpc(context) {
  const { ipcMain, send, agentBrowser } = context;
  // Below the clients' tool timeouts (60 s in Codex).
  const confirmWaitMs = context.confirmWaitMs ?? 45_000;
  // Projects whose tests AI clients may run, until the server is turned off or Keywright closes.
  const allowedRuns = new Set();
  let asking = null; // { root, answer } while the question is shown
  /** @type {McpService | null} */
  let service = null;
  /** @type {ChangeLog | null} */
  let changes = null;

  const locations = () => clientLocations({
    project: context.project()?.root,
    ...(context.clientHome ? { env: { KEYWRIGHT_CLIENT_HOME: context.clientHome }, home: context.clientHome } : {}),
  });

  /** Server state, plus each client's configuration and what its own config file says (read-only). */
  function status() {
    if (!service)
      return null;
    const current = service.status();
    const where = locations();
    const states = clientStates(current, where);
    const setups = clientConfigs(current, where).map((client) => {
      const { entry: _entry, ...state } = states[client.id]; // the page needs the verdict, not the entry
      return { ...client, ...state, seen: current.seen[client.id] || null };
    });
    const project = context.project();
    return { ...current, browserOpen: agentBrowser.open, setups, changes: project ? changes.list(project.root) : [] };
  }

  /** The MCP service; throws when it could not be created at startup. */
  function required() {
    if (!service)
      throw new Error('The MCP server is unavailable in this session. Its crash report says why.');
    return service;
  }

  function create() {
    changes = new ChangeLog({ folder: path.join(context.userData, 'mcp-undo') });
    changes.on('change', () => send('mcp:state', status()));
    const tools = createTools({
      changes,
      project: context.project,
      dirtyPaths: context.dirtyPaths,
      trash: context.trash,
      keywords: async () => {
        const unreadable = context.refreshProject();
        if (unreadable)
          return { ok: false, error: unreadable, keywords: [], errors: [] };
        return context.keywordIndex.build(context.project());
      },
      check: async (relative, text) => {
        const worker = context.languageWorker();
        if (!worker)
          return { ok: false, problems: [], error: 'The project has no Python environment with Robot Framework.' };
        try {
          const { problems } = await worker.request('check', { path: relative, text });
          return { ok: true, problems };
        } catch (error) {
          return { ok: false, problems: [], error: error.message };
        }
      },
      discover: async () => {
        const unreadable = context.refreshProject();
        if (unreadable)
          return { ok: false, error: unreadable };
        return context.discoverTests(context.project());
      },
      runner: context.runner,
      confirmRun,
      startRun: async (options) => {
        await context.startRun(options);
        // The Testing panel shows a run it did not start.
        send('tests:started', { select: options.select || [], include: options.include || [], exclude: options.exclude || [] });
      },
      browser: agentBrowser,
      browsers: context.browsers,
      launchError: context.launchError,
    });
    const created = new McpService({ folder: context.userData, version: context.version, tools });
    created.on('state', () => send('mcp:state', status()));
    agentBrowser.on('state', () => send('mcp:state', status()));
    return created;
  }

  async function askRun(project) {
    context.attention?.(true);
    try {
      const { response } = await context.showMessageBox({
        type: 'warning',
        buttons: ['Allow', "Don't Allow"],
        defaultId: 1,
        cancelId: 1,
        message: `Allow the AI client to run the tests of ${project.name}?`,
        detail: 'Tests run with your permissions, including tests and libraries the AI has written. '
          + 'The AI can be influenced by the pages and files it reads.\n\n'
          + 'Allowing lasts for this project until you turn the MCP server off or close Keywright.',
      });
      return response === 0;
    } finally {
      context.attention?.(false);
    }
  }

  /** Asks once per project; throws what the AI client is told when it may not run tests. */
  async function confirmRun() {
    const project = context.project();
    if (!project)
      throw new Error('No project is open.');
    const { root } = project;
    if (allowedRuns.has(root))
      return;
    if (!asking) {
      const question = { root };
      asking = question;
      question.answer = askRun(project).then((allowed) => {
        // Not when the server was turned off meanwhile: the question was dropped.
        if (allowed && asking === question)
          allowedRuns.add(root);
      }).finally(() => {
        if (asking === question)
          asking = null;
      });
    }
    let timer;
    const answered = await Promise.race([
      asking.answer.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), confirmWaitMs); }),
    ]).finally(() => clearTimeout(timer));
    if (!answered)
      throw new Error('Keywright is asking the user whether AI clients may run the tests. Tell the user to answer in Keywright, then call run_tests again.');
    if (context.project()?.root !== root)
      throw new Error('Another project was opened in Keywright.');
    if (!allowedRuns.has(root))
      throw new Error('The user did not allow running the tests. Do not call run_tests again unless the user asks for it.');
  }

  /**
   * An entry read from a file inside the open project was written by whoever made the
   * project: its command runs (or its address is called) only after the user has seen it.
   */
  async function confirmProjectEntry(plan) {
    const project = context.project();
    const relative = project && plan.file ? path.relative(project.root, plan.file) : '..';
    if (relative.startsWith('..') || path.isAbsolute(relative))
      return true; // the client's own file, in the user's profile
    const what = plan.config
      ? [plan.config.command, ...(plan.config.args || [])].join(' ')
        + Object.keys(plan.config.env || {}).map((name) => `\n${name}=${plan.config.env[name]}`).join('')
      : plan.url;
    const { response } = await context.showMessageBox({
      type: 'warning',
      buttons: ['Run Test', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Test the connection with the project\'s configuration?',
      detail: `${relative.split(path.sep).join('/')} in the open project configures the server as:\n\n${what}\n\n`
        + (plan.config ? 'The test runs this command with your permissions.' : 'The test sends requests to this address.')
        + ' Continue only if you trust this project.',
    });
    return response === 0;
  }

  ipcMain.handle('mcp:status', () => status());
  ipcMain.handle('mcp:set-enabled', async (_event, enabled) => {
    await required().setEnabled(!!enabled);
    if (!enabled) {
      allowedRuns.clear();
      asking = null;
      await agentBrowser.close();
    }
    return status();
  });
  ipcMain.handle('mcp:regenerate-token', () => {
    required().regenerateToken();
    return status();
  });
  ipcMain.handle('mcp:close-browser', () => agentBrowser.close());
  ipcMain.handle('mcp:undo-change', (_event, id) => required() && changes.undo(id, {
    dirtyPaths: context.dirtyPaths(),
    trash: context.trash,
  }));
  // Tests what the client will start: the entry in its own file when there is one,
  // otherwise the configuration offered (reported as not configured yet).
  ipcMain.handle('mcp:test-connection', async (_event, clientId) => {
    const current = required().status();
    if (!current.running)
      return { ok: false, scope: 'server', error: 'Turn the server on first.' };
    try {
      const plan = connectionPlan(clientId, current, locations());
      if (plan.kind === 'unreadable')
        return { ok: false, scope: 'client', file: plan.file, error: plan.error };
      if (plan.kind === 'client' && !(await confirmProjectEntry(plan)))
        return { ok: false, scope: 'client', file: plan.file, error: 'The test was cancelled.' };
      const result = plan.config ? await testConnection(plan.config) : await testHttpConnection(plan.url, plan.token);
      return { ...result, scope: plan.kind, file: plan.file || null };
    } catch (error) {
      return { ok: false, scope: 'server', error: error.message };
    }
  });

  return {
    /** Creates the service and turns the server on when the setting is on; throws on failure. */
    async start() {
      service = create();
      await service.restore();
    },
    stop: () => service?.stop(), // the setting stays on for the next start
    status,
    get service() {
      return service;
    },
  };
}

module.exports = { createMcpIpc };
