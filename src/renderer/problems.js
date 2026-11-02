'use strict';

// Problems panel: errors and warnings of every .robot/.resource file of the
// project, with the editor's checks (syntax, keywords, arguments, variables).
// Open files show their live problems, unsaved edits included.
(function () {
  const $ = (selector) => document.querySelector(selector);
  const api = window.rfide;
  const editor = window.RFEditor;
  const ROBOT_FILE = /\.(robot|resource)$/i;

  /** @type {Map<string, { severity: string, message: string, line: number, column: number }[]>} */
  let results = new Map();
  const collapsed = new Set();
  let projectOpen = false;
  let checking = false;
  let pending = false;
  let timer = null;

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((child) => child !== null && child !== undefined));
    return node;
  }

  function robotFiles(nodes) {
    return nodes.flatMap((node) => (node.type === 'dir' ? robotFiles(node.children || [])
      : ROBOT_FILE.test(node.path) ? [node.path] : []));
  }

  async function checkAll() {
    if (!projectOpen)
      return;
    if (checking) {
      pending = true;
      return;
    }
    checking = true;
    render();
    try {
      const paths = robotFiles(await api.projectTree());
      const found = await editor.projectProblems(paths);
      results = new Map(found.filter((r) => r.problems.length).map((r) => [r.path, r.problems]));
    } catch (error) {
      console.error('Problems check failed', error);
    } finally {
      checking = false;
      render();
    }
    if (pending) {
      pending = false;
      checkAll();
    }
  }

  function schedule(delay = 600) {
    clearTimeout(timer);
    timer = setTimeout(checkAll, delay);
  }

  function counts(problems) {
    return {
      errors: problems.filter((p) => p.severity === 'error').length,
      warnings: problems.filter((p) => p.severity === 'warning').length,
      infos: problems.filter((p) => p.severity === 'info').length,
    };
  }

  const ICONS = { error: ['✕', 'status-fail'], warning: ['⚠', 'problem-warning'], info: ['ℹ', 'problem-info'] };

  function countLabel({ errors, warnings, infos }) {
    return el('span', { className: 'problem-counts' },
      errors ? el('span', { className: 'status-fail', textContent: `✕ ${errors}` }) : null,
      warnings ? el('span', { className: 'problem-warning', textContent: `⚠ ${warnings}` }) : null,
      infos ? el('span', { className: 'problem-info', textContent: `ℹ ${infos}` }) : null);
  }

  function renderFile(path, problems) {
    const open = !collapsed.has(path);
    const slash = path.lastIndexOf('/');
    const row = el('div', { className: 'tree-row problem-file', title: path },
      el('span', { className: 'tree-icon', textContent: open ? '▾' : '▸' }),
      el('span', { className: 'tree-label', textContent: path.slice(slash + 1) }),
      el('span', { className: 'problem-dir muted', textContent: slash > 0 ? path.slice(0, slash) : '' }),
      countLabel(counts(problems)));
    row.addEventListener('click', () => {
      if (open)
        collapsed.add(path);
      else
        collapsed.delete(path);
      render();
    });
    const item = el('li', {}, row);
    if (open) {
      for (const problem of problems) {
        const [icon, iconClass] = ICONS[problem.severity] || ICONS.warning;
        const entry = el('div', { className: 'tree-row problem-row', title: problem.code ? `${problem.message} (${problem.code})` : problem.message },
          el('span', { className: iconClass, textContent: icon }),
          el('span', { className: 'problem-message', textContent: problem.message }),
          el('span', { className: 'problem-position muted', textContent: `${problem.line}:${problem.column}` }));
        entry.addEventListener('click', () => window.dispatchEvent(new CustomEvent('rfide:open-file',
          { detail: { path, line: problem.line, column: problem.column } })));
        item.append(entry);
      }
    }
    return item;
  }

  function render() {
    const all = [...results.values()].flat();
    const total = counts(all);
    const badge = $('#problems-badge'); // errors and warnings: infos (Robocop) are only listed
    badge.hidden = total.errors + total.warnings === 0;
    badge.textContent = String(total.errors + total.warnings);
    badge.classList.toggle('has-errors', total.errors > 0);

    const summary = $('#problems-summary');
    if (checking)
      summary.textContent = 'Checking…';
    else if (!all.length)
      summary.textContent = 'No problems';
    else
      summary.replaceChildren(countLabel(total), el('span', { className: 'muted', textContent: ` in ${results.size} file${results.size === 1 ? '' : 's'}` }));

    const list = $('#problems-list');
    if (!all.length) {
      list.replaceChildren(el('li', { className: 'empty', textContent: !projectOpen ? '' : checking ? 'Checking the project files…'
        : 'No problems in the .robot and .resource files.' }));
      return;
    }
    list.replaceChildren(...[...results.keys()].sort().map((path) => renderFile(path, results.get(path))));
  }

  // Open files: their markers change while typing.
  editor.onProblems(async (path) => {
    if (!projectOpen || !ROBOT_FILE.test(path))
      return;
    const [result] = await editor.projectProblems([path]);
    if (!result)
      return;
    if (result.problems.length)
      results.set(path, result.problems);
    else
      results.delete(path);
    render();
  });

  window.addEventListener('rfide:project-opened', () => {
    projectOpen = true;
    results = new Map();
    collapsed.clear();
    render(); // the first check runs when the keywords are loaded
  });
  window.addEventListener('rfide:keywords-loaded', () => schedule(0));

  // Robocop lint: on by default, remembered in this browser profile.
  let lintEnabled = true;
  try {
    lintEnabled = localStorage.getItem('rfide.lint') !== 'off';
  } catch {
    // storage unavailable
  }
  $('#problems-robocop').checked = lintEnabled;
  editor.setLintEnabled(lintEnabled);
  $('#problems-robocop').addEventListener('change', (event) => {
    try {
      localStorage.setItem('rfide.lint', event.target.checked ? 'on' : 'off');
    } catch {
      // storage unavailable
    }
    $('#problems-robocop-missing').hidden = true;
    editor.setLintEnabled(event.target.checked);
    schedule(300);
  });
  window.addEventListener('rfide:lint-unavailable', () => { $('#problems-robocop-missing').hidden = false; });
  $('#problems-robocop-install').addEventListener('click', async () => {
    const button = $('#problems-robocop-install');
    button.disabled = true;
    button.textContent = 'Installing…';
    const result = await api.installRobocop();
    button.disabled = false;
    button.textContent = 'Install';
    if (!result.ok) {
      $('#problems-robocop-missing span').textContent = `Could not install Robocop: ${result.error}`;
      return;
    }
    $('#problems-robocop-missing').hidden = true;
    editor.setLintEnabled(true);
    schedule(300);
  });
  window.addEventListener('rfide:files-changed', () => schedule());
  window.addEventListener('rfide:file-saved', () => schedule());
  $('#problems-refresh').addEventListener('click', checkAll);

  render();
})();
