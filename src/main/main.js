'use strict';

const path = require('path');
const fs = require('fs/promises');
const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, nativeTheme, session: electronSession } = require('electron');
const os = require('os');
const { installStartupDiagnostics } = require('./startupDiagnostics');
const { CrashReports } = require('./crashReports');
// The folder is set once the user-data path is final (app ready).
const crashReports = new CrashReports(null, {
  versions: {
    keywright: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    os: `${os.type()} ${os.release()} ${process.arch}`,
  },
});
installStartupDiagnostics(app, {
  onEvent: (event, details) => {
    crashReports.note(event, details);
    if (event === 'child-process-gone' && !['clean-exit', 'killed'].includes(details.reason))
      writeCrashReport(`${details.type} process stopped`, { reason: details.reason, exitCode: details.exitCode });
  },
});

/** @returns {string | null} the report's path, null if it could not be written */
function writeCrashReport(event, facts) {
  if (!crashReports.folder)
    return null;
  try {
    return crashReports.write(event, facts);
  } catch (error) {
    console.error(`Could not write a crash report: ${error.message}`);
    return null;
  }
}
const { RecorderSession } = require('./recorder');
const { RecentProjects } = require('./recentProjects');
const projects = require('./projects');
const { SourceControl } = require('./sourceControl');
const projectSettings = require('./projectSettings');
const { discoverTests, TestRunner } = require('./testRunner');
const { KeywordIndex } = require('./keywordIndex');
const { RecoveryStore } = require('./recoveryStore');
const { LanguageWorker } = require('./languageWorker');
const { installBrowser, missingBrowser } = require('./browserInstall');
const { ProjectWatcher } = require('./projectWatcher');
const { TraceServer } = require('./traceServer');
const { projectVariables } = require('./projectVariables');
const { searchProject, replaceInProject } = require('./projectSearch');
const { formatRobot, installRobocop } = require('./formatter');
const { AgentBrowser } = require('./mcp/agentBrowser');
const { createMcpIpc } = require('./ipc/mcp');
const { createGeneratorIpc, explainLaunchError, BROWSERS } = require('./ipc/generator');
const { createTestsIpc } = require('./ipc/tests');
const { stopAll, handleQuit } = require('./shutdown');
const { createSourceControlIpc } = require('./ipc/sourceControl');
const { childProcesses } = require('./processes');
const { InterpreterTrust } = require('./interpreterTrust');

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {ReturnType<typeof projects.loadProject> | null} */
let currentProject = null;
let sourceControl = null;
let creatingProject = false;
const session = new RecorderSession();
// UI tests drive the recorded browser through the main process.
if (process.env.KEYWRIGHT_TEST)
  global.__keywrightSession = session;
const runner = new TestRunner();
const keywordIndex = new KeywordIndex();
const traceServer = new TraceServer();
/** @type {LanguageWorker | null} */
let languageWorker = null;
/** @type {ProjectWatcher | null} */
let projectWatcher = null;
let recentProjects = null;
let recovery = null;
// The browser an AI client drives through the MCP tools, separate from the Test Generator's.
// UI tests run it without a window.
const agentBrowser = new AgentBrowser({ headless: process.env.KEYWRIGHT_AI_BROWSER_HEADLESS === '1' });
// Project-relative paths with unsaved changes in the editor, reported by the renderer.
let editorDirtyPaths = [];

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send(channel, payload);
}

// ---------------------------------------------------------------------------
// Projects

function projectInfo() {
  if (!currentProject)
    return null;
  const { root, name, config, python } = currentProject;
  return { root, name, config, python };
}

function setWindowTitle() {
  if (mainWindow)
    mainWindow.setTitle(currentProject ? `${currentProject.name} — Keywright` : 'Keywright');
}

/** The syntax-check worker of the open project (recreated when its Python changes). */
function projectLanguageWorker() {
  if (!currentProject || !currentProject.python)
    return null;
  if (languageWorker && languageWorker.python !== currentProject.python)
    stopLanguageWorker();
  if (!languageWorker)
    languageWorker = new LanguageWorker(currentProject.python, currentProject.root);
  return languageWorker;
}

/** Reports file changes in the open project (editor saves and external edits) to the renderer. */
function watchProject(project) {
  stopWatchingProject();
  projectWatcher = new ProjectWatcher(project.root, { ignore: [project.config.outputDir] });
  projectWatcher.on('changes', (paths) => {
    if (paths.some((file) => /\.py$/i.test(file)))
      keywordIndex.clear(); // A library may import another project Python module.
    send('project:files-changed', paths);
  });
  // Without the watcher, tabs, watch mode and keyword caches stop following the disk:
  // it is started again once, after a moment (a folder briefly renamed, a network drive).
  const watcher = projectWatcher;
  watcher.on('stopped', (error) => {
    console.error(`Stopped watching ${project.root}: ${error?.message || 'unknown error'}`);
    crashReports.note('watcher-stopped', { reason: error?.message || null });
    setTimeout(() => {
      if (projectWatcher === watcher && currentProject?.root === project.root) {
        try {
          watcher.start();
        } catch (restartError) {
          console.error(`Cannot watch ${project.root} again: ${restartError.message}`);
        }
      }
    }, 2000);
  });
  try {
    projectWatcher.start();
  } catch (error) {
    console.error(`Cannot watch ${project.root}: ${error.message}`);
    projectWatcher = null;
  }
}

function stopWatchingProject() {
  if (projectWatcher)
    projectWatcher.stop();
  projectWatcher = null;
}

function stopLanguageWorker() {
  if (languageWorker)
    languageWorker.dispose();
  languageWorker = null;
}

// Opening and closing a project run one after another, so a second request cannot
// interleave with the services of the first.
let projectTransition = Promise.resolve();
function projectTransitionTask(task) {
  const next = projectTransition.then(task, task);
  projectTransition = next.catch(() => {});
  return next;
}

/** Stops what belongs to the open project; waits for the processes to exit. */
async function stopProjectServices() {
  await runner.stop();
  stopLanguageWorker();
  stopWatchingProject();
  traceServer.forget();
  await session.stop();
  session.clear();
  await pickerSession.stop();
}

// ---------------------------------------------------------------------------
// Interpreters outside the project folder are used after the user confirms them
// (interpreterTrust.js). Created when the profile folder is known (app ready).

/** @type {InterpreterTrust | null} */
let interpreterTrust = null;

async function askAboutInterpreter(external) {
  const options = {
    type: 'warning',
    buttons: ['Use This Interpreter', 'Open Without It'],
    defaultId: 1,
    cancelId: 1,
    message: 'This project uses a Python interpreter outside its folder.',
    detail: `keywright.json sets:\n\n${external}\n\nKeywright runs it as soon as the project opens, to read keywords `
      + 'and check files, and when tests run. Use it only if you trust this project and the program at that path.',
  };
  const { response } = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
  return response === 0;
}

/**
 * Reads the open project again from disk, with the interpreter choice applied.
 * @returns {string | null} why it could not be read (keywright.json being edited, say); the
 *   project then stays as it was
 */
function refreshProject() {
  try {
    currentProject = interpreterTrust.apply(projects.loadProject(currentProject.root));
    return null;
  } catch (error) {
    return error.message;
  }
}

function openProject(root) {
  return projectTransitionTask(async () => {
    const project = await interpreterTrust.confirm(projects.loadProject(root));
    await stopProjectServices();
    currentProject = project;
    sourceControl = new SourceControl(project.root);
    keywordIndex.clear();
    watchProject(project);
    try {
      recentProjects.add(project.root);
    } catch (error) {
      console.error(`Could not update the recent projects: ${error.message}`); // the project is open regardless
    }
    setWindowTitle();
    return projectInfo();
  });
}

ipcMain.handle('projects:recent', () => recentProjects.list());
ipcMain.handle('projects:remove-recent', (_event, root) => recentProjects.remove(root));
ipcMain.handle('projects:detect-tools', () => projects.detectTools());
ipcMain.handle('projects:default-location', () => app.getPath('documents'));
ipcMain.handle('projects:validate-name', (_event, name) => projects.validateProjectName(name));
ipcMain.handle('projects:current', () => projectInfo());

ipcMain.handle('projects:pick-folder', async (_event, title, defaultPath) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: title || 'Choose folder',
    defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('projects:pick-python', async (_event, defaultPath) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose the Python interpreter',
    defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : undefined,
    filters: process.platform === 'win32' ? [{ name: 'Python', extensions: ['exe'] }] : [],
    properties: ['openFile'],
  });
  return canceled ? null : filePaths[0];
});

// Project Settings: keywright.json. The renderer reopens the project after a save.
ipcMain.handle('project:settings', () => (currentProject ? projectSettings.readSettings(currentProject.root) : null));
ipcMain.handle('project:save-settings', (_event, values) => {
  if (!currentProject)
    return { ok: false, errors: {}, error: 'No project is open.' };
  try {
    const result = projectSettings.writeSettings(currentProject.root, values || {});
    // An interpreter chosen here is the user's choice: reopening the project does not ask about it.
    const chosen = result.ok && projects.externalInterpreter(projects.loadProject(currentProject.root));
    if (chosen)
      interpreterTrust.trust(currentProject.root, chosen);
    return result;
  } catch (error) {
    return { ok: false, errors: {}, error: error.message };
  }
});

ipcMain.handle('projects:open', async (_event, root) => {
  try {
    return { ok: true, project: await openProject(root) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('projects:create', async (_event, request) => {
  if (creatingProject)
    return { ok: false, error: 'A project is already being created.' };
  creatingProject = true;
  try {
    const result = await projects.createProject(request, {
      onSteps: (steps) => send('setup:steps', steps),
      onStep: (id, status, detail) => send('setup:step', { id, status, detail }),
      onLog: (text) => send('setup:log', text),
    });
    return { ok: result.ok, root: result.root, error: result.error };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    creatingProject = false;
  }
});

ipcMain.handle('projects:close', () => projectTransitionTask(async () => {
  await stopProjectServices();
  currentProject = null;
  sourceControl = null;
  keywordIndex.clear();
  setWindowTitle();
}));

// Asked after every file change: read without blocking the main process.
ipcMain.handle('project:tree', () => (currentProject ? projects.listTreeAsync(currentProject.root) : []));

// The Source Control panel (ipc/sourceControl.js).
createSourceControlIpc({
  ipcMain,
  project: () => currentProject,
  sourceControl: () => sourceControl,
  dirtyPaths: () => editorDirtyPaths,
});

// Search panel: files on disk (open files are searched by the renderer and excluded).
ipcMain.handle('project:search', (_event, options, exclude) => {
  if (!currentProject)
    return { ok: false, error: 'No project is open.' };
  try {
    return { ok: true, ...searchProject(currentProject.root, options, { exclude, outputDir: currentProject.config.outputDir }) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('project:replace', (_event, options, replacement, entries) => {
  if (!currentProject)
    return { ok: false, error: 'No project is open.' };
  try {
    return { ok: true, ...replaceInProject(currentProject.root, options, replacement, entries, { dirtyPaths: editorDirtyPaths }) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('project:variables', () => (currentProject ? projectVariables(currentProject.root) : { runtime: [], suite: [], dynamicSuite: true }));

ipcMain.handle('project:read-file', (_event, relative) => {
  if (!currentProject)
    throw new Error('No project is open.');
  return projects.readProjectFile(currentProject.root, relative);
});

ipcMain.handle('project:write-file', (_event, relative, content, revision) => {
  if (!currentProject)
    throw new Error('No project is open.');
  return projects.writeProjectFile(currentProject.root, relative, content, revision);
});

ipcMain.handle('project:create-file', (_event, relative) => {
  if (!currentProject)
    return { ok: false, error: 'No project is open.' };
  try {
    return { ok: true, path: projects.createProjectFile(currentProject.root, relative) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('project:rename-path', (_event, relative, name) => {
  if (!currentProject)
    return { ok: false, error: 'No project is open.' };
  try {
    return { ok: true, path: projects.renameProjectPath(currentProject.root, relative, name) };
  } catch (error) {
    return { ok: false, error: error.code === 'EPERM' || error.code === 'EBUSY'
      ? `${relative} is in use by another program. Close it there and try again.`
      : error.message };
  }
});

// Deleting moves the file or folder to the Recycle Bin, after a native confirmation.
ipcMain.handle('project:delete-path', async (_event, relative, unsaved = 0) => {
  if (!currentProject)
    return { ok: false, error: 'No project is open.' };
  let entry;
  let folder;
  try {
    ({ entry } = projects.projectEntry(currentProject.root, relative));
    folder = (await fs.lstat(entry)).isDirectory(); // it may have gone since the menu opened
  } catch (error) {
    return { ok: false, error: error.code === 'ENOENT' ? `${relative} no longer exists.` : error.message };
  }
  const name = path.basename(entry);
  const details = [folder ? 'The folder and everything in it will be moved to the Recycle Bin.' : 'The file will be moved to the Recycle Bin.'];
  if (unsaved)
    details.push(`Unsaved changes in ${unsaved === 1 ? 'its open file' : `${unsaved} open files`} will be lost.`);
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Move to Recycle Bin', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    message: `Delete ${folder ? 'folder' : 'file'} "${name}"?`,
    detail: details.join(' '),
  });
  if (response !== 0)
    return { ok: false, canceled: true };
  try {
    await shell.trashItem(entry);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `Could not move ${relative} to the Recycle Bin: ${error.message}` };
  }
});

ipcMain.handle('project:keywords', async () => {
  if (!currentProject)
    return { ok: false, error: 'No project is open.', keywords: [], errors: [] };
  const unreadable = refreshProject();
  if (unreadable)
    return { ok: false, error: unreadable, keywords: [], errors: [] };
  return keywordIndex.build(currentProject);
});

// Unsaved editor buffers of the open project, kept for recovery after a crash.
ipcMain.handle('recovery:read', () => (currentProject && recovery ? recovery.read(currentProject.root) : []));
ipcMain.handle('recovery:store', (_event, entries) => {
  if (!currentProject || !recovery || !Array.isArray(entries))
    return;
  try {
    recovery.write(currentProject.root, entries.filter((entry) => typeof entry?.path === 'string' && typeof entry.content === 'string'));
  } catch (error) {
    console.error(`Cannot store unsaved changes for recovery: ${error.message}`);
  }
});

// Packages installed or libraries changed outside the watched project folder are
// not noticed automatically: forget their documentation and the Python worker's imports.
ipcMain.handle('project:reload-libraries', () => {
  keywordIndex.clear();
  stopLanguageWorker();
});

ipcMain.handle('editor:check', async (_event, relative, text) => {
  const worker = projectLanguageWorker();
  if (!worker)
    return { ok: false, problems: [] };
  try {
    const { problems } = await worker.request('check', { path: relative, text });
    return { ok: true, problems };
  } catch (error) {
    return { ok: false, problems: [], error: error.message };
  }
});

// Robocop lint of unsaved content, in the language worker.
ipcMain.handle('editor:lint', async (_event, relative, text) => {
  const worker = projectLanguageWorker();
  if (!worker)
    return { available: false, problems: [] };
  try {
    return await worker.request('lint', { path: path.join(currentProject.root, relative), root: currentProject.root, text });
  } catch (error) {
    return { available: true, problems: [], error: error.message };
  }
});

// Format Document (Shift+Alt+F) with Robocop.
ipcMain.handle('editor:format', (_event, relative, text) => {
  if (!currentProject)
    return { ok: false, error: 'No project is open.' };
  return formatRobot(currentProject, relative, text);
});

ipcMain.handle('project:install-robocop', () => (currentProject ? installRobocop(currentProject) : { ok: false, error: 'No project is open.' }));

ipcMain.handle('dialog:unsaved', async (_event, names) => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: names.length === 1
      ? `Do you want to save the changes you made to ${names[0]}?`
      : `Do you want to save the changes to ${names.length} files?`,
    detail: names.length === 1 ? "Your changes will be lost if you don't save them." : names.join('\n'),
  });
  return ['save', 'discard', 'cancel'][response];
});

ipcMain.handle('dialog:run-changes', async (_event, names) => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Save All and Run', 'Run Saved Files', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: 'Save your changes before running tests?',
    detail: `Tests read files from disk, including imported resources and Python libraries.\n\nUnsaved files:\n${names.join('\n')}`,
  });
  return ['save', 'saved', 'cancel'][response];
});

ipcMain.handle('dialog:file-conflict', async (_event, relative, deleted) => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: deleted ? ['Keep Editing', 'Recreate File'] : ['Keep Editing', 'Compare…', 'Overwrite File', 'Reload from Disk'],
    defaultId: 0,
    cancelId: 0,
    message: `${relative} ${deleted ? 'was deleted' : 'changed'} on disk.`,
    detail: deleted
      ? 'Keep editing to cancel this save, or recreate the file with your editor contents.'
      : 'Keep editing to cancel this save. Compare shows both versions side by side so you can combine them. Overwrite replaces the disk contents with your editor version. Reload discards your editor changes and opens the disk version.',
  });
  return (deleted ? ['cancel', 'overwrite'] : ['cancel', 'compare', 'overwrite', 'reload'])[response];
});

ipcMain.handle('project:reveal', (_event, relative) => {
  if (!currentProject)
    return;
  const target = relative ? projects.resolveInProject(currentProject.root, relative) : currentProject.root;
  if (relative)
    shell.showItemInFolder(target);
  else
    shell.openPath(target);
});

// ---------------------------------------------------------------------------
// Test runner: runs, their events and history, reports and traces (ipc/tests.js).

const testsIpc = createTestsIpc({
  ipcMain,
  send,
  runner,
  traceServer,
  project: () => currentProject,
  refreshProject,
  discoverTests,
  installBrowsers: projects.installTestBrowsers,
  openPath: (file) => shell.openPath(file),
});
/** Starts a run for the Testing panel or an AI client; throws when it cannot start. */
const startRun = (options) => testsIpc.startRun(options);

// ---------------------------------------------------------------------------
// Test generator: recording, locator picking and saving (ipc/generator.js).

// Pick locator opens this browser when nothing records (kept open for the next picks).
const pickerSession = new RecorderSession();
if (process.env.KEYWRIGHT_TEST)
  global.__keywrightPicker = pickerSession;

const generatorIpc = createGeneratorIpc({
  ipcMain,
  send,
  session,
  pickerSession,
  project: () => currentProject,
  documentsPath: () => app.getPath('documents'),
  showSaveDialog: (options) => dialog.showSaveDialog(mainWindow, options),
  showWindow: () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  },
  note: (event, details) => crashReports.note(event, details),
  install: installBrowser,
  missing: (name) => missingBrowser(name),
});

ipcMain.handle('clipboard:write', (_event, text) => clipboard.writeText(text));
// ---------------------------------------------------------------------------
// MCP server

function aiLaunchError(error, browser) {
  const explained = explainLaunchError(error, browser);
  return explained.install
    ? `${explained.error} Ask the user to install it: Test Generator > Start recording offers the download, or run "npm run install-browsers" in the Keywright folder.`
    : explained.error;
}

// The MCP service, its tools and the mcp:* channels of the MCP dialog (ipc/mcp.js).
const mcpIpc = createMcpIpc({
  ipcMain,
  get userData() { return app.getPath('userData'); },
  version: app.getVersion(),
  send,
  showMessageBox: (options) => dialog.showMessageBox(mainWindow, options),
  trash: (entry) => shell.trashItem(entry),
  project: () => currentProject,
  refreshProject,
  dirtyPaths: () => editorDirtyPaths,
  keywordIndex,
  languageWorker: () => projectLanguageWorker(),
  discoverTests,
  runner,
  startRun,
  agentBrowser,
  browsers: BROWSERS,
  launchError: (error) => aiLaunchError(error, agentBrowser.options.channel || agentBrowser.options.browser),
});
ipcMain.on('editor:dirty-files', (_event, paths) => {
  editorDirtyPaths = Array.isArray(paths) ? paths.filter((item) => typeof item === 'string') : [];
});

// ---------------------------------------------------------------------------
// Window

function openWebLink(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:')
    shell.openExternal(parsed.href).catch((error) => console.error(`Cannot open ${parsed.href}: ${error.message}`));
}

// The page draws the title bar; the system keeps drawing the window buttons, which
// preserves Snap Layouts. One pixel shorter than the page's bar, whose bottom border
// continues under the buttons. The colors match --surface, --text and --muted.
const TITLE_BAR_OVERLAY = { color: '#232a30', symbolColor: '#e2e1d7', height: 35 };
const INACTIVE_SYMBOL_COLOR = '#a3afb5';

// Decided here because the page cannot tell: a focused frame, such as a Robot report,
// blurs the page while the window stays active.
function publishWindowActive() {
  const active = mainWindow.isFocused();
  // macOS has no such method: its window buttons follow window focus by themselves.
  mainWindow.setTitleBarOverlay?.(active ? TITLE_BAR_OVERLAY : { ...TITLE_BAR_OVERLAY, symbolColor: INACTIVE_SYMBOL_COLOR });
  mainWindow.webContents.send('window:active', active);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    title: 'Keywright',
    icon: path.join(__dirname, '../renderer/images/icon-256.png'),
    backgroundColor: '#1c2227',
    titleBarStyle: 'hidden',
    titleBarOverlay: TITLE_BAR_OVERLAY,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on('focus', publishWindowActive);
  mainWindow.on('blur', publishWindowActive);
  // The app never opens other windows or leaves its page. Web links, such as those in
  // keyword documentation, go to the system browser; anything else is ignored.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openWebLink(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    openWebLink(url);
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.webContents.on('did-finish-load', () => {
    editorDirtyPaths = []; // a reloaded page has no unsaved editors yet
    generatorIpc.publishState();
    generatorIpc.publishCode();
    publishWindowActive();
  });
  mainWindow.on('page-title-updated', (event) => event.preventDefault());
  // The renderer cancels unload (beforeunload) while files have unsaved changes.
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Close Without Saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Some files have unsaved changes.',
      detail: 'Your changes will be lost if you close the window.',
    });
    if (choice === 0) {
      event.preventDefault(); // ignore beforeunload and close
      if (currentProject && recovery)
        recovery.clear(currentProject.root); // the changes were discarded deliberately
    }
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit')
      windowStopped(details);
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

/** The page crashed or was killed: save a report and offer to reload it. */
async function windowStopped({ reason, exitCode }) {
  const report = writeCrashReport('Window stopped', { reason, exitCode });
  if (!mainWindow || mainWindow.isDestroyed())
    return;
  const buttons = report ? ['Reload Window', 'Show Crash Report', 'Quit'] : ['Reload Window', 'Quit'];
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'error',
    buttons,
    defaultId: 0,
    cancelId: 0,
    message: 'The Keywright window stopped unexpectedly.',
    detail: [
      `Reason: ${reason}.`,
      'Reload the window to continue. When the project opens again, Keywright offers to restore files with unsaved changes.',
      report ? `A crash report was saved in ${path.dirname(report)}.` : 'The crash report could not be saved.',
    ].join('\n\n'),
  });
  if (!mainWindow || mainWindow.isDestroyed())
    return;
  const choice = buttons[response];
  if (choice === 'Quit') {
    app.quit();
    return;
  }
  if (choice === 'Show Crash Report')
    shell.showItemInFolder(report);
  mainWindow.webContents.reload();
}


// One Keywright per profile: a second one would share and clear the same recovery
// copies, undo backups and MCP connection file. It hands over to the first instead.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance)
  app.quit();
app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed())
    return;
  if (mainWindow.isMinimized())
    mainWindow.restore();
  mainWindow.focus();
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
  console.error(`Unhandled rejection: ${message}`);
  crashReports.note('unhandled-rejection', { message: message.split('\n')[0] });
});

app.whenReady().then(async () => {
  if (!primaryInstance)
    return;
  // The IDE has a dark UI: dark native dialogs and scrollbars, and the embedded
  // Playwright trace viewer follows prefers-color-scheme.
  nativeTheme.themeSource = 'dark';
  // Electron grants permissions by default. Only the app's own page may use the clipboard
  // (Monaco's Copy and Paste); Robot reports and traces in frames, project content that can
  // run scripts, get nothing.
  const ownPage = (url) => String(url || '').startsWith('file:');
  const clipboardPermission = (permission) => /^clipboard-(read|sanitized-write)$/.test(permission);
  electronSession.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) =>
    callback(clipboardPermission(permission) && ownPage(details.requestingUrl)));
  electronSession.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
    clipboardPermission(permission) && ownPage(details?.requestingUrl || requestingOrigin));
  recentProjects = new RecentProjects(path.join(app.getPath('userData'), 'recent-projects.json'));
  recovery = new RecoveryStore(path.join(app.getPath('userData'), 'recovery'));
  recovery.removeLeftovers();
  interpreterTrust = new InterpreterTrust({
    file: path.join(app.getPath('userData'), 'trusted-interpreters.json'),
    ask: askAboutInterpreter,
  });
  crashReports.folder = path.join(app.getPath('userData'), 'crash-reports');
  // The window opens even when the MCP server cannot start.
  try {
    await mcpIpc.start();
  } catch (error) {
    console.error(`The MCP server could not start: ${error.message}`);
    writeCrashReport('MCP server could not start', { reason: error.message });
  }
  // `electron . <folder>` opens a project directly.
  // Electron may put its debugger switches before the application entry path.
  const positionalArgs = process.argv.slice(1).filter((arg) => !arg.startsWith('-'));
  const folderArg = positionalArgs[app.isPackaged ? 0 : 1];
  if (folderArg) {
    try {
      await openProject(folderArg);
    } catch (error) {
      console.error(error.message);
    }
  }
  createWindow();
  setWindowTitle();
});

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:open-crash-reports', async () => {
  const folder = crashReports.folder;
  await fs.mkdir(folder, { recursive: true });
  const error = await shell.openPath(folder);
  if (error)
    throw new Error(error);
});

// Every way of quitting goes through before-quit, which stops the services and
// processes first, each within a time limit (shutdown.js). A second instance that
// hands over to the first owns none of them.
handleQuit(app, {
  enabled: primaryInstance,
  stop: () => stopAll([
    ['tests', () => runner.stop()],
    ['trace server', () => traceServer.stop()],
    ['language worker', () => stopLanguageWorker()],
    ['file watcher', () => stopWatchingProject()],
    ['recorder', () => session.stop()],
    ['locator picker', () => pickerSession.stop()],
    ['AI browser', () => agentBrowser.close()],
    ['MCP server', () => mcpIpc.stop()], // the setting stays on for the next start
    ['child processes', () => childProcesses.killAll()],
  ]),
});

app.on('window-all-closed', () => app.quit());
