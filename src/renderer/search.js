'use strict';

// Search panel (Ctrl+Shift+F): search and replace in the project's files.
// Open files are searched and replaced in the editor (unsaved edits count and
// replacements can be undone); the other files on disk by the main process.
(function () {
  const $ = (selector) => document.querySelector(selector);
  const api = window.rfide;
  const editor = window.RFEditor;
  const core = window.RFSearch;

  const toggles = { caseSensitive: '#search-case', wholeWord: '#search-word', regex: '#search-regex' };
  const flags = { caseSensitive: false, wholeWord: false, regex: false };
  let results = []; // [{ path, matches }]
  let truncated = false;
  let error = '';
  let searching = false;
  let sequence = 0;
  let timer = null;
  let confirmAll = false;
  const collapsed = new Set();

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((child) => child !== null && child !== undefined));
    return node;
  }

  function options() {
    const replacement = $('#search-replace').value;
    return {
      query: $('#search-query').value,
      ...flags,
      include: $('#search-include').value,
      replacement: replacement === '' ? undefined : replacement, // preview only when there is a replacement
    };
  }

  function isVisible() {
    return !$('#sidebar-search').hidden;
  }

  async function search() {
    const opts = options();
    const id = ++sequence;
    confirmAll = false;
    if (!opts.query) {
      results = [];
      error = '';
      searching = false;
      render();
      return;
    }
    let re;
    try {
      re = core.buildRegex(opts);
    } catch (e) {
      results = [];
      error = `Invalid regular expression: ${e.message}`;
      render();
      return;
    }
    searching = true;
    render();
    const include = core.includeFilter(opts.include);
    const open = editor.openPaths();
    const local = open.filter(include)
      .map((path) => ({ path, matches: core.findInText(editor.getContent(path) || '', re, { replacement: opts.replacement, regex: opts.regex }) }))
      .filter((file) => file.matches.length);
    const remote = await api.searchProject(opts, open);
    if (id !== sequence)
      return; // a newer search started meanwhile
    searching = false;
    error = remote.ok ? '' : remote.error;
    truncated = remote.ok && remote.truncated;
    results = [...local, ...(remote.ok ? remote.files : [])].sort((a, b) => a.path.localeCompare(b.path));
    render();
  }

  function schedule(delay = 250) {
    clearTimeout(timer);
    timer = setTimeout(search, delay);
  }

  function status(text) {
    window.dispatchEvent(new CustomEvent('rfide:status', { detail: { text } }));
  }

  /**
   * Replaces matches: in the editor for open files, on disk for the others.
   * @param {{ path: string, matches: object[] }[]} files
   * @param {boolean} all every match of each file (otherwise only the given ones)
   */
  async function replace(files, all) {
    const opts = { ...options(), replacement: $('#search-replace').value };
    const re = core.buildRegex(opts);
    const open = new Set(editor.openPaths());
    let count = 0;
    const onDisk = [];
    for (const file of files) {
      if (open.has(file.path)) {
        // Found again on the current content, so positions are right.
        let matches = core.findInText(editor.getContent(file.path) || '', re, { replacement: opts.replacement, regex: opts.regex });
        if (!all)
          matches = matches.filter((m) => file.matches.some((f) => f.line === m.line && f.column === m.column));
        count += editor.replaceMatches(file.path, matches);
      } else {
        onDisk.push({ path: file.path, at: all ? undefined : file.matches.map((m) => ({ line: m.line, column: m.column })) });
      }
    }
    if (onDisk.length) {
      const result = await api.replaceInProject(opts, opts.replacement, onDisk);
      if (!result.ok) {
        error = result.error;
        render();
        return;
      }
      count += result.count;
    }
    const fileCount = files.length;
    status(`Replaced ${count} match${count === 1 ? '' : 'es'} in ${fileCount} file${fileCount === 1 ? '' : 's'}`
      + (files.some((f) => open.has(f.path)) ? '; open files have unsaved changes' : ''));
    search();
  }

  function matchRow(file, match, replacing) {
    const before = match.preview.slice(0, match.previewStart).replace(/^\s+/, '');
    const text = match.preview.substr(match.previewStart, match.length);
    const after = match.preview.slice(match.previewStart + match.length);
    const row = el('div', { className: 'tree-row search-match', title: `${file.path}:${match.line}:${match.column}` },
      el('span', { className: 'search-preview' },
        before,
        el(replacing ? 'del' : 'mark', { textContent: text }),
        replacing ? el('ins', { textContent: match.replacement }) : null,
        after),
      el('span', { className: 'search-line muted', textContent: String(match.line) }));
    if (replacing) {
      const button = el('button', { type: 'button', className: 'icon-btn search-action', title: 'Replace', textContent: '↻' });
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        replace([{ path: file.path, matches: [match] }], false);
      });
      row.append(button);
    }
    row.addEventListener('click', () => window.dispatchEvent(new CustomEvent('rfide:open-file',
      { detail: { path: file.path, line: match.line, column: match.column, length: match.length } })));
    return row;
  }

  function fileRow(file, replacing) {
    const open = !collapsed.has(file.path);
    const slash = file.path.lastIndexOf('/');
    const row = el('div', { className: 'tree-row search-file', title: file.path },
      el('span', { className: 'tree-icon', textContent: open ? '▾' : '▸' }),
      el('span', { className: 'tree-label', textContent: file.path.slice(slash + 1) }),
      el('span', { className: 'problem-dir muted', textContent: slash > 0 ? file.path.slice(0, slash) : '' }),
      el('span', { className: 'badge search-count', textContent: String(file.matches.length) }));
    if (replacing) {
      const button = el('button', { type: 'button', className: 'icon-btn search-action', title: 'Replace in this file', textContent: '↻' });
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        replace([file], true);
      });
      row.append(button);
    }
    row.addEventListener('click', () => {
      if (open)
        collapsed.add(file.path);
      else
        collapsed.delete(file.path);
      render();
    });
    const item = el('li', {}, row);
    if (open)
      item.append(...file.matches.map((match) => matchRow(file, match, replacing)));
    return item;
  }

  function render() {
    for (const [flag, selector] of Object.entries(toggles)) {
      $(selector).classList.toggle('is-active', flags[flag]);
      $(selector).setAttribute('aria-pressed', String(flags[flag]));
    }
    const total = results.reduce((sum, file) => sum + file.matches.length, 0);
    const replacing = $('#search-replace').value !== '';
    const button = $('#search-replace-all');
    button.disabled = !total;
    button.textContent = confirmAll ? `Replace ${total}?` : 'Replace all';
    button.classList.toggle('btn-primary', confirmAll);
    const summary = $('#search-summary');
    summary.classList.toggle('is-error', !!error);
    summary.textContent = error || (searching ? 'Searching…' : !$('#search-query').value ? ''
      : !total ? 'No results.' : `${total} result${total === 1 ? '' : 's'} in ${results.length} file${results.length === 1 ? '' : 's'}`
        + (truncated ? ' (first 5000 shown)' : ''));
    $('#search-results').replaceChildren(...results.map((file) => fileRow(file, replacing)));
  }

  for (const [flag, selector] of Object.entries(toggles)) {
    $(selector).addEventListener('click', () => {
      flags[flag] = !flags[flag];
      schedule(0);
    });
  }
  $('#search-query').addEventListener('input', () => schedule());
  $('#search-replace').addEventListener('input', () => schedule());
  $('#search-include').addEventListener('input', () => schedule());
  $('#search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    schedule(0);
  });
  $('#search-replace-all').addEventListener('click', () => {
    if (!confirmAll) { // second click confirms
      confirmAll = true;
      render();
      return;
    }
    confirmAll = false;
    replace(results, true);
  });

  // Ctrl+Shift+F: open the panel, with the editor's selection as the query.
  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== 'f')
      return;
    event.preventDefault();
    event.stopPropagation();
    window.dispatchEvent(new CustomEvent('rfide:show-sidebar', { detail: { name: 'search' } }));
    const selected = editor.selectedText();
    if (selected && !selected.includes('\n')) {
      $('#search-query').value = selected;
      schedule(0);
    }
    $('#search-query').focus();
    $('#search-query').select();
  }, true);

  // Keep results fresh when files change (on disk or in the editor).
  window.addEventListener('rfide:files-changed', () => {
    if ($('#search-query').value)
      schedule(400);
  });
  editor.onDirtyChange(() => {
    if ($('#search-query').value && isVisible())
      schedule(400);
  });
  window.addEventListener('rfide:project-opened', () => {
    results = [];
    error = '';
    collapsed.clear();
    $('#search-query').value = '';
    $('#search-replace').value = '';
    render();
  });

  render();
})();
