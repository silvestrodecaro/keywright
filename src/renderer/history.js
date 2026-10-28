'use strict';

// Run history (Test Results › History): past runs and, for the selected one, what
// changed since the run before it. Runs are recorded by the main process.
(function () {
  const $ = (selector) => document.querySelector(selector);
  const api = window.rfide;
  const diff = window.RFRunDiff;

  const STATUS_ICONS = { PASS: ['✓', 'status-pass'], FAIL: ['✕', 'status-fail'], SKIP: ['↷', 'status-skip'] };
  let runs = []; // newest first
  let selectedRun = null;
  let view = 'test';

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
    return node;
  }

  function icon(status) {
    const [text, className] = STATUS_ICONS[status] || ['○', 'status-none'];
    return el('span', { className: `status-icon ${className}`, textContent: text, title: status });
  }

  function seconds(value) {
    if (value == null)
      return '';
    return value < 1 ? `${Math.round(value * 1000)} ms` : value < 60 ? `${value.toFixed(1)} s` : `${Math.floor(value / 60)} min ${Math.round(value % 60)} s`;
  }

  function when(run) {
    return new Date(run.startedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function testName(id) {
    const dot = id.lastIndexOf('.');
    return { name: id.slice(dot + 1), suite: dot > 0 ? id.slice(0, dot) : '' };
  }

  /** Short labels for how a run was started: tags, dry run, debug, part of the tests, stopped. */
  function badges(run) {
    const o = run.options || {};
    return [
      o.select && o.select.length ? `${o.select.length} selected` : null,
      o.include && o.include.length ? `+${o.include.join(', ')}` : null,
      o.exclude && o.exclude.length ? `−${o.exclude.join(', ')}` : null,
      o.dryrun ? 'dry run' : null,
      o.debug ? 'debug' : null,
      run.stopped ? 'stopped' : null,
    ].filter(Boolean).map((text) => el('span', { className: 'tag', textContent: text }));
  }

  function countsRow(run) {
    const c = diff.counts(run);
    return el('span', { className: 'history-counts' },
      el('span', { className: 'status-pass', textContent: `✓ ${c.PASS}` }),
      el('span', { className: 'status-fail', textContent: `✕ ${c.FAIL}` }),
      c.SKIP ? el('span', { className: 'status-skip', textContent: `↷ ${c.SKIP}` }) : null);
  }

  function testRow(run, id, extra) {
    const test = run.tests[id];
    const { name, suite } = testName(id);
    const row = el('div', { className: 'history-test', title: id },
      icon(test.status),
      el('span', { className: 'history-test-name', textContent: name }),
      el('span', { className: 'muted history-test-suite', textContent: suite }),
      el('span', { className: 'row-time', textContent: extra || seconds(test.elapsed) }));
    const item = el('div', { className: 'history-test-item' }, row);
    if (test.status === 'FAIL' && test.message)
      item.append(el('div', { className: 'history-message', textContent: test.message }));
    row.addEventListener('click', () => window.dispatchEvent(new CustomEvent('rfide:select-test', { detail: { id } })));
    return item;
  }

  function section(title, className, rows) {
    if (!rows.length)
      return null;
    return el('section', { className: 'history-section' },
      el('h3', { className, textContent: `${title} (${rows.length})` }), ...rows);
  }

  function renderDetail() {
    const target = $('#history-detail');
    const index = runs.findIndex((run) => run.id === selectedRun);
    const run = runs[index];
    if (!run) {
      target.replaceChildren(el('div', { className: 'empty', textContent: 'No runs yet: the runs of this project are listed here.' }));
      return;
    }
    const previous = runs[index + 1] || null;
    const changes = diff.compareRuns(run, previous);
    const header = el('div', { className: 'history-header' },
      el('h2', { textContent: when(run) }),
      el('div', { className: 'results-meta muted', textContent: [seconds(run.duration), `${diff.counts(run).total} tests`,
        previous ? `compared with ${when(previous)}` : 'first run'].filter(Boolean).join(' · ') }),
      el('div', { className: 'results-tags' }, countsRow(run), ...badges(run)));
    const sections = [
      section('Newly failing', 'status-fail', changes.newFailures.map((id) => testRow(run, id))),
      section('Fixed', 'status-pass', changes.fixed.map((id) => testRow(run, id))),
      section('Still failing', 'status-fail', changes.stillFailing.map((id) => testRow(run, id))),
      section('Slower', 'status-skip', changes.slower.map(({ id, before, after }) => testRow(run, id, `${seconds(before)} → ${seconds(after)}`))),
      section('New tests', 'muted', changes.added.map((id) => testRow(run, id))),
    ].filter(Boolean);
    if (previous && !sections.length)
      sections.push(el('div', { className: 'empty', textContent: 'Nothing changed since the previous run.' }));
    const all = el('details', { className: 'history-section history-all' },
      el('summary', { textContent: `All tests of this run (${diff.counts(run).total})` }),
      ...Object.keys(run.tests).sort().map((id) => testRow(run, id)));
    target.replaceChildren(header, ...sections, all);
  }

  function render() {
    $('#history-count').textContent = runs.length ? `(${runs.length})` : '';
    $('#history-runs').replaceChildren(...runs.map((run, index) => {
      const changes = diff.compareRuns(run, runs[index + 1] || null);
      const item = el('li', { className: 'history-run' + (run.id === selectedRun ? ' is-active' : '') },
        el('div', { className: 'history-run-top' }, el('span', { textContent: when(run) }), el('span', { className: 'row-time', textContent: seconds(run.duration) })),
        el('div', { className: 'history-run-bottom' }, countsRow(run),
          changes.newFailures.length ? el('span', { className: 'status-fail', textContent: `▲ ${changes.newFailures.length} new` }) : null,
          changes.fixed.length ? el('span', { className: 'status-pass', textContent: `▼ ${changes.fixed.length} fixed` }) : null),
        el('div', { className: 'history-run-badges' }, ...badges(run)));
      item.addEventListener('click', () => {
        selectedRun = run.id;
        render();
      });
      return item;
    }));
    renderDetail();
  }

  function setView(name, anchor) {
    view = name;
    for (const button of document.querySelectorAll('.results-switch-btn'))
      button.classList.toggle('is-active', button.dataset.resultsView === name);
    $('#results-detail').hidden = name !== 'test';
    $('#results-history').hidden = name !== 'history';
    $('#results-output').hidden = name !== 'report' && name !== 'log';
    if (name === 'history')
      render();
    else if (name === 'report' || name === 'log')
      showOutput(`${name}.html`, anchor);
  }

  // Robot's report.html and log.html, served from the results folder (their links are relative).
  // anchor: Robot's id of an element (s1-s1-t1), which log.html opens.
  async function showOutput(file, anchor) {
    const frame = $('#output-frame');
    const result = await api.testOutputUrl(file);
    if (view !== file.replace('.html', ''))
      return; // switched view meanwhile
    $('#output-empty').hidden = result.ok;
    frame.hidden = !result.ok;
    $('#output-reload').disabled = !result.ok;
    $('#output-external').disabled = !result.ok;
    if (!result.ok) {
      $('#output-empty').textContent = result.error;
      $('#output-info').textContent = '';
      return;
    }
    $('#output-info').textContent = file;
    // A new query string forces a reload, also when only the anchor changes.
    frame.src = `${result.url}?t=${Date.now()}${anchor ? `#${anchor}` : ''}`;
  }

  $('#output-reload').addEventListener('click', () => showOutput(`${view}.html`));
  $('#output-external').addEventListener('click', () => api.openTestOutput(`${view}.html`));

  window.addEventListener('rfide:show-output', (event) => setView(event.detail.file.replace('.html', ''), event.detail.anchor));

  // A finished run writes new files: show them.
  api.onTestsFinished(() => {
    if (view === 'report' || view === 'log')
      setTimeout(() => showOutput(`${view}.html`), 300);
  });

  async function load() {
    runs = await api.testHistory();
    if (!runs.some((run) => run.id === selectedRun))
      selectedRun = runs[0] ? runs[0].id : null;
    render();
    window.dispatchEvent(new CustomEvent('rfide:history-changed'));
  }

  for (const button of document.querySelectorAll('.results-switch-btn'))
    button.addEventListener('click', () => setView(button.dataset.resultsView));

  api.onHistoryAdded((run) => {
    runs = [run, ...runs.filter((r) => r.id !== run.id)].slice(0, 30);
    selectedRun = run.id;
    render();
    window.dispatchEvent(new CustomEvent('rfide:history-changed'));
  });

  // Selecting a test shows its details; starting a run leaves the report and log, which it refreshes.
  window.addEventListener('rfide:show-results', (event) => {
    if (view !== 'test' && (view === 'history' || (event.detail && event.detail.test)))
      setView('test');
  });

  window.addEventListener('rfide:project-opened', () => {
    runs = [];
    selectedRun = null;
    setView('test');
    load();
  });

  window.RFHistory = { trend: (testId) => diff.trend(runs, testId) };
})();
