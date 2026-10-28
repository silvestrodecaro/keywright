'use strict';

// Application shell: welcome screen, project creation and the project view
// (explorer + tabs). The Test Generator tab lives in generator.js.
(function () {
  const $ = (selector) => document.querySelector(selector);
  const api = window.rfide;

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
  }

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

  function showProject(project) {
    showView('project');
    $('#project-name').textContent = project.name;
    $('#project-root').textContent = project.root;
    $('#python-status').textContent = project.python
      ? `Python: ${project.python}`
      : 'No project virtual environment (.venv) found';
    expanded.clear();
    expanded.add(project.config.testsDir);
    expanded.add(project.config.resourcesDir);
    tabs = [];
    currentConfig = project.config;
    activeTab = GENERATOR_TAB;
    $('#new-file').hidden = true;
    showSidebar('explorer');
    renderTabs();
    refreshTree();
    window.dispatchEvent(new CustomEvent('rfide:project-opened', { detail: project }));
    setEditorStatus('Loading keywords…');
    loadKeywords();
  }

  function showSidebar(name) {
    for (const button of document.querySelectorAll('.sidebar-tab'))
      button.classList.toggle('is-active', button.dataset.sidebar === name);
    for (const section of document.querySelectorAll('.sidebar-section'))
      section.hidden = section.id !== `sidebar-${name}`;
  }

  for (const button of document.querySelectorAll('.sidebar-tab'))
    button.addEventListener('click', () => showSidebar(button.dataset.sidebar));

  async function refreshTree() {
    const tree = await api.projectTree();
    $('#tree').replaceChildren(...tree.map((node) => renderNode(node, 0)));
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
    if (node.type === 'dir') {
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
      const file = await api.readProjectFile(relative);
      tab = { path: relative, content: file.content, reason: file.reason };
      tabs.push(tab);
    }
    tab.line = line;
    tab.column = column;
    tab.selectLength = length;
    shownInEditor = null; // force the editor to (re)show the file and reveal the line
    activate(relative);
  }

  async function saveFile(relative) {
    if (!editor.has(relative))
      return true;
    try {
      await api.writeProjectFile(relative, editor.getContent(relative));
    } catch (error) {
      setEditorStatus(`Could not save ${relative}: ${error.message}`, true);
      return false;
    }
    editor.markSaved(relative);
    setEditorStatus(`Saved ${relative}`);
    window.dispatchEvent(new CustomEvent('rfide:file-saved', { detail: { path: relative, fromEditor: true } }));
    return true;
  }

  /** Asks what to do with unsaved files; returns false when the user cancels. */
  async function resolveUnsaved(paths) {
    const dirty = paths.filter((path) => editor.isDirty(path));
    if (!dirty.length)
      return true;
    const choice = await api.confirmUnsaved(dirty.map((path) => path.split('/').pop()));
    if (choice === 'cancel')
      return false;
    if (choice === 'save')
      for (const path of dirty)
        if (!await saveFile(path))
          return false;
    return true;
  }

  async function closeTab(relative) {
    if (editor.recordingPath() === relative)
      await api.stopRecording();
    if (!await resolveUnsaved([relative]))
      return;
    const index = tabs.findIndex((t) => t.path === relative);
    tabs.splice(index, 1);
    editor.close(relative);
    if (shownInEditor === relative)
      shownInEditor = null;
    if (activeTab === relative)
      activeTab = tabs.length ? tabs[Math.max(0, index - 1)].path : RESULTS_TAB;
    renderTabs();
    refreshTree();
  }

  async function closeAllTabs() {
    if (!await resolveUnsaved(tabs.map((t) => t.path)))
      return false;
    for (const tab of tabs)
      editor.close(tab.path);
    tabs = [];
    shownInEditor = null;
    return true;
  }

  function activate(tabId) {
    activeTab = tabId;
    renderTabs();
    refreshTree();
  }

  function renderTabs() {
    const fixedTabs = FIXED_TABS.map((fixed) => {
      const button = el('button', {
        type: 'button',
        className: 'tab' + (activeTab === fixed.id ? ' is-active' : ''),
        textContent: fixed.label,
      });
      button.addEventListener('click', () => activate(fixed.id));
      return button;
    });

    const fileTabs = tabs.map((tab) => {
      const name = tab.path.split('/').pop();
      const dirty = editor.isDirty(tab.path);
      const button = el('button', {
        type: 'button',
        className: 'tab' + (activeTab === tab.path ? ' is-active' : '') + (dirty ? ' is-dirty' : ''),
        title: tab.path + (dirty ? ' (unsaved)' : ''),
      }, el('span', { textContent: name }));
      const close = el('span', { className: 'tab-close', title: dirty ? 'Unsaved changes' : 'Close' });
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
      return button;
    });
    $('#tabs').replaceChildren(...fixedTabs, ...fileTabs);

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
    window.dispatchEvent(new CustomEvent('rfide:keywords-loaded'));
    editor.revalidate();
    if (!result.ok) {
      setEditorStatus(result.error, true);
      return;
    }
    const problems = result.errors.map((e) => `${e.import || e.source}: ${e.error}`);
    setEditorStatus(`${result.keywords.length} keywords` + (problems.length ? ` · ${problems.length} import problem(s)` : ''), problems.length > 0);
    $('#editor-status').title = problems.join('\n');
  }

  function scheduleKeywords() {
    clearTimeout(keywordTimer);
    keywordTimer = setTimeout(loadKeywords, 500);
  }

  // -------------------------------------------------------------------------
  // New file

  function showNewFileInput() {
    const form = $('#new-file');
    form.hidden = false;
    const input = $('#new-file-name');
    input.value = `${currentConfig.testsDir}/`;
    showError($('#new-file-error'), '');
    input.focus();
  }

  $('#tree-new-file').addEventListener('click', showNewFileInput);
  $('#new-file').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('#new-file-name').value.trim();
    const result = await api.createProjectFile(name);
    if (!result.ok) {
      showError($('#new-file-error'), result.error);
      return;
    }
    $('#new-file').hidden = true;
    const folders = result.path.split('/').slice(0, -1);
    folders.forEach((_, i) => expanded.add(folders.slice(0, i + 1).join('/')));
    await refreshTree();
    openFile(result.path);
  });
  $('#new-file-name').addEventListener('keydown', (event) => {
    if (event.key === 'Escape')
      $('#new-file').hidden = true;
  });

  $('#tree-refresh').addEventListener('click', refreshTree);
  $('#tree-reveal').addEventListener('click', () => api.revealInExplorer(null));
  $('#project-close').addEventListener('click', async () => {
    if (!await closeAllTabs())
      return;
    await api.closeProject();
    window.dispatchEvent(new CustomEvent('rfide:project-closed'));
    showWelcome();
  });

  // Files changed on disk (editor saves, Test Generator, other programs, git).
  api.onFilesChanged(async (paths) => {
    for (const tab of tabs.filter((t) => paths.includes(t.path))) {
      const file = await api.readProjectFile(tab.path).catch(() => null);
      if (file && file.content !== null) {
        tab.content = file.content;
        editor.reload(tab.path, file.content); // ignored while the tab has unsaved edits
      }
    }
    if (paths.some((p) => /\.(robot|resource|py)$/i.test(p)))
      scheduleKeywords();
    refreshTree();
    window.dispatchEvent(new CustomEvent('rfide:files-changed', { detail: { paths } }));
  });

  // Requests from the Testing panel (tests.js).
  window.addEventListener('rfide:open-file', (event) => openFile(event.detail.path, event.detail.line, event.detail.column, event.detail.length));
  window.addEventListener('rfide:show-sidebar', (event) => showSidebar(event.detail.name));
  window.addEventListener('rfide:show-testing', () => showSidebar('testing'));
  window.addEventListener('rfide:status', (event) => setEditorStatus(event.detail.text));

  // Run glyphs and context menu of the editor: tests run from the saved file.
  editor.onRunTests(async ({ path, names }) => {
    const saved = editor.isDirty(path);
    if (saved && !await saveFile(path))
      return;
    window.dispatchEvent(new CustomEvent('rfide:run-from-editor', { detail: { path, names, saved } }));
  });
  window.addEventListener('rfide:show-results', () => {
    if (activeTab !== RESULTS_TAB)
      activate(RESULTS_TAB);
  });

  window.addEventListener('rfide:file-saved', async (event) => {
    const detail = event.detail || {};
    if (!detail.fromEditor) {
      // Saved by the Test Generator: refresh open files that have no unsaved edits.
      for (const tab of tabs) {
        const file = await api.readProjectFile(tab.path).catch(() => null);
        if (file && file.content !== null) {
          tab.content = file.content;
          editor.reload(tab.path, file.content);
        }
      }
    }
    if (!detail.path || /\.(robot|resource)$/i.test(detail.path))
      scheduleKeywords();
    refreshTree();
  });

  // -------------------------------------------------------------------------

  (async () => {
    const project = await api.currentProject();
    if (project)
      showProject(project);
    else
      showWelcome();
  })();
})();
