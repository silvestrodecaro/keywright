'use strict';

// Application shell: welcome screen, project creation and the project view
// (tabs, with the Explorer in explorer.js). The Test Generator tab lives in generator.js.
(function () {
  const $ = (selector) => document.querySelector(selector);
  const api = window.keywright;

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  }

  function showError(target, message) {
    target.textContent = message || '';
    target.hidden = !message;
  }

  function showView(name) {
    for (const view of document.querySelectorAll('.view'))
      view.hidden = view.id !== `view-${name}`;
    const inProjectView = name === 'project';
    $('#titlebar-actions').hidden = !inProjectView;
    $('#project-root').hidden = !inProjectView;
    if (!inProjectView)
      $('#project-name').textContent = 'Keywright';
  }

  api.onWindowActive((active) => document.body.classList.toggle('window-inactive', !active));

  // -------------------------------------------------------------------------
  // Welcome

  async function showWelcome() {
    showView('welcome');
    showError($('#welcome-error'), '');
    const recent = await api.recentProjects();
    $('#recent').replaceChildren(...recent.map((project) => {
      const open = el('button', { type: 'button', className: 'recent-open', title: project.root },
        el('span', { className: 'recent-name', textContent: project.name }),
        el('span', { className: 'recent-path', textContent: project.root }));
      open.addEventListener('click', () => openProject(project.root));
      const remove = el('button', { type: 'button', className: 'icon-btn recent-remove', title: 'Remove from list', textContent: '✕' });
      remove.addEventListener('click', async () => {
        await api.removeRecentProject(project.root);
        showWelcome();
      });
      return el('li', {}, open, remove);
    }));
    $('#recent-empty').hidden = recent.length > 0;
  }

  async function openProject(root, errorTarget = $('#welcome-error')) {
    const result = await api.openProject(root);
    if (!result.ok) {
      showError(errorTarget, result.error);
      return;
    }
    showProject(result.project);
  }

  $('#welcome-new').addEventListener('click', () => showCreate());
  $('#welcome-open').addEventListener('click', async () => {
    const folder = await api.pickFolder('Open Robot Framework project');
    if (folder)
      openProject(folder);
  });

  // -------------------------------------------------------------------------
  // New project

  let lastCreatedRoot = null;

  function updatePathPreview() {
    const name = $('#create-name').value.trim();
    const location = $('#create-location').value.trim().replace(/[\\/]+$/, '');
    const separator = location.includes('\\') ? '\\' : '/';
    $('#create-path').textContent = name && location ? `${location}${separator}${name}` : '—';
  }

  function setTool(target, checkbox, found, label, missing) {
    target.textContent = found ? `${label} ${found}` : missing;
    target.classList.toggle('is-missing', !found);
    if (!found) {
      checkbox.checked = false;
      checkbox.disabled = true;
    }
  }

  function syncOptions() {
    const venv = $('#opt-venv');
    const browsers = $('#opt-browsers');
    browsers.closest('label').classList.toggle('is-disabled', !venv.checked);
    if (!venv.checked)
      browsers.checked = false;
    browsers.disabled = !venv.checked || browsers.dataset.unavailable === 'true';
  }

  async function showCreate() {
    showView('create');
    $('#create-form').hidden = false;
    $('#setup').hidden = true;
    showError($('#create-error'), '');
    $('#create-name').value = '';
    if (!$('#create-location').value)
      $('#create-location').value = await api.defaultProjectLocation();
    updatePathPreview();
    $('#create-name').focus();

    for (const id of ['#tool-python', '#tool-node', '#tool-git'])
      $(id).textContent = 'checking…';
    const tools = await api.detectTools();
    setTool($('#tool-python'), $('#opt-venv'), tools.python, 'Python', 'Python 3.10+ not found on PATH');
    setTool($('#tool-node'), $('#opt-browsers'), tools.node, 'Node.js', 'Node.js not found on PATH (required by rfbrowser init)');
    setTool($('#tool-git'), $('#opt-git'), tools.git, 'git', 'git not found on PATH');
    $('#opt-browsers').dataset.unavailable = String(!tools.node);
    syncOptions();
  }

  $('#create-name').addEventListener('input', updatePathPreview);
  $('#create-location').addEventListener('input', updatePathPreview);
  $('#opt-venv').addEventListener('change', syncOptions);
  $('#create-cancel').addEventListener('click', showWelcome);
  $('#create-browse').addEventListener('click', async () => {
    const folder = await api.pickFolder('Choose where to create the project');
    if (folder) {
      $('#create-location').value = folder;
      updatePathPreview();
    }
  });

  $('#create-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('#create-name').value.trim();
    const nameError = await api.validateProjectName(name);
    if (nameError) {
      showError($('#create-error'), nameError);
      return;
    }
    showError($('#create-error'), '');
    $('#create-submit').disabled = true;
    $('#setup-steps').replaceChildren();
    $('#setup-log').textContent = '';
    $('#setup-result').hidden = true;
    $('#setup-open').hidden = true;
    $('#setup-back').hidden = true;

    let result;
    try {
      result = await api.createProject({
        name,
        location: $('#create-location').value.trim(),
        createVenv: $('#opt-venv').checked,
        installBrowsers: $('#opt-browsers').checked,
        initGit: $('#opt-git').checked,
      });
    } catch (error) {
      result = { ok: false, error: error.message };
    } finally {
      $('#create-submit').disabled = false;
    }

    if (!result.root) {
      // Validation failed before anything was created.
      $('#create-form').hidden = false;
      $('#setup').hidden = true;
      showError($('#create-error'), result.error);
      return;
    }
    lastCreatedRoot = result.root;
    const box = $('#setup-result');
    box.hidden = false;
    box.className = 'setup-result ' + (result.ok ? 'is-ok' : 'is-failed');
    box.textContent = result.ok
      ? 'Project created.'
      : `Setup did not complete: ${result.error}\nThe project folder was created; you can open it and finish the setup by hand.`;
    $('#setup-open').hidden = false;
    $('#setup-back').hidden = result.ok;
    if (result.ok)
      $('#setup-open').focus();
  });

  api.onSetupSteps((steps) => {
    $('#create-form').hidden = true;
    $('#setup').hidden = false;
    $('#setup-steps').replaceChildren(...steps.map((step) => el('li', { className: 'setup-step is-pending', id: `setup-step-${step.id}` },
      el('span', { className: 'setup-icon' }),
      el('span', { className: 'setup-title', textContent: step.title }))));
  });

  api.onSetupStep(({ id, status }) => {
    const step = $(`#setup-step-${id}`);
    if (step)
      step.className = `setup-step is-${status}`;
  });

  const MAX_LOG = 200_000;
  api.onSetupLog((text) => {
    const log = $('#setup-log');
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
    log.textContent = (log.textContent + text).slice(-MAX_LOG);
    if (atBottom)
      log.scrollTop = log.scrollHeight;
  });

  $('#setup-open').addEventListener('click', () => openProject(lastCreatedRoot, $('#setup-result')));
  $('#setup-back').addEventListener('click', showWelcome);

  // -------------------------------------------------------------------------
  // Project view: explorer and tabs

  const GENERATOR_TAB = '__generator__';
  const RESULTS_TAB = '__results__';
  const GIT_DIFF_TAB = '__git_diff__';
  const FIXED_TABS = [
    { id: GENERATOR_TAB, label: '● Test Generator', pane: '#pane-generator' },
    { id: RESULTS_TAB, label: '▶ Test Results', pane: '#pane-results' },
  ];
  let tabs = [];
  let activeTab = GENERATOR_TAB;
  let currentConfig = null;
  let currentRoot = null;
  let previousDiffTab = GENERATOR_TAB;
  let hasGitDiff = false;

  const sourceControl = window.RFSourceControl.create({
    api, el, openFile, closeDiff: closeGitDiff,
    compare: (container, relative, { original, modified }, focus) => {
      ensureEditor();
      return editor.createComparison(container, { path: relative, disk: original, mine: modified, readOnly: true, focus });
    },
    activateDiff: () => {
      if (activeTab !== GIT_DIFF_TAB)
        previousDiffTab = activeTab;
      hasGitDiff = true;
      activate(GIT_DIFF_TAB);
    },
  });

  function showProject(project) {
    showView('project');
    $('#project-name').textContent = project.name;
    $('#project-root').textContent = project.root;
    $('#project-root').title = project.root;
    $('#python-status').textContent = project.python
      ? `Python: ${project.python}`
      : 'No project virtual environment (.venv) found';
    explorer.reset(project.config);
    tabs = [];
    currentConfig = project.config;
    currentRoot = project.root;
    activeTab = GENERATOR_TAB;
    hasGitDiff = false;
    sourceControl.setProject(project.root);
    showSidebar('explorer');
    renderTabs();
    explorer.refresh();
    window.dispatchEvent(new CustomEvent('keywright:project-opened', { detail: project }));
    $('#reload-libraries').hidden = !project.python;
    setEditorStatus('Loading keywords…');
    loadKeywords();
    offerRecovery();
  }

  function showSidebar(name) {
    for (const button of document.querySelectorAll('.sidebar-tab')) {
      button.classList.toggle('is-active', button.dataset.sidebar === name);
      button.setAttribute('aria-selected', String(button.dataset.sidebar === name));
      button.tabIndex = button.dataset.sidebar === name ? 0 : -1;
    }
    for (const section of document.querySelectorAll('.sidebar-section'))
      section.hidden = section.id !== `sidebar-${name}`;
    if (name === 'source-control')
      sourceControl.refresh();
  }

  for (const button of document.querySelectorAll('.sidebar-tab'))
    button.addEventListener('click', () => showSidebar(button.dataset.sidebar));
  window.RFTree.bindTabs($('.sidebar-switch'));
  const explorer = window.RFExplorer.create({
    api, el, showError, status: setEditorStatus,
    root: () => currentRoot,
    config: () => currentConfig,
    activeTab: () => activeTab,
    hasTab: (path) => tabs.some((t) => t.path === path),
    openFile, showSidebar,
    showHistory: (path) => sourceControl.showHistory(path),
    renamePath, deletePath,
  });

  // -------------------------------------------------------------------------
  // File tabs (Monaco editor, see editor/index.js)

  const editor = window.RFEditor;
  // A file that changed on disk while being saved: both versions side by side (compareDialog.js).
  const compareDialog = window.RFCompareDialog.create({ editor });
  const workspace = new window.RFWorkspaceFiles.WorkspaceFiles({
    editor, api,
    getFile: (path) => tabs.find((tab) => tab.path === path),
    status: (text, error) => setEditorStatus(text, error),
    onSaved: (path) => window.dispatchEvent(new CustomEvent('keywright:file-saved', { detail: { path, fromEditor: true } })),
    compare: (request) => compareDialog.compareVersions(request),
  });
  window.RFWorkspace = workspace;

  let editorMounted = false;
  let shownInEditor = null; // path currently displayed by the editor

  function ensureEditor() {
    if (!editorMounted) {
      editor.mount($('#editor'));
      editorMounted = true;
    }
  }

  async function openFile(relative, line = null, column = 1, length = 0) {
    let tab = tabs.find((t) => t.path === relative);
    if (!tab) {
      const root = currentRoot;
      const file = await workspace.read(relative);
      if (currentRoot !== root)
        return; // another project was opened meanwhile
      // A second request for the same file may have opened it while this one read it.
      tab = tabs.find((t) => t.path === relative);
      if (!tab) {
        tab = { path: relative, content: file.content, reason: file.reason, revision: file.revision };
        tabs.push(tab);
      }
    }
    tab.line = line;
    tab.column = column;
    tab.selectLength = length;
    shownInEditor = null; // force the editor to (re)show the file and reveal the line
    activate(relative);
  }

  const saveFile = (relative) => workspace.save(relative);

  /** Asks what to do with unsaved files; returns false when the user cancels. */
  const resolveUnsaved = (paths) => workspace.resolveUnsaved(paths);

  async function closeTab(relative) {
    if (editor.recordingPath() === relative)
      await api.stopRecording();
    if (!await resolveUnsaved([relative]))
      return;
    const index = tabs.findIndex((t) => t.path === relative);
    if (index < 0)
      return;
    tabs.splice(index, 1);
    editor.close(relative);
    if (shownInEditor === relative)
      shownInEditor = null;
    if (activeTab === relative)
      activeTab = tabs.length ? tabs[Math.max(0, index - 1)].path : RESULTS_TAB;
    renderTabs();
    explorer.refresh();
    scheduleRecovery();
  }

  async function closeAllTabs() {
    if (!await resolveUnsaved(tabs.map((t) => t.path)))
      return false;
    // Recording at the cursor of a closing file would leave the editor read-only.
    if (tabs.some((tab) => editor.recordingPath() === tab.path))
      await api.stopRecording();
    for (const tab of tabs)
      editor.close(tab.path);
    tabs = [];
    shownInEditor = null;
    await storeRecovery();
    return true;
  }

  function activate(tabId) {
    activeTab = tabId;
    renderTabs();
    explorer.refresh();
  }

  function closeGitDiff() {
    hasGitDiff = false;
    sourceControl.clearDiff();
    if (activeTab === GIT_DIFF_TAB) {
      const previousExists = FIXED_TABS.some((tab) => tab.id === previousDiffTab)
        || tabs.some((tab) => tab.path === previousDiffTab);
      activate(previousExists ? previousDiffTab : RESULTS_TAB);
      $('#tabs [aria-selected="true"]')?.focus();
    } else {
      renderTabs();
    }
  }

  $('#source-diff-close').addEventListener('click', closeGitDiff);

  // The tab bar and the shown pane (tabBar.js); the tab state stays here.
  const tabBar = window.RFTabBar.create({
    el, editor, fixedTabs: FIXED_TABS, gitDiffTab: GIT_DIFF_TAB,
    tabs: () => tabs,
    activeTab: () => activeTab,
    hasGitDiff: () => hasGitDiff,
    shownInEditor: () => shownInEditor,
    setShownInEditor: (path) => { shownInEditor = path; },
    activate, closeTab, ensureEditor, renderProblems, renderRecordBar,
  });

  function renderTabs() {
    tabBar.render();
  }

  // Only when a file becomes modified or saved: rebuilding the tabs on every keystroke is wasted work.
  editor.onDirtyStateChange(() => renderTabs());

  // -------------------------------------------------------------------------
  // Record at cursor and Pick locator (recordAtCursor.js)

  const recordAtCursor = window.RFRecordAtCursor.create({
    api, editor, showError, status: setEditorStatus,
    activeTab: () => activeTab,
    activeFile: () => tabs.find((t) => t.path === activeTab),
  });

  function renderRecordBar() {
    recordAtCursor.render();
  }

  editor.onProblems((path, counts) => {
    if (path === activeTab)
      renderProblems(counts);
  });

  function renderProblems(counts) {
    const target = $('#file-problems');
    if (!counts) {
      target.replaceChildren();
      return;
    }
    const parts = [];
    if (counts.errors)
      parts.push(el('span', { className: 'status-fail', textContent: `✕ ${counts.errors}` }));
    if (counts.warnings)
      parts.push(el('span', { className: 'status-skip', textContent: `⚠ ${counts.warnings}` }));
    if (!parts.length)
      parts.push(el('span', { className: 'status-pass', textContent: '✓ No problems' }));
    target.replaceChildren(...parts);
  }
  editor.onSave((path) => saveFile(path));
  editor.onOpenRequest((path, line) => openFile(path, line));
  window.RFTree.bindTabs($('#tabs'));
  $('#tabs').addEventListener('keydown', (event) => {
    if (event.key !== 'Delete' || event.target.getAttribute('role') !== 'tab')
      return;
    if (activeTab === GIT_DIFF_TAB)
      closeGitDiff();
    else if (tabs.some((tab) => tab.path === activeTab))
      closeTab(activeTab);
    else
      return;
    event.preventDefault();
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && tabs.some((t) => t.path === activeTab)) {
      event.preventDefault();
      saveFile(activeTab);
    }
  });

  window.addEventListener('beforeunload', (event) => {
    // Main process shows a confirmation dialog (will-prevent-unload).
    if (editor.dirtyPaths().length) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  // -------------------------------------------------------------------------
  // Crash recovery: unsaved buffers are copied to the IDE's data folder while
  // editing. Nothing is written until a pending recovery has been restored or
  // discarded, so opening a project cannot overwrite it.

  let recoveryTimer = null;
  let recoveryReady = false;

  function recoveryEntries() {
    return editor.dirtyPaths()
      .map((path) => ({ path, tab: tabs.find((t) => t.path === path) }))
      .filter(({ tab }) => tab)
      .map(({ path, tab }) => ({ path, content: editor.getContent(path), revision: tab.revision ?? null }));
  }

  /** The main process refuses AI changes to files with unsaved editor changes. */
  let reportedDirty = '';
  function reportDirtyFiles() {
    const paths = editor.dirtyPaths().filter((path) => tabs.some((tab) => tab.path === path));
    const key = JSON.stringify(paths);
    if (key !== reportedDirty) {
      reportedDirty = key;
      api.reportDirtyFiles(paths);
    }
  }

  function storeRecovery() {
    reportDirtyFiles();
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
    return recoveryReady ? api.storeRecovery(recoveryEntries()) : Promise.resolve();
  }

  /** Stores at most once per second while typing. */
  function scheduleRecovery() {
    reportDirtyFiles();
    if (recoveryReady && !recoveryTimer)
      recoveryTimer = setTimeout(storeRecovery, 1000);
  }

  // A project opened again quickly starts a new offer: the earlier one must not store or show
  // the previous project's copies.
  let recoveryRequest = 0;

  async function offerRecovery() {
    const request = ++recoveryRequest;
    recoveryReady = false;
    // The last copy may predate a save made just before closing: skip what is already on disk.
    const entries = [];
    for (const entry of await api.readRecovery()) {
      const disk = await api.readProjectFile(entry.path).catch(() => null);
      if (!disk || disk.content !== entry.content)
        entries.push(entry);
    }
    if (request !== recoveryRequest)
      return;
    if (!entries.length) {
      recoveryReady = true;
      await storeRecovery();
      return;
    }
    const notice = $('#recovery-notice');
    const count = entries.length === 1 ? '1 file' : `${entries.length} files`;
    $('#recovery-notice-text').textContent = `Keywright closed with unsaved changes in ${count}: ${entries.map((e) => e.path).join(', ')}`;
    notice.dataset.entries = JSON.stringify(entries);
    notice.hidden = false;
  }

  async function restoreRecovery(entries) {
    const failed = [];
    for (const entry of entries) {
      let tab = tabs.find((t) => t.path === entry.path);
      if (!tab) {
        let disk = null;
        try {
          disk = await api.readProjectFile(entry.path);
        } catch {
          // Deleted since the crash: saving recreates it.
        }
        if (disk && disk.content === null) {
          failed.push(entry.path);
          continue;
        }
        // A file changed on disk keeps the revision the edits started from, so
        // saving it raises the usual conflict instead of overwriting silently.
        const revision = disk && disk.revision === entry.revision ? disk.revision : (entry.revision ?? null);
        tab = { path: entry.path, content: disk ? disk.content : '', revision: disk ? revision : null };
        tabs.push(tab);
      }
      shownInEditor = null;
      activate(entry.path);
      editor.restoreContent(entry.path, entry.content);
    }
    renderTabs();
    if (failed.length)
      setEditorStatus(`Could not restore ${failed.join(', ')}`, true);
    else
      setEditorStatus(`Restored unsaved changes in ${entries.length === 1 ? '1 file' : `${entries.length} files`}. Save to keep them.`);
  }

  async function finishRecovery(restore) {
    const notice = $('#recovery-notice');
    const entries = JSON.parse(notice.dataset.entries || '[]');
    notice.hidden = true;
    delete notice.dataset.entries;
    if (restore)
      await restoreRecovery(entries);
    recoveryReady = true;
    await storeRecovery();
  }

  $('#recovery-restore').addEventListener('click', () => finishRecovery(true));
  $('#recovery-discard').addEventListener('click', () => finishRecovery(false));
  editor.onDirtyChange(scheduleRecovery);

  // -------------------------------------------------------------------------
  // Editor status line, and the keyword index for completion and hover (keywordLoader.js)

  function setEditorStatus(text, isError = false) {
    const status = $('#editor-status');
    status.textContent = text;
    status.classList.toggle('is-error', isError);
  }

  const keywordLoader = window.RFKeywordLoader.create({
    api, editor, status: setEditorStatus,
    statusTitle: (title) => { $('#editor-status').title = title; },
  });

  function loadKeywords() {
    return keywordLoader.load();
  }

  function scheduleKeywords() {
    keywordLoader.schedule();
  }

  const names = window.RFFileNames;

  // -------------------------------------------------------------------------
  // Explorer file actions: rename and delete on disk, with the tabs and the editor

  /** Renames on disk. Open tabs inside it follow the new path once their unsaved edits are resolved. */
  async function renamePath(relative, name) {
    const affected = tabs.filter((tab) => names.isWithin(tab.path, relative));
    if (!await resolveUnsaved(affected.map((tab) => tab.path)))
      return { ok: false };
    if (affected.some((tab) => editor.recordingPath() === tab.path))
      await api.stopRecording();
    const result = await api.renameProjectPath(relative, name);
    if (!result.ok)
      return result;
    explorer.pathMoved(relative, result.path);
    for (const tab of affected) {
      const next = names.moved(tab.path, relative, result.path);
      editor.close(tab.path);
      const file = await workspace.read(next);
      Object.assign(tab, { path: next, content: file.content, reason: file.reason, revision: file.revision, line: null });
    }
    // Breakpoints of the renamed files, open or not, follow them.
    editor.moveBreakpoints((path) => (names.isWithin(path, relative) ? names.moved(path, relative, result.path) : null));
    if (names.isWithin(activeTab, relative))
      activeTab = names.moved(activeTab, relative, result.path);
    if (affected.length) {
      shownInEditor = null;
      renderTabs();
      scheduleRecovery();
    }
    setEditorStatus(`Renamed ${relative} to ${result.path}`);
    return result;
  }

  /** Moves a file or folder to the Recycle Bin after confirmation and closes its tabs. */
  async function deletePath(relative) {
    if (explorer.isRenaming())
      return;
    const affected = tabs.filter((tab) => names.isWithin(tab.path, relative));
    const unsaved = affected.filter((tab) => editor.isDirty(tab.path)).length;
    const result = await api.deleteProjectPath(relative, unsaved);
    if (!result.ok) {
      if (result.error)
        setEditorStatus(result.error, true);
      return;
    }
    if (affected.some((tab) => editor.recordingPath() === tab.path))
      await api.stopRecording();
    const index = tabs.findIndex((tab) => tab.path === activeTab);
    for (const tab of affected) {
      editor.close(tab.path);
      if (shownInEditor === tab.path)
        shownInEditor = null;
    }
    tabs = tabs.filter((tab) => !affected.includes(tab));
    if (names.isWithin(activeTab, relative)) {
      const previous = Math.min(Math.max(0, index - 1), tabs.length - 1);
      activeTab = tabs.length ? tabs[previous].path : RESULTS_TAB;
    }
    explorer.pathRemoved(relative);
    renderTabs();
    explorer.refresh();
    scheduleRecovery();
    setEditorStatus(`Moved ${relative} to the Recycle Bin`);
  }

  // Project Settings: after a save, reopen the project so every panel, the
  // watcher and the language worker use the new configuration.
  async function reopenProject() {
    if (!await closeAllTabs()) {
      setEditorStatus('Settings saved. Reopen the project to apply them.');
      return;
    }
    recoveryReady = false;
    $('#recovery-notice').hidden = true;
    const result = await api.openProject(currentRoot);
    if (!result.ok) {
      setEditorStatus(result.error, true);
      return;
    }
    window.dispatchEvent(new CustomEvent('keywright:project-closed'));
    showProject(result.project);
  }

  const projectSettings = window.RFProjectSettings.create({ api, root: () => currentRoot, reopen: reopenProject });
  const mcpDialog = window.RFMcpDialog.create({ api, openFile: (relative) => openFile(relative) });
  $('#project-settings').addEventListener('click', () => projectSettings.open());

  $('#project-close').addEventListener('click', async () => {
    if (!await closeAllTabs())
      return;
    recoveryReady = false;
    $('#recovery-notice').hidden = true;
    await api.closeProject();
    window.dispatchEvent(new CustomEvent('keywright:project-closed'));
    showWelcome();
  });

  // Files changed on disk (editor saves, Test Generator, other programs, git).
  async function refreshOpenFile(tab) {
    const revision = tab.revision;
    const version = editor.has(tab.path) ? editor.snapshot(tab.path).version : null;
    const file = await api.readProjectFile(tab.path).catch(() => null);
    if (!file || !tabs.includes(tab) || tab.revision !== revision || (editor.has(tab.path) && editor.snapshot(tab.path).version !== version))
      return;
    if (!editor.has(tab.path)) {
      // Not shown yet (a background tab after a folder rename, or one that could not be read):
      // it has no unsaved edits, so it takes the disk content as it is.
      Object.assign(tab, { content: file.content, reason: file.reason, revision: file.revision });
      if (tab.path === activeTab) {
        shownInEditor = null;
        renderTabs();
      }
      return;
    }
    if (file.content !== null && editor.reload(tab.path, file.content))
      Object.assign(tab, { content: file.content, revision: file.revision });
  }

  api.onFilesChanged(async (paths) => {
    for (const tab of tabs.filter((t) => paths.includes(t.path)))
      await refreshOpenFile(tab);
    if (paths.some((p) => /\.(robot|resource|py)$/i.test(p)))
      scheduleKeywords();
    explorer.refresh();
    window.dispatchEvent(new CustomEvent('keywright:files-changed', { detail: { paths } }));
  });

  // Requests from the Testing panel (tests.js).
  window.addEventListener('keywright:open-file', (event) => openFile(event.detail.path, event.detail.line, event.detail.column, event.detail.length));
  window.addEventListener('keywright:show-sidebar', (event) => showSidebar(event.detail.name));
  window.addEventListener('keywright:show-testing', () => showSidebar('testing'));
  window.addEventListener('keywright:status', (event) => setEditorStatus(event.detail.text));

  api.appVersion().then((version) => { $('#app-version').textContent = `Version ${version}`; });

  // Format Document needs Robocop in the project's virtual environment: offer to install it.
  window.addEventListener('keywright:format-failed', (event) => {
    const { error, missing } = event.detail;
    if (!missing) {
      setEditorStatus(`Could not format: ${error}`, true);
      return;
    }
    $('#format-notice-text').textContent = `${error} It formats .robot and .resource files (Shift+Alt+F).`;
    $('#format-install').hidden = false;
    $('#format-install').disabled = false;
    $('#format-install').textContent = 'Install Robocop';
    $('#format-notice').hidden = false;
  });

  $('#format-install').addEventListener('click', async () => {
    const button = $('#format-install');
    button.disabled = true;
    button.textContent = 'Installing…';
    const result = await api.installRobocop();
    if (!result.ok) {
      button.disabled = false;
      button.textContent = 'Install Robocop';
      $('#format-notice-text').textContent = `Could not install Robocop: ${result.error}`;
      return;
    }
    $('#format-notice').hidden = true;
    editor.formatDocument();
  });

  $('#format-dismiss').addEventListener('click', () => { $('#format-notice').hidden = true; });

  // Run glyphs and context menu of the editor: tests run from the saved file.
  editor.onRunTests(({ path, names }) => {
    window.dispatchEvent(new CustomEvent('keywright:run-from-editor', { detail: { path, names } }));
  });
  window.addEventListener('keywright:show-results', () => {
    if (activeTab !== RESULTS_TAB)
      activate(RESULTS_TAB);
  });

  window.addEventListener('keywright:file-saved', async (event) => {
    const detail = event.detail || {};
    if (!detail.fromEditor) {
      // Saved by the Test Generator: refresh open files that have no unsaved edits.
      for (const tab of tabs)
        await refreshOpenFile(tab);
    }
    if (!detail.path || /\.(robot|resource)$/i.test(detail.path))
      scheduleKeywords();
    explorer.refresh();
  });

  // -------------------------------------------------------------------------
  // Sidebar width (sidebarWidth.js)

  window.RFSidebarWidth.install();

  // -------------------------------------------------------------------------
  // Command palette: commands reuse the buttons and functions above, so they
  // behave exactly like the controls they stand for.

  const inProject = () => !$('#view-project').hidden;
  const fileTab = () => (inProject() && tabs.some((tab) => tab.path === activeTab) ? activeTab : null);
  const editorFile = () => fileTab() && editor.currentPath() === fileTab();
  const robotFile = () => editorFile() && editor.isRobotFile();
  const usable = (selector) => {
    const button = $(selector);
    return !!button && !button.hidden && !button.disabled;
  };
  const debugging = () => inProject() && !$('#debug-panel').hidden;

  function findInFiles() {
    showSidebar('search');
    $('#search-query').focus();
    $('#search-query').select();
  }

  function buttonCommand(id, category, label, selector, { keys, when = inProject, before } = {}) {
    return {
      id, category, label, keys,
      available: () => when() && usable(selector),
      run: () => {
        before?.();
        $(selector).click();
      },
    };
  }

  const editorAction = (id, label, action, keys, when = editorFile) =>
    ({ id, category: 'Editor', label, keys, available: when, run: () => editor.runAction(action) });

  const COMMANDS = [
    { id: 'file.goTo', category: 'File', label: 'Go to File…', keys: 'Ctrl+P', available: inProject, run: () => palette.open('files') },
    { id: 'file.save', category: 'File', label: 'Save', keys: 'Ctrl+S', available: fileTab, run: () => saveFile(activeTab) },
    { id: 'file.new', category: 'File', label: 'New File…', available: inProject, run: () => { showSidebar('explorer'); explorer.showNewFileInput(); } },
    { id: 'file.close', category: 'File', label: 'Close Editor', available: fileTab, run: () => closeTab(activeTab) },
    buttonCommand('file.reveal', 'File', 'Open Project Folder in File Manager', '#tree-reveal'),
    buttonCommand('file.refresh', 'File', 'Refresh Explorer', '#tree-refresh'),

    editorAction('editor.gotoLine', 'Go to Line…', 'editor.action.gotoLine', 'Ctrl+G'),
    editorAction('editor.outline', 'Go to Symbol in File…', 'editor.action.quickOutline', 'Ctrl+Shift+O'),
    editorAction('editor.nextProblem', 'Go to Next Problem', 'editor.action.marker.nextInFiles', 'F8'),
    { id: 'editor.format', category: 'Editor', label: 'Format Document', keys: 'Shift+Alt+F', available: robotFile, run: () => editor.formatDocument() },
    {
      id: 'editor.breakpoint', category: 'Editor', label: 'Toggle Breakpoint', keys: 'F9', available: robotFile,
      run: () => {
        const line = editor.cursorLine();
        if (line)
          editor.toggleBreakpoint(activeTab, line);
      },
    },
    editorAction('editor.runFile', 'Run Tests in File', 'keywright.runTestsInFile', null, robotFile),
    editorAction('editor.runAtCursor', 'Run Test at Cursor', 'keywright.runTestAtCursor', null, robotFile),

    { id: 'view.explorer', category: 'View', label: 'Show Explorer', available: inProject, run: () => showSidebar('explorer') },
    { id: 'view.search', category: 'View', label: 'Find in Files', keys: 'Ctrl+Shift+F', available: inProject, run: findInFiles },
    { id: 'view.testing', category: 'View', label: 'Show Testing', available: inProject, run: () => showSidebar('testing') },
    { id: 'view.problems', category: 'View', label: 'Show Problems', available: inProject, run: () => showSidebar('problems') },
    { id: 'view.sourceControl', category: 'View', label: 'Show Source Control', keys: 'Ctrl+Shift+G', available: inProject, run: () => showSidebar('source-control') },
    { id: 'git.history', category: 'Git', label: 'Show Git History', available: inProject,
      run: () => { showSidebar('source-control'); sourceControl.showHistory(); } },
    { id: 'git.fileHistory', category: 'Git', label: 'Show File History', available: fileTab,
      run: () => { showSidebar('source-control'); sourceControl.showHistory(fileTab()); } },
    { id: 'view.generator', category: 'View', label: 'Show Test Generator', available: inProject, run: () => activate(GENERATOR_TAB) },
    { id: 'view.results', category: 'View', label: 'Show Test Results', available: inProject, run: () => activate(RESULTS_TAB) },

    buttonCommand('testing.runAll', 'Testing', 'Run All Tests', '#tests-run-all'),
    buttonCommand('testing.stop', 'Testing', 'Stop Tests', '#tests-stop'),
    buttonCommand('testing.watch', 'Testing', 'Toggle Watch Mode', '#tests-watch'),
    buttonCommand('testing.reload', 'Testing', 'Reload Tests', '#tests-refresh'),

    buttonCommand('debug.continue', 'Debug', 'Continue', '#debug-continue', { keys: 'F5', when: debugging }),
    buttonCommand('debug.over', 'Debug', 'Step Over', '#debug-over', { keys: 'F10', when: debugging }),
    buttonCommand('debug.into', 'Debug', 'Step Into', '#debug-into', { keys: 'F11', when: debugging }),
    buttonCommand('debug.out', 'Debug', 'Step Out', '#debug-out', { keys: 'Shift+F11', when: debugging }),
    buttonCommand('debug.pause', 'Debug', 'Pause', '#debug-pause', { when: debugging }),
    buttonCommand('debug.stop', 'Debug', 'Stop Debugging', '#debug-stop', { when: debugging }),

    {
      id: 'recorder.record', category: 'Recorder', label: 'Record a New Test…', available: () => inProject() && usable('#record'),
      run: () => {
        activate(GENERATOR_TAB);
        $('#url').focus();
        $('#url').select();
      },
    },
    buttonCommand('recorder.pick', 'Recorder', 'Pick Locator', '#pick', { before: () => activate(GENERATOR_TAB) }),
    buttonCommand('recorder.recordAtCursor', 'Recorder', 'Record at Cursor', '#record-at-cursor', { when: editorFile }),
    buttonCommand('recorder.pickAtCursor', 'Recorder', 'Pick Locator at Cursor', '#pick-at-cursor', { when: editorFile }),

    buttonCommand('problems.refresh', 'Problems', 'Check All Files Again', '#problems-refresh', { before: () => showSidebar('problems') }),
    buttonCommand('project.reloadLibraries', 'Project', 'Reload Libraries', '#reload-libraries'),
    { id: 'project.settings', category: 'Project', label: 'Open Project Settings', available: inProject, run: () => projectSettings.open() },
    buttonCommand('project.close', 'Project', 'Close Project', '#project-close'),
    buttonCommand('project.new', 'Project', 'New Project…', '#welcome-new', { when: () => !$('#view-welcome').hidden }),
    buttonCommand('project.open', 'Project', 'Open Folder…', '#welcome-open', { when: () => !$('#view-welcome').hidden }),
    { id: 'ai.connection', category: 'AI', label: 'Open MCP Server', available: () => true, run: () => mcpDialog.open() },
    { id: 'help.crashReports', category: 'Help', label: 'Open Crash Reports Folder', available: () => true, run: () => api.openCrashReports() },
  ];

  async function paletteFiles() {
    if (!inProject())
      return null;
    const paths = [];
    const collect = (nodes) => {
      for (const node of nodes) {
        if (node.type === 'dir')
          collect(node.children || []);
        else
          paths.push(node.path);
      }
    };
    collect(await api.projectTree());
    // Open files first, in tab order; then the rest alphabetically.
    const open = tabs.map((tab) => tab.path).filter((path) => paths.includes(path));
    const rest = paths.filter((path) => !open.includes(path)).sort((a, b) => a.localeCompare(b));
    return [...open, ...rest];
  }

  const palette = window.RFCommandPalette.create({
    commands: () => COMMANDS.filter((command) => command.available()),
    files: paletteFiles,
    openFile: (path) => openFile(path),
  });

  // Captured, so the shortcuts also work while the code editor has the focus.
  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'p')
      return;
    // Not over the new-project form, a save conflict comparison or a dialog.
    if ((!inProject() && $('#view-welcome').hidden) || !$('#compare-view').hidden || $('#settings').open)
      return;
    event.preventDefault();
    event.stopPropagation();
    palette.open(event.shiftKey ? 'commands' : 'files');
  }, true);

  window.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || !event.shiftKey || event.altKey || event.key.toLowerCase() !== 'g')
      return;
    if (!inProject() || !$('#palette').hidden || !$('#compare-view').hidden || document.querySelector('dialog[open]'))
      return;
    event.preventDefault();
    event.stopPropagation();
    showSidebar('source-control');
    $('#sidebar-tab-source-control').focus();
  }, true);

  // -------------------------------------------------------------------------

  (async () => {
    const project = await api.currentProject();
    if (project)
      showProject(project);
    else
      showWelcome();
  })();
})();
