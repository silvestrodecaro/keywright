'use strict';

const path = require('path');
const fs = require('fs/promises');
const { existsSync } = require('fs');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, nativeTheme } = require('electron');
const { RecorderSession } = require('./recorder');
const { RecentProjects } = require('./recentProjects');
const projects = require('./projects');
const { discoverTests, TestRunner, screenshotsFromHtml } = require('./testRunner');
const { KeywordIndex } = require('./keywordIndex');
const { LanguageWorker } = require('./languageWorker');
const { installBrowser } = require('./browserInstall');
const { ProjectWatcher } = require('./projectWatcher');
const { TraceServer } = require('./traceServer');
const { generateRobot, generateSteps, DEFAULT_OPTIONS } = require('../generator/robotGenerator');
const { toBrowserSelector } = require('../generator/selectors');

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {ReturnType<typeof projects.loadProject> | null} */
let currentProject = null;
let creatingProject = false;
const session = new RecorderSession();
// UI tests drive the recorded browser through the main process.
if (process.env.RFIDE_TEST)
  global.__rfideSession = session;
const runner = new TestRunner();
const keywordIndex = new KeywordIndex();
const traceServer = new TraceServer();
/** @type {LanguageWorker | null} */
let languageWorker = null;
/** @type {ProjectWatcher | null} */
let projectWatcher = null;
let runOutputDir = null;
let generatorOptions = { ...DEFAULT_OPTIONS };
let recentProjects = null;

// Browser choices offered in the UI: the Playwright browser to record with and
// the matching `New Browser` arguments of the generated test.
const BROWSERS = {
  chromium: { browser: 'chromium', channel: null },
  chrome: { browser: 'chromium', channel: 'chrome' },
  msedge: { browser: 'chromium', channel: 'msedge' },
  firefox: { browser: 'firefox', channel: null },
  webkit: { browser: 'webkit', channel: null },
};

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
    mainWindow.setTitle(currentProject ? `${currentProject.name} — Robot Framework IDE` : 'Robot Framework IDE');
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
  projectWatcher.on('changes', (paths) => send('project:files-changed', paths));
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

async function openProject(root) {
  const project = projects.loadProject(root);
  runner.stop();
  stopLanguageWorker();
  await session.stop();
  session.clear();
  currentProject = project;
  watchProject(project);
  recentProjects.add(project.root);
  setWindowTitle();
  return projectInfo();
}

ipcMain.handle('projects:recent', () => recentProjects.list());
ipcMain.handle('projects:remove-recent', (_event, root) => recentProjects.remove(root));
ipcMain.handle('projects:detect-tools', () => projects.detectTools());
ipcMain.handle('projects:default-location', () => app.getPath('documents'));
ipcMain.handle('projects:validate-name', (_event, name) => projects.validateProjectName(name));
ipcMain.handle('projects:current', () => projectInfo());

ipcMain.handle('projects:pick-folder', async (_event, title) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: title || 'Choose folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  return canceled ? null : filePaths[0];
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

ipcMain.handle('projects:close', async () => {
  runner.stop();
  stopLanguageWorker();
  stopWatchingProject();
  await session.stop();
  session.clear();
  currentProject = null;
  setWindowTitle();
});

ipcMain.handle('project:tree', () => (currentProject ? projects.listTree(currentProject.root) : []));

ipcMain.handle('project:read-file', (_event, relative) => {
  if (!currentProject)
    throw new Error('No project is open.');
  return projects.readProjectFile(currentProject.root, relative);
});

ipcMain.handle('project:write-file', (_event, relative, content) => {
  if (!currentProject)
    throw new Error('No project is open.');
  projects.writeProjectFile(currentProject.root, relative, content);
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

ipcMain.handle('project:keywords', async () => {
  if (!currentProject)
    return { ok: false, error: 'No project is open.', keywords: [], errors: [] };
  currentProject = projects.loadProject(currentProject.root);
  return keywordIndex.build(currentProject);
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
// Test runner (UI mode)

runner.on('event', (event) => {
  if (event.type === 'log' && event.html && runOutputDir) {
    const images = screenshotsFromHtml(event.text, runOutputDir).filter((file) => existsSync(file));
    if (images.length)
      event.images = images.map((file) => pathToFileURL(file).href);
  }
  send('tests:event', event);
});
runner.on('output', (text) => send('tests:output', text));
runner.on('finished', (result) => send('tests:finished', result));

ipcMain.handle('tests:discover', () => {
  if (!currentProject)
    return { ok: false, error: 'No project is open.' };
  // Reload: the virtual environment may have been created since the project was opened.
  currentProject = projects.loadProject(currentProject.root);
  return discoverTests(currentProject);
});

ipcMain.handle('tests:run', async (_event, options = {}) => {
  if (!currentProject)
    return { ok: false, error: 'No project is open.' };
  try {
    runOutputDir = path.resolve(currentProject.root, currentProject.config.outputDir);
    traceServer.allow([runOutputDir]);
    await runner.run(currentProject, {
      select: options.select || [],
      variables: options.headed ? { HEADLESS: 'False' } : {},
      trace: !!options.trace,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('tests:stop', () => runner.stop());

ipcMain.handle('tests:trace-url', async (_event, traceFile) => {
  if (!traceFile || !existsSync(traceFile))
    return { ok: false, error: 'The trace is written when the browser context is closed: at the end of the test, or of the suite when the context was created in a suite setup.' };
  try {
    return { ok: true, url: await traceServer.urlFor(traceFile) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('tests:open-output', async (_event, file) => {
  if (!runOutputDir || !['log.html', 'report.html'].includes(file))
    return 'No results yet.';
  return shell.openPath(path.join(runOutputDir, file));
});

// ---------------------------------------------------------------------------
// Test generator

function describeStep(action) {
  switch (action.name) {
    case 'openPage': return action.url && action.url !== 'about:blank' ? action.url : 'new page';
    case 'navigate': return action.url;
    case 'fill': return `${toBrowserSelector(action.selector)} ← "${action.text}"`;
    case 'press': return `${toBrowserSelector(action.selector)} ⌨ ${action.key}`;
    case 'select': return `${toBrowserSelector(action.selector)} → ${action.options.join(', ')}`;
    case 'assertText': return `${toBrowserSelector(action.selector)} ${action.substring ? 'contains' : 'is'} "${action.text}"`;
    case 'assertValue': return `${toBrowserSelector(action.selector)} = "${action.value || ''}"`;
    default: return action.selector ? toBrowserSelector(action.selector) : '';
  }
}

function publishCode() {
  send('recorder:code', {
    code: generateRobot(session.actions, generatorOptions),
    lines: generateSteps(session.actions), // for "Record at cursor" in the editor
    steps: session.actions.map((action) => ({
      name: action.name,
      detail: describeStep(action),
      signals: (action.signals || []).map((s) => s.name),
    })),
  });
}

function publishState(extra = {}) {
  send('recorder:state', { recording: session.recording, ...extra });
}

session.on('actions', publishCode);
session.on('stopped', () => publishState());

ipcMain.handle('recorder:start', async (_event, options) => {
  const target = BROWSERS[options.browser] || BROWSERS.chromium;
  generatorOptions = { ...generatorOptions, ...target, viewport: options.viewport || null };
  try {
    await session.start({ ...target, url: options.url, viewport: options.viewport });
    publishState();
    return { ok: true };
  } catch (error) {
    publishState();
    return { ok: false, ...explainLaunchError(error, options.browser) };
  }
});

ipcMain.handle('recorder:install-browser', async (_event, name) => {
  try {
    await installBrowser(name, (text) => send('recorder:install-log', text));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('recorder:stop', () => session.stop());
ipcMain.handle('recorder:clear', () => session.clear());
ipcMain.handle('recorder:remove-step', (_event, index) => session.removeAction(index));

ipcMain.handle('generator:set-options', (_event, options) => {
  generatorOptions = { ...generatorOptions, ...options };
  publishCode();
});

ipcMain.handle('clipboard:write', (_event, text) => clipboard.writeText(text));

function suggestedFileName() {
  const slug = (generatorOptions.testName || 'recorded test')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${slug || 'recorded_test'}.robot`;
}

ipcMain.handle('file:save', async (_event, code) => {
  const folder = currentProject
    ? path.join(currentProject.root, currentProject.config.testsDir)
    : app.getPath('documents');
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Robot Framework test',
    defaultPath: path.join(folder, suggestedFileName()),
    filters: [{ name: 'Robot Framework', extensions: ['robot'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (canceled || !filePath)
    return null;
  await fs.writeFile(filePath, code, 'utf8');
  return filePath;
});

/** @returns {{ error: string, install?: string }} install: the Playwright browser that can be downloaded */
function explainLaunchError(error, browser) {
  const message = String(error && error.message || error).split('\n')[0];
  if (/Executable doesn't exist|browserType\.launch: .*not found|is not found/i.test(message)) {
    const target = BROWSERS[browser] || BROWSERS.chromium;
    if (target.channel)
      return { error: `${message}\nThis browser does not seem to be installed on this machine.` };
    return { error: `The ${target.browser} browser used by the Test Generator is not installed yet.`, install: target.browser };
  }
  return { error: message };
}

// ---------------------------------------------------------------------------
// Window

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    title: 'Robot Framework IDE',
    backgroundColor: '#16181d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.webContents.on('did-finish-load', () => {
    publishState();
    publishCode();
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
    if (choice === 0)
      event.preventDefault(); // ignore beforeunload and close
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  // The IDE has a dark UI: dark native dialogs and scrollbars, and the embedded
  // Playwright trace viewer follows prefers-color-scheme.
  nativeTheme.themeSource = 'dark';
  recentProjects = new RecentProjects(path.join(app.getPath('userData'), 'recent-projects.json'));
  // `electron . <folder>` opens a project directly.
  const folderArg = process.argv.slice(app.isPackaged ? 1 : 2).find((arg) => !arg.startsWith('-'));
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

app.on('window-all-closed', async () => {
  runner.stop();
  traceServer.stop();
  stopLanguageWorker();
  stopWatchingProject();
  await session.stop();
  app.quit();
});
