'use strict';

// Application shell: welcome screen, project creation and the project view
// (explorer + tabs). The Test Generator tab lives in generator.js.
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

    const result = await api.createProject({
      name,
      location: $('#create-location').value.trim(),
      createVenv: $('#opt-venv').checked,
      installBrowsers: $('#opt-browsers').checked,
      initGit: $('#opt-git').checked,
    });
    $('#create-submit').disabled = false;

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
  const FIXED_TABS = [
    { id: GENERATOR_TAB, label: '● Test Generator', pane: '#pane-generator' },
    { id: RESULTS_TAB, label: '▶ Test Results', pane: '#pane-results' },
  ];
  const expanded = new Set();
  let tabs = [];
  let activeTab = GENERATOR_TAB;
  let currentConfig = null;
  let currentRoot = null;

  function showProject(project) {
    showView('project');
    $('#project-name').textContent = project.name;
    $('#project-root').textContent = project.root;
    $('#project-root').title = project.root;
    $('#python-status').textContent = project.python
      ? `Python: ${project.python}`
      : 'No project virtual environment (.venv) found';
    expanded.clear();
    expanded.add(project.config.testsDir);
    expanded.add(project.config.resourcesDir);
    tabs = [];
    currentConfig = project.config;
    currentRoot = project.root;
    activeTab = GENERATOR_TAB;
    $('#new-file').hidden = true;
    showSidebar('explorer');
    renderTabs();
    refreshTree();
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
  }

  for (const button of document.querySelectorAll('.sidebar-tab'))
    button.addEventListener('click', () => showSidebar(button.dataset.sidebar));
  window.RFTree.bindTabs($('.sidebar-switch'));
  window.RFTree.bind($('#tree'));

  const treeNodes = new Map(); // path -> node of the rendered tree
  let renaming = null; // the path whose row shows the rename field

  async function refreshTree() {
    // Re-rendering would remove the rename field: refresh when renaming ends.
    if (renaming)
      return;
    const tree = await api.projectTree();
    if (renaming)
      return;
    treeNodes.clear();
    window.RFTree.replace($('#tree'), tree.map((node) => renderNode(node, 0)), activeTab);
  }

  function renderNode(node, depth) {
    const row = el('div', {
      className: `tree-row ${node.type === 'dir' ? 'is-dir' : 'is-file'}`,
      title: node.path,
    });
    row.style.paddingLeft = `${8 + depth * 14}px`;
    const isOpen = expanded.has(node.path);
    const icon = node.type === 'dir' ? (isOpen ? '▾' : '▸') : fileIcon(node.name);
    row.append(el('span', { className: 'tree-icon', textContent: icon }), el('span', { className: 'tree-label', textContent: node.name }));
    if (node.type === 'file' && tabs.some((t) => t.path === node.path) && activeTab === node.path)
      row.classList.add('is-active');

    const item = el('li', { role: 'treeitem' }, row);
    item.dataset.treeId = node.path;
    item.tabIndex = -1;
    treeNodes.set(node.path, node);
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      window.RFTree.focusItem($('#tree'), item);
      openExplorerMenu(node, event.clientX, event.clientY);
    });
    if (node.type === 'dir') {
      item.setAttribute('aria-expanded', String(isOpen));
      row.addEventListener('click', () => {
        if (expanded.has(node.path))
          expanded.delete(node.path);
        else
          expanded.add(node.path);
        refreshTree();
      });
      if (isOpen)
        item.append(el('ul', { role: 'group' }, ...node.children.map((child) => renderNode(child, depth + 1))));
    } else {
      row.addEventListener('click', () => openFile(node.path));
    }
    return item;
  }

  function fileIcon(name) {
    if (/\.robot$/i.test(name)) return '◆';
    if (/\.resource$/i.test(name)) return '◇';
    return '·';
  }

  // -------------------------------------------------------------------------
  // File tabs (Monaco editor, see editor/index.js)

  const editor = window.RFEditor;
  const workspace = new window.RFWorkspaceFiles.WorkspaceFiles({
    editor, api,
    getFile: (path) => tabs.find((tab) => tab.path === path),
    status: (text, error) => setEditorStatus(text, error),
    onSaved: (path) => window.dispatchEvent(new CustomEvent('keywright:file-saved', { detail: { path, fromEditor: true } })),
    compare: (request) => compareVersions(request),
  });
  window.RFWorkspace = workspace;

  /** Shows a conflicting file's disk and editor versions side by side until the user decides. */
  function compareVersions({ path, disk, mine }) {
    const view = $('#compare-view');
    const returnFocus = document.activeElement;
    $('#compare-title').textContent = `${path} changed on disk`;
    view.hidden = false;
    const comparison = editor.createComparison($('#compare-editor'), { path, disk, mine });
    return new Promise((resolve) => {
      const buttons = { '#compare-save': 'save', '#compare-reload': 'reload', '#compare-cancel': 'cancel' };
      const finish = (choice) => {
        const content = comparison.content();
        for (const selector of Object.keys(buttons))
          $(selector).onclick = null;
        view.onkeydown = null;
        comparison.dispose();
        view.hidden = true;
        returnFocus?.focus?.();
        resolve(choice === 'save' ? { choice, content } : { choice });
      };
      for (const [selector, choice] of Object.entries(buttons))
        $(selector).onclick = () => finish(choice);
      view.onkeydown = (event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          finish('cancel');
        }
      };
    });
  }
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
      const file = await workspace.read(relative);
      tab = { path: relative, content: file.content, reason: file.reason, revision: file.revision };
      tabs.push(tab);
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
    refreshTree();
    scheduleRecovery();
  }

  async function closeAllTabs() {
    if (!await resolveUnsaved(tabs.map((t) => t.path)))
      return false;
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
    refreshTree();
  }

  function renderTabs() {
    const focus = $('#tabs').contains(document.activeElement) ? document.activeElement.id : null;
    function semantics(button, id, pane) {
      button.id = id;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(button.classList.contains('is-active')));
      button.setAttribute('aria-controls', pane.slice(1));
      button.tabIndex = button.classList.contains('is-active') ? 0 : -1;
      if (button.tabIndex === 0) $(pane).setAttribute('aria-labelledby', id);
      return button;
    }
    const fixedTabs = FIXED_TABS.map((fixed) => {
      const button = el('button', {
        type: 'button',
        className: 'tab' + (activeTab === fixed.id ? ' is-active' : ''),
        textContent: fixed.label,
      });
      button.addEventListener('click', () => activate(fixed.id));
      return semantics(button, `tab-${fixed.id}`, fixed.pane);
    });

    const fileTabs = tabs.map((tab) => {
      const name = tab.path.split('/').pop();
      const dirty = editor.isDirty(tab.path);
      const button = el('button', {
        type: 'button',
        className: 'tab' + (activeTab === tab.path ? ' is-active' : '') + (dirty ? ' is-dirty' : ''),
        title: tab.path + (dirty ? ' (unsaved)' : ''),
      }, el('span', { textContent: name }));
      button.setAttribute('aria-label', name + (dirty ? ', unsaved changes' : ''));
      const close = el('span', { className: 'tab-close', title: 'Close (Delete when tab is focused)' });
      close.setAttribute('aria-hidden', 'true');
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        closeTab(tab.path);
      });
      button.append(close);
      button.addEventListener('click', () => activate(tab.path));
      button.addEventListener('auxclick', (event) => {
        if (event.button === 1)
          closeTab(tab.path);
      });
      return semantics(button, `tab-file-${encodeURIComponent(tab.path)}`, '#pane-file');
    });
    $('#tabs').replaceChildren(...fixedTabs, ...fileTabs);
    if (focus) {
      const target = document.getElementById(focus) || $('#tabs [aria-selected="true"]');
      target?.focus();
    }

    const file = tabs.find((t) => t.path === activeTab);
    for (const fixed of FIXED_TABS)
      $(fixed.pane).hidden = activeTab !== fixed.id;
    $('#pane-file').hidden = !file;
    if (!file)
      return;
    $('#file-path').textContent = file.path;
    const message = $('#file-message');
    message.hidden = file.content !== null;
    $('#editor').hidden = file.content === null;
    $('#pane-file .file-header-right').hidden = file.content === null;
    if (file.content === null) {
      message.textContent = file.reason;
      return;
    }
    if (shownInEditor !== file.path) {
      ensureEditor();
      editor.open(file.path, file.content, file.line, file.column, file.selectLength);
      file.line = null;
      shownInEditor = file.path;
    }
    renderProblems(editor.problems(file.path));
    renderRecordBar();
  }

  editor.onDirtyChange(() => renderTabs());

  // -------------------------------------------------------------------------
  // Record at cursor: browser steps recorded straight into the open file.
  // Uses the Test Generator's browser and viewport settings.

  let recorderBusy = false; // a recording (here or in the Test Generator) is running
  let recordingHere = false;
  let picking = false; // a locator is being picked (here or in the Test Generator)

  function viewportSetting() {
    const match = /^(\d+)x(\d+)$/.exec($('#viewport').value);
    return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
  }

  function renderRecordBar() {
    const file = tabs.find((t) => t.path === activeTab);
    const recordable = !!file && file.content !== null && /\.(robot|resource)$/i.test(file.path);
    $('#record-at-cursor').hidden = !recordable;
    $('#record-at-cursor').disabled = recorderBusy || picking;
    $('#pick-at-cursor').hidden = !recordable;
    $('#pick-at-cursor').disabled = recordingHere; // the editor is read-only while recording into it
    const bar = $('#record-bar');
    if (recordingHere) {
      bar.hidden = false;
      $('#record-url').hidden = true;
      $('#record-start').hidden = true;
      $('#record-cancel').hidden = true;
      $('#record-stop').hidden = false;
    } else {
      $('#record-url').hidden = false;
      $('#record-start').hidden = false;
      $('#record-start').disabled = recorderBusy;
      $('#record-cancel').hidden = false;
      $('#record-stop').hidden = true;
      if (!recordable)
        bar.hidden = true;
    }
  }

  $('#record-at-cursor').addEventListener('click', () => {
    showError($('#record-error'), '');
    $('#record-label').textContent = `Record into line ${editor.cursorLine() || 1}`;
    if (!$('#record-url').value)
      $('#record-url').value = $('#url').value;
    $('#record-bar').hidden = false;
    renderRecordBar();
    $('#record-url').focus();
  });

  $('#record-cancel').addEventListener('click', () => {
    $('#record-bar').hidden = true;
    editor.focus();
  });

  $('#record-bar').addEventListener('submit', async (event) => {
    event.preventDefault();
    const path = activeTab;
    if (recorderBusy || !editor.startRecording(path))
      return;
    showError($('#record-error'), '');
    recordingHere = true;
    $('#record-label').textContent = 'Launching browser…';
    renderRecordBar();
    const result = await api.startRecording({
      url: $('#record-url').value.trim(),
      browser: $('#browser').value,
      viewport: viewportSetting(),
    });
    if (result.ok)
      $('#record-label').textContent = `Recording into ${path.split('/').pop()}: interact with the browser, steps appear below`;
    else {
      editor.stopRecording();
      recordingHere = false;
      const hint = result.install ? ' Install it from the Test Generator tab.' : '';
      showError($('#record-error'), result.error + hint);
      $('#record-label').textContent = 'Record at cursor';
      renderRecordBar();
    }
  });

  $('#record-stop').addEventListener('click', () => api.stopRecording());

  // Pick locator: the selector of the clicked element is inserted at the cursor.
  // Uses the Test Generator's browser while it records, otherwise its settings.

  $('#pick-at-cursor').addEventListener('click', async () => {
    if (picking) {
      api.cancelPickLocator();
      return;
    }
    const path = activeTab;
    showError($('#record-error'), '');
    setEditorStatus('Click an element in the browser to insert its locator');
    const result = await api.pickLocator({
      url: $('#record-url').value.trim() || $('#url').value.trim(),
      browser: $('#browser').value,
      viewport: viewportSetting(),
    });
    if (!result.ok) {
      const hint = result.install ? ' Install it from the Test Generator tab.' : '';
      showError($('#record-error'), result.error + hint);
      setEditorStatus('Could not pick a locator', true);
    } else if (result.cancelled) {
      setEditorStatus('Pick cancelled');
    } else if (editor.currentPath() === path && editor.insertCell(result.cell)) {
      setEditorStatus(`Inserted ${result.selector}`);
    } else {
      await api.copyToClipboard(result.cell);
      setEditorStatus(`Copied ${result.selector} to the clipboard`);
    }
  });

  api.onPickState((state) => {
    picking = state.picking;
    const button = $('#pick-at-cursor');
    button.classList.toggle('is-picking', picking);
    button.textContent = picking ? '✕ Cancel pick' : '◎ Pick locator';
    renderRecordBar();
  });

  api.onCode(({ lines }) => {
    if (recordingHere)
      editor.updateRecording(lines);
  });

  api.onState((state) => {
    recorderBusy = state.recording;
    if (!state.recording && recordingHere) {
      recordingHere = false;
      const count = editor.stopRecording();
      $('#record-bar').hidden = true;
      setEditorStatus(count ? `Inserted ${count} recorded step${count === 1 ? '' : 's'}` : 'Nothing was recorded');
      editor.focus();
    }
    renderRecordBar();
  });
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
    if (event.key === 'Delete' && event.target.getAttribute('role') === 'tab' && tabs.some((tab) => tab.path === activeTab)) {
      event.preventDefault();
      closeTab(activeTab);
    }
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

  async function offerRecovery() {
    recoveryReady = false;
    // The last copy may predate a save made just before closing: skip what is already on disk.
    const entries = [];
    for (const entry of await api.readRecovery()) {
      const disk = await api.readProjectFile(entry.path).catch(() => null);
      if (!disk || disk.content !== entry.content)
        entries.push(entry);
    }
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
  // Keyword index for completion and hover

  let keywordTimer = null;

  function setEditorStatus(text, isError = false) {
    const status = $('#editor-status');
    status.textContent = text;
    status.classList.toggle('is-error', isError);
  }

  async function loadKeywords() {
    const result = await api.projectKeywords();
    // Unknown keywords are only reported when every imported library could be documented.
    const failedImports = (result.errors || []).filter((e) => e.import);
    editor.setKeywords(result.keywords || [], { complete: result.ok && failedImports.length === 0 });
    window.dispatchEvent(new CustomEvent('keywright:keywords-loaded'));
    editor.revalidate();
    if (!result.ok) {
      setEditorStatus(result.error, true);
      return;
    }
    const problems = result.errors.map((e) => `${e.import || e.source}: ${e.error}`);
    setEditorStatus(`${result.keywords.length} keywords` + (problems.length ? ` · ${problems.length} import problem(s)` : ''), problems.length > 0);
    $('#editor-status').title = problems.join('\n');
  }

  $('#reload-libraries').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    clearTimeout(keywordTimer);
    setEditorStatus('Reloading libraries…');
    try {
      await api.reloadLibraries();
      await loadKeywords();
    } finally {
      button.disabled = false;
    }
  });

  function scheduleKeywords() {
    clearTimeout(keywordTimer);
    keywordTimer = setTimeout(loadKeywords, 500);
  }

  // -------------------------------------------------------------------------
  // New file

  const names = window.RFFileNames;
  let newFileKindChosen = false; // the type was picked by hand, not suggested by the folder

  function showNewFileInput(folder = currentConfig.testsDir) {
    $('#new-file').hidden = false;
    const input = $('#new-file-name');
    input.value = folder ? `${folder}/` : '';
    newFileKindChosen = false;
    showError($('#new-file-error'), '');
    updateNewFileHint();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function hideNewFileInput() {
    const returnFocus = $('#new-file').contains(document.activeElement);
    $('#new-file').hidden = true;
    if (returnFocus)
      $('#tree [role="treeitem"][tabindex="0"]')?.focus();
  }

  /** A typed extension selects the type; without one the folder suggests it until the user picks. */
  function updateNewFileHint() {
    const name = $('#new-file-name').value.trim().replace(/\\/g, '/');
    const select = $('#new-file-type');
    const typed = names.kindOf(name);
    if (typed)
      select.value = typed;
    else if (!newFileKindChosen)
      select.value = names.defaultKind(names.parentOf(name), currentConfig);
    const target = names.withExtension(name, select.value);
    $('#new-file-hint').textContent = names.baseName(target) ? `Creates ${target}` : '';
  }

  $('#tree-new-file').addEventListener('click', () => showNewFileInput());
  $('#new-file-name').addEventListener('input', updateNewFileHint);
  $('#new-file-type').addEventListener('change', () => {
    newFileKindChosen = true;
    // Choosing another type replaces a .robot or .resource extension already typed.
    const input = $('#new-file-name');
    const kind = $('#new-file-type').value;
    const typed = names.kindOf(input.value.trim());
    if (typed && typed !== 'other' && typed !== kind)
      input.value = input.value.trim().replace(/\.[^./]+$/, names.EXTENSIONS[kind] || '');
    updateNewFileHint();
  });
  $('#new-file').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = names.withExtension($('#new-file-name').value, $('#new-file-type').value);
    const result = await api.createProjectFile(name);
    if (!result.ok) {
      showError($('#new-file-error'), result.error);
      return;
    }
    $('#new-file').hidden = true;
    expandTo(names.parentOf(result.path));
    await refreshTree();
    openFile(result.path);
  });
  $('#new-file').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      hideNewFileInput();
    }
  });

  function expandTo(folder) {
    const parts = folder ? folder.split('/') : [];
    parts.forEach((_, i) => expanded.add(parts.slice(0, i + 1).join('/')));
  }

  // -------------------------------------------------------------------------
  // Explorer: rename, delete and context menu

  function absolutePath(relative) {
    const separator = currentRoot.includes('\\') ? '\\' : '/';
    return currentRoot.replace(/[\\/]+$/, '') + separator + relative.split('/').join(separator);
  }

  async function copyText(text) {
    await api.copyToClipboard(text);
    setEditorStatus(`Copied ${text}`);
  }

  function explorerMenu(node) {
    if (!node) {
      return [
        { label: 'New File…', run: () => showNewFileInput() },
        { separator: true },
        { label: 'Open Project Folder in File Manager', run: () => api.revealInExplorer(null) },
        { label: 'Refresh Explorer', run: refreshTree },
      ];
    }
    const folder = node.type === 'dir' ? node.path : names.parentOf(node.path);
    return [
      ...(node.type === 'file' ? [{ label: 'Open', run: () => openFile(node.path) }] : []),
      { label: 'New File…', run: () => { expandTo(folder); refreshTree(); showNewFileInput(folder); } },
      { separator: true },
      { label: 'Rename…', keys: 'F2', run: () => startRename(node.path) },
      { label: 'Delete', keys: 'Del', run: () => deletePath(node.path) },
      { separator: true },
      { label: 'Copy Path', run: () => copyText(absolutePath(node.path)) },
      { label: 'Copy Relative Path', run: () => copyText(node.path) },
      { label: 'Reveal in File Manager', run: () => api.revealInExplorer(node.path) },
    ];
  }

  function openExplorerMenu(node, x, y) {
    if (renaming)
      return;
    window.RFContextMenu.open({ x, y, items: explorerMenu(node), label: node ? node.name : 'Explorer' });
  }

  // Right-click below the files: project-level actions.
  $('#tree').addEventListener('contextmenu', (event) => {
    if (event.defaultPrevented || event.target.closest('input'))
      return;
    event.preventDefault();
    openExplorerMenu(null, event.clientX, event.clientY);
  });

  $('#tree').addEventListener('keydown', (event) => {
    if (event.target.closest('input') || event.altKey || event.ctrlKey || event.metaKey)
      return;
    const item = event.target.closest('[role="treeitem"]');
    const node = item && treeNodes.get(item.dataset.treeId);
    if (!node)
      return;
    if (event.key === 'F2')
      startRename(node.path);
    else if (event.key === 'Delete')
      deletePath(node.path);
    else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      const box = item.firstElementChild.getBoundingClientRect();
      openExplorerMenu(node, box.left + 24, box.bottom);
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  });

  /** Replaces a row's label with a name field: Enter renames, Escape cancels. */
  function startRename(relative) {
    if (renaming)
      return;
    const item = [...$('#tree').querySelectorAll('[role="treeitem"]')].find((node) => node.dataset.treeId === relative);
    if (!item)
      return;
    const row = item.firstElementChild;
    const label = row.querySelector('.tree-label');
    const original = names.baseName(relative);
    const input = el('input', { className: 'tree-rename', type: 'text', value: original, spellcheck: false, autocomplete: 'off' });
    input.setAttribute('aria-label', `New name for ${original}`);
    const error = el('div', { className: 'error tree-rename-error', hidden: true });
    renaming = relative;
    row.classList.add('is-renaming');
    label.hidden = true;
    label.after(input);
    row.after(error);
    let busy = false;

    // Focus returns to the row unless the user moved it elsewhere (a blur).
    const finish = async (focusPath, keepFocus) => {
      const tree = $('#tree');
      renaming = null;
      tree.dataset.focusId = focusPath;
      await refreshTree();
      const next = [...tree.querySelectorAll('[role="treeitem"]')].find((node) => node.dataset.treeId === focusPath);
      if (keepFocus && next)
        window.RFTree.focusItem(tree, next);
    };
    const commit = async ({ fromBlur = false } = {}) => {
      if (busy || renaming !== relative)
        return;
      const name = input.value.trim();
      if (!name || name === original) {
        finish(relative, !fromBlur);
        return;
      }
      busy = true;
      const result = await renamePath(relative, name);
      busy = false;
      if (result.ok) {
        finish(result.path, !fromBlur);
      } else if (result.error && !fromBlur) {
        showError(error, result.error);
        input.focus();
      } else {
        if (result.error)
          setEditorStatus(`Could not rename ${original}: ${result.error}`, true);
        finish(relative, !fromBlur);
      }
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(relative, true);
      }
    });
    input.addEventListener('input', () => showError(error, ''));
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('blur', () => {
      if (!busy && renaming === relative)
        commit({ fromBlur: true });
    });
    input.focus();
    const dot = original.lastIndexOf('.');
    input.setSelectionRange(0, treeNodes.get(relative)?.type === 'file' && dot > 0 ? dot : original.length);
  }

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
    for (const path of [...expanded]) {
      if (names.isWithin(path, relative)) {
        expanded.delete(path);
        expanded.add(names.moved(path, relative, result.path));
      }
    }
    for (const tab of affected) {
      const next = names.moved(tab.path, relative, result.path);
      editor.close(tab.path);
      const file = await workspace.read(next);
      Object.assign(tab, { path: next, content: file.content, reason: file.reason, revision: file.revision, line: null });
    }
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
    if (renaming)
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
    for (const path of [...expanded]) {
      if (names.isWithin(path, relative))
        expanded.delete(path);
    }
    renderTabs();
    refreshTree();
    scheduleRecovery();
    setEditorStatus(`Moved ${relative} to the Recycle Bin`);
  }

  $('#tree-refresh').addEventListener('click', refreshTree);
  $('#tree-reveal').addEventListener('click', () => api.revealInExplorer(null));
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
    if (!tabs.includes(tab) || tab.revision !== revision || (editor.has(tab.path) && editor.snapshot(tab.path).version !== version))
      return;
    if (file && file.content !== null && editor.reload(tab.path, file.content))
      Object.assign(tab, { content: file.content, revision: file.revision });
  }

  api.onFilesChanged(async (paths) => {
    for (const tab of tabs.filter((t) => paths.includes(t.path)))
      await refreshOpenFile(tab);
    if (paths.some((p) => /\.(robot|resource|py)$/i.test(p)))
      scheduleKeywords();
    refreshTree();
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
    refreshTree();
  });

  // -------------------------------------------------------------------------
  // Sidebar width (drag its right edge; double-click resets it)

  const SIDEBAR_DEFAULT = 290;
  const SIDEBAR_MIN = 250;

  function setSidebarWidth(width) {
    const max = Math.max(SIDEBAR_MIN, Math.round(window.innerWidth * 0.6));
    width = Math.min(max, Math.max(SIDEBAR_MIN, Math.round(width)));
    document.documentElement.style.setProperty('--sidebar-width', width + 'px');
    return width;
  }

  function storeSidebarWidth(width) {
    try {
      localStorage.setItem('keywright.sidebarWidth', String(width));
    } catch {
      // not kept
    }
  }

  (() => {
    let stored = NaN;
    try {
      stored = Number(localStorage.getItem('keywright.sidebarWidth'));
    } catch {
      // default width
    }
    let width = setSidebarWidth(stored > 0 ? stored : SIDEBAR_DEFAULT);
    const resizer = $('#sidebar-resizer');
    resizer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0)
        return;
      event.preventDefault();
      // Captured, so the pointer is not lost over the trace viewer's or the report's iframe.
      resizer.setPointerCapture(event.pointerId);
      resizer.classList.add('is-dragging');
      const left = $('.sidebar').getBoundingClientRect().left;
      const move = (e) => { width = setSidebarWidth(e.clientX - left); };
      const end = () => {
        resizer.classList.remove('is-dragging');
        resizer.removeEventListener('pointermove', move);
        resizer.removeEventListener('pointerup', end);
        resizer.removeEventListener('pointercancel', end);
        storeSidebarWidth(width);
      };
      resizer.addEventListener('pointermove', move);
      resizer.addEventListener('pointerup', end);
      resizer.addEventListener('pointercancel', end);
    });
    resizer.addEventListener('dblclick', () => {
      width = setSidebarWidth(SIDEBAR_DEFAULT);
      storeSidebarWidth(width);
    });
    window.addEventListener('resize', () => setSidebarWidth(width));
  })();

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
    { id: 'file.new', category: 'File', label: 'New File…', available: inProject, run: () => { showSidebar('explorer'); showNewFileInput(); } },
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

  // -------------------------------------------------------------------------

  (async () => {
    const project = await api.currentProject();
    if (project)
      showProject(project);
    else
      showWelcome();
  })();
})();
