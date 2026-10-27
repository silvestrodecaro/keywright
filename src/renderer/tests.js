'use strict';

// Testing panel (UI mode): test tree, run controls and the Test Results tab.
// Suites and tests are identified by their Robot full name.
(function () {
  const $ = (selector) => document.querySelector(selector);
  const api = window.rfide;

  const STATUS_ICONS = { PASS: '✓', FAIL: '✕', SKIP: '↷', 'NOT RUN': '○', running: '◌', queued: '○', stopped: '■' };
  const MAX_OUTPUT = 500_000;

  let rootSuite = null;
  /** @type {Map<string, { test: object, suites: object[] }>} */
  let testIndex = new Map();
  /** @type {Map<string, { status: string, message?: string, elapsed?: number }>} */
  const results = new Map();
  /** @type {Map<string, { steps: Map<string, object>, roots: object[], logs: object[] }>} */
  const runs = new Map();
  const collapsedSuites = new Set();
  const stepToggles = new Map(); // `${test}|${step}` -> expanded (overrides the default)
  let selected = null;
  let running = false;
  let filter = '';
  let output = '';
  // Watch mode: ids of watched tests/suites, or everything.
  const watched = new Set();
  let watchAll = false;
  const pendingChanges = new Set(); // changed paths waiting for the current run to end
  // Playwright traces recorded by the Browser library: test or suite id -> trace file.
  const traces = new Map();
  let traceView = null; // { testId, url } while the trace viewer is shown

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
    return node;
  }

  function statusClass(status) {
    return 'status-' + String(status || 'none').toLowerCase().replace(/\s+/g, '-');
  }

  function statusIcon(status) {
    return el('span', { className: `status-icon ${statusClass(status)}`, textContent: STATUS_ICONS[status] || '○', title: status || 'Not run' });
  }

  function formatElapsed(seconds) {
    if (seconds === null || seconds === undefined)
      return '';
    return seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
  }

  function showError(message) {
    const box = $('#tests-error');
    box.textContent = message || '';
    box.hidden = !message;
  }

  // -------------------------------------------------------------------------
  // Rendering (batched: listener events can arrive by the hundreds)

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued)
      return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderTree();
      renderSummary();
      renderDetail();
      renderControls();
    });
  }

  function testMatches(test) {
    if (!filter)
      return true;
    const needle = filter.toLowerCase();
    return test.name.toLowerCase().includes(needle) || test.tags.some((tag) => tag.toLowerCase().includes(needle));
  }

  function visibleTests(suite = rootSuite) {
    if (!suite)
      return [];
    return [...suite.tests.filter(testMatches), ...suite.suites.flatMap((child) => visibleTests(child))];
  }

  function suiteStatus(suite) {
    const statuses = visibleTests(suite).map((test) => results.get(test.id)?.status);
    if (statuses.some((s) => s === 'running' || s === 'queued'))
      return 'running';
    if (statuses.some((s) => s === 'FAIL'))
      return 'FAIL';
    if (statuses.length && statuses.every((s) => s === 'PASS' || s === 'SKIP'))
      return statuses.every((s) => s === 'SKIP') ? 'SKIP' : 'PASS';
    return null;
  }

  function runButton(title, select) {
    const button = el('button', { type: 'button', className: 'icon-btn row-run', title, textContent: '▶' });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      run(select);
    });
    button.disabled = running;
    return button;
  }

  function isWatched(id, suites = []) {
    return watchAll || watched.has(id) || suites.some((suite) => watched.has(suite.id));
  }

  function watchButton(id, name) {
    const active = watchAll || watched.has(id);
    const button = el('button', {
      type: 'button',
      className: 'icon-btn row-watch' + (active ? ' is-active' : ''),
      title: watchAll ? 'Watching all tests' : active ? `Stop watching ${name}` : `Watch ${name}: re-run on file changes`,
      textContent: '◉',
    });
    button.disabled = watchAll;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (watched.has(id))
        watched.delete(id);
      else
        watched.add(id);
      scheduleRender();
    });
    return button;
  }

  function renderSuite(suite, depth) {
    const tests = visibleTests(suite);
    if (tests.length === 0)
      return null;
    const isRoot = depth === 0;
    const collapsed = collapsedSuites.has(suite.id);
    const row = el('div', { className: 'tree-row test-row is-suite', title: suite.source || suite.name },
      el('span', { className: 'tree-icon', textContent: collapsed ? '▸' : '▾' }),
      statusIcon(suiteStatus(suite)),
      el('span', { className: 'tree-label', textContent: suite.name }),
      runButton(`Run ${suite.name}`, isRoot && !filter ? [] : (filter ? tests.map((t) => t.id) : [suite.id])),
      watchButton(suite.id, suite.name));
    row.style.paddingLeft = `${6 + depth * 12}px`;
    row.addEventListener('click', () => {
      if (collapsed)
        collapsedSuites.delete(suite.id);
      else
        collapsedSuites.add(suite.id);
      scheduleRender();
    });
    const item = el('li', { role: 'treeitem' }, row);
    if (!collapsed) {
      const children = [
        ...suite.suites.map((child) => renderSuite(child, depth + 1)),
        ...suite.tests.filter(testMatches).map((test) => renderTest(test, depth + 1)),
      ].filter(Boolean);
      item.append(el('ul', { role: 'group' }, ...children));
    }
    return item;
  }

  function renderTest(test, depth) {
    const result = results.get(test.id);
    const row = el('div', { className: 'tree-row test-row is-test' + (selected === test.id ? ' is-active' : ''), title: test.id },
      el('span', { className: 'tree-icon' }),
      statusIcon(result?.status),
      el('span', { className: 'tree-label', textContent: test.name }),
      result?.elapsed !== undefined ? el('span', { className: 'row-time', textContent: formatElapsed(result.elapsed) }) : null,
      runButton(`Run ${test.name}`, [test.id]),
      watchButton(test.id, test.name));
    if (isWatched(test.id, testIndex.get(test.id)?.suites))
      row.classList.add('is-watched');
    row.style.paddingLeft = `${6 + depth * 12}px`;
    row.addEventListener('click', () => select(test.id));
    row.addEventListener('dblclick', () => goToSource(test.id));
    return el('li', { role: 'treeitem' }, row);
  }

  function renderTree() {
    const tree = $('#test-tree');
    if (!rootSuite) {
      tree.replaceChildren();
      return;
    }
    const scroll = tree.scrollTop;
    const node = renderSuite(rootSuite, 0);
    tree.replaceChildren(...(node ? [node] : [el('li', { className: 'empty', textContent: filter ? 'No tests match the filter.' : 'No tests found.' })]));
    tree.scrollTop = scroll;
  }

  function renderSummary() {
    const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
    for (const test of visibleTests())
      if (results.get(test.id)?.status in counts)
        counts[results.get(test.id).status]++;
    const total = visibleTests().length;
    const summary = [
      el('span', { className: 'status-pass', textContent: `✓ ${counts.PASS}` }),
      el('span', { className: 'status-fail', textContent: `✕ ${counts.FAIL}` }),
      el('span', { className: 'status-skip', textContent: `↷ ${counts.SKIP}` }),
      el('span', { className: 'muted', textContent: `${total} test${total === 1 ? '' : 's'}` }),
    ];
    if (running)
      summary.push(el('span', { className: 'status-running', textContent: 'running…' }));
    const watching = visibleTests().filter((t) => isWatched(t.id, testIndex.get(t.id).suites)).length;
    if (watching)
      summary.push(el('span', { className: 'status-watching', textContent: `◉ watching ${watching}`, title: 'Watched tests re-run when files change' }));
    $('#tests-summary').replaceChildren(...summary);
  }

  function renderControls() {
    $('#tests-run-all').disabled = running || !rootSuite;
    $('#tests-run-all').textContent = filter ? '▶ Run visible' : '▶ Run all';
    $('#tests-stop').disabled = !running;
    $('#tests-refresh').disabled = running;
    $('#tests-watch').classList.toggle('is-active', watchAll);
    $('#tests-watch').title = watchAll ? 'Stop watching all tests' : 'Watch all tests: re-run them when files change';
  }

  // -------------------------------------------------------------------------
  // Test details

  function stepExpanded(testId, step) {
    const key = `${testId}|${step.id}`;
    if (stepToggles.has(key))
      return stepToggles.get(key);
    return step.status === 'FAIL' || step.status === 'running';
  }

  function stepLabel(step) {
    const parts = [];
    if (step.kind === 'setup' || step.kind === 'teardown')
      parts.push(el('span', { className: 'step-badge', textContent: step.kind.toUpperCase() }));
    if (step.assign && step.assign.length)
      parts.push(el('span', { className: 'tok-var', textContent: step.assign.join('    ') + '=' }));
    const isKeyword = ['keyword', 'setup', 'teardown'].includes(step.kind);
    parts.push(el('span', { className: isKeyword ? 'tok-keyword' : 'tok-section', textContent: step.name }));
    for (const arg of step.args || [])
      parts.push(el('span', { className: 'tok-arg', textContent: arg }));
    return parts;
  }

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  // HTML log messages are shown as text: rendering them would run untrusted markup.
  function stripHtml(html) {
    return html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (entity, name) => {
        if (name[0] === '#')
          return String.fromCodePoint(name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
        return ENTITIES[name.toLowerCase()] ?? entity;
      })
      .replace(/\s+/g, ' ')
      .trim();
  }

  function renderLog(log) {
    const text = log.html ? stripHtml(log.text) : log.text;
    return el('div', { className: `log log-${log.level.toLowerCase()}` },
      el('span', { className: 'log-level', textContent: log.level }),
      el('div', { className: 'log-content' },
        text ? el('div', { className: 'log-text', textContent: text }) : null,
        ...(log.images || []).map((src) => el('img', { className: 'log-image', src, alt: 'Screenshot', loading: 'lazy' }))));
  }

  function renderStep(testId, step, depth) {
    const hasBody = step.children.length > 0 || step.logs.length > 0;
    const expanded = hasBody && stepExpanded(testId, step);
    const row = el('div', { className: 'step-row' + (step.status === 'FAIL' ? ' is-failed' : '') },
      el('span', { className: 'tree-icon', textContent: hasBody ? (expanded ? '▾' : '▸') : '' }),
      statusIcon(step.status),
      el('span', { className: 'step-call' }, ...stepLabel(step)),
      el('span', { className: 'row-time', textContent: formatElapsed(step.elapsed) }));
    row.style.paddingLeft = `${8 + depth * 16}px`;
    if (hasBody) {
      row.addEventListener('click', () => {
        stepToggles.set(`${testId}|${step.id}`, !expanded);
        scheduleRender();
      });
    }
    const item = el('div', { className: 'step-item' }, row);
    if (expanded) {
      const body = el('div', { className: 'step-body' });
      body.style.paddingLeft = `${30 + depth * 16}px`;
      body.append(...step.logs.map(renderLog));
      if (step.status === 'FAIL' && step.message && step.children.length === 0 && !step.logs.some((l) => l.level === 'FAIL'))
        body.append(renderLog({ level: 'FAIL', text: step.message }));
      item.append(body, ...step.children.map((child) => renderStep(testId, child, depth + 1)));
    }
    return item;
  }

  function allImages(runData) {
    const images = [];
    const visit = (logs) => logs.forEach((log) => images.push(...(log.images || [])));
    visit(runData.logs);
    for (const step of runData.steps.values())
      visit(step.logs);
    return images;
  }

  /** The trace of a test: its own, or the one of the closest suite (context created in a suite setup). */
  function traceFor(testId) {
    const entry = testIndex.get(testId);
    if (traces.has(testId))
      return traces.get(testId);
    if (!entry)
      return null;
    const suite = [...entry.suites].reverse().find((s) => traces.has(s.id));
    return suite ? traces.get(suite.id) : null;
  }

  async function showTrace(testId) {
    const result = await api.traceUrl(traceFor(testId));
    if (!result.ok) {
      showTraceNotice(result.error);
      return;
    }
    traceView = { testId, url: result.url };
    scheduleRender();
  }

  function showTraceNotice(message) {
    const notice = $('#results-detail .trace-notice');
    if (notice) {
      notice.textContent = message;
      notice.hidden = false;
    }
  }

  /** The embedded trace viewer; kept in place across renders so it does not reload. */
  function renderTraceView(target) {
    if (target.dataset.trace === traceView.url)
      return;
    const back = el('button', { type: 'button', className: 'btn btn-sm', textContent: '← Steps' });
    back.addEventListener('click', () => {
      traceView = null;
      scheduleRender();
    });
    const name = testIndex.get(traceView.testId)?.test.name || traceView.testId;
    const frame = el('iframe', { className: 'trace-frame', src: traceView.url, title: `Trace of ${name}` });
    target.replaceChildren(
      el('div', { className: 'trace-bar' }, back, el('span', { className: 'muted', textContent: `Trace · ${name}` })),
      frame);
    target.dataset.trace = traceView.url;
    target.classList.add('is-trace');
  }

  function renderDetail() {
    const target = $('#results-detail');
    if (traceView && traceView.testId === selected) {
      renderTraceView(target);
      return;
    }
    traceView = null;
    delete target.dataset.trace;
    target.classList.remove('is-trace');
    const entry = selected && testIndex.get(selected);
    if (!entry) {
      target.replaceChildren(el('div', { className: 'empty results-empty' },
        rootSuite ? 'Select a test in the Testing panel, or run all tests.' : 'Open the Testing panel to discover the tests of this project.'));
      return;
    }
    const { test, suites } = entry;
    const result = results.get(test.id);
    const runData = runs.get(test.id);
    const scroll = target.scrollTop;

    const actions = el('div', { className: 'results-actions' });
    const runBtn = el('button', { type: 'button', className: 'btn btn-sm btn-primary', textContent: '▶ Run' });
    runBtn.disabled = running;
    runBtn.addEventListener('click', () => run([test.id]));
    const sourceBtn = el('button', { type: 'button', className: 'btn btn-sm', textContent: 'Go to source' });
    sourceBtn.addEventListener('click', () => goToSource(test.id));
    const logBtn = el('button', { type: 'button', className: 'btn btn-sm', textContent: 'Open log' });
    logBtn.disabled = !result || running;
    logBtn.addEventListener('click', () => api.openTestOutput('log.html'));
    const trace = traceFor(test.id);
    const traceBtn = el('button', {
      type: 'button',
      className: 'btn btn-sm',
      textContent: 'Trace',
      title: trace ? 'Replay the test step by step (Playwright trace viewer)'
        : 'No trace: run with "Record trace" and create the browser context with New Context',
    });
    traceBtn.disabled = !trace;
    traceBtn.addEventListener('click', () => showTrace(test.id));
    actions.append(runBtn, traceBtn, sourceBtn, logBtn);

    const meta = [suites.map((s) => s.name).join(' › ')];
    if (result?.elapsed !== undefined)
      meta.push(formatElapsed(result.elapsed));
    const header = el('div', { className: 'results-header' },
      el('div', { className: 'results-title' }, statusIcon(result?.status), el('h2', { textContent: test.name })),
      actions);
    const nodes = [header, el('div', { className: 'results-meta muted', textContent: meta.join(' · ') })];
    if (test.tags.length)
      nodes.push(el('div', { className: 'results-tags' }, ...test.tags.map((tag) => el('span', { className: 'tag', textContent: tag }))));
    nodes.push(el('div', { className: 'trace-notice', hidden: true }));
    if (result?.message)
      nodes.push(el('pre', { className: `results-message ${statusClass(result.status)}`, textContent: result.message }));

    if (runData) {
      const images = allImages(runData);
      if (images.length)
        nodes.push(el('div', { className: 'results-images' }, ...images.map((src) => el('img', { src, alt: 'Screenshot', loading: 'lazy' }))));
      nodes.push(el('h3', { textContent: 'Steps' }));
      const steps = el('div', { className: 'steps-tree' },
        ...runData.logs.map(renderLog),
        ...runData.roots.map((step) => renderStep(test.id, step, 0)));
      if (!runData.roots.length && !runData.logs.length)
        steps.append(el('div', { className: 'empty', textContent: result?.status === 'running' ? 'Starting…' : 'No steps were recorded.' }));
      nodes.push(steps);
    } else if (!result) {
      nodes.push(el('div', { className: 'empty', textContent: 'This test has not been run yet.' }));
    }
    target.replaceChildren(...nodes);
    target.scrollTop = scroll;
  }

  // -------------------------------------------------------------------------
  // Actions

  function select(testId) {
    selected = testId;
    scheduleRender();
    window.dispatchEvent(new CustomEvent('rfide:show-results'));
  }

  function goToSource(testId) {
    const entry = testIndex.get(testId);
    if (entry && entry.test.source)
      window.dispatchEvent(new CustomEvent('rfide:open-file', { detail: { path: entry.test.source, line: entry.test.lineno } }));
  }

  function indexTests(suite, parents = []) {
    const chain = [...parents, suite];
    for (const test of suite.tests)
      testIndex.set(test.id, { test, suites: chain });
    suite.suites.forEach((child) => indexTests(child, chain));
  }

  function testsInScope(select) {
    if (!select.length)
      return [...testIndex.keys()];
    const chosen = new Set(select);
    return [...testIndex.values()]
      .filter(({ test, suites }) => chosen.has(test.id) || suites.some((s) => chosen.has(s.id)))
      .map(({ test }) => test.id);
  }

  /** @param {{ quiet?: boolean }} [options] quiet: keep the current tree while loading */
  async function discover({ quiet = false } = {}) {
    showError('');
    if (!quiet)
      $('#test-tree').replaceChildren(el('li', { className: 'empty', textContent: 'Loading tests…' }));
    const result = await api.discoverTests();
    if (!result.ok) {
      rootSuite = null;
      testIndex = new Map();
      showError(result.error);
      scheduleRender();
      return;
    }
    rootSuite = result.suite;
    testIndex = new Map();
    indexTests(rootSuite);
    if (selected && !testIndex.has(selected))
      selected = null;
    scheduleRender();
  }

  /** @param {{ background?: boolean }} [options] background: watch re-run, keep the current tab */
  async function run(select, { background = false } = {}) {
    if (running)
      return;
    showError('');
    for (const id of testsInScope(select)) {
      results.set(id, { status: 'queued' });
      runs.delete(id);
      traces.delete(id);
    }
    traceView = null; // the Browser library deletes old traces when the run starts
    output = '';
    $('#console-output').textContent = '';
    running = true;
    scheduleRender();
    if (!background)
      window.dispatchEvent(new CustomEvent('rfide:show-results'));
    const result = await api.runTests({ select, headed: $('#tests-headed').checked, trace: $('#tests-trace').checked });
    if (!result.ok) {
      running = false;
      for (const [id, value] of results)
        if (value.status === 'queued')
          results.delete(id);
      showError(result.error);
      scheduleRender();
    }
  }

  // -------------------------------------------------------------------------
  // Runner events

  function onEvent(event) {
    switch (event.type) {
      case 'test-start':
        results.set(event.id, { status: 'running' });
        runs.set(event.id, { steps: new Map(), roots: [], logs: [] });
        if (!selected)
          selected = event.id;
        break;
      case 'test-end':
        results.set(event.id, { status: event.status, message: event.message, elapsed: event.elapsed });
        break;
      case 'step-start': {
        const runData = runs.get(event.test);
        if (!runData)
          break; // suite setup/teardown
        const step = { ...event, status: 'running', children: [], logs: [] };
        runData.steps.set(step.id, step);
        const parent = event.parent && runData.steps.get(event.parent);
        (parent ? parent.children : runData.roots).push(step);
        break;
      }
      case 'step-end': {
        const step = runs.get(event.test)?.steps.get(event.id);
        if (step)
          Object.assign(step, { status: event.status, message: event.message, elapsed: event.elapsed });
        break;
      }
      case 'trace':
        traces.set(event.test || event.suite, event.path);
        break;
      case 'log': {
        const runData = runs.get(event.test);
        if (!runData)
          break;
        const step = event.step && runData.steps.get(event.step);
        (step ? step.logs : runData.logs).push(event);
        break;
      }
      default:
        return;
    }
    scheduleRender();
  }

  api.onTestEvent(onEvent);

  api.onTestOutput((text) => {
    output = (output + text).slice(-MAX_OUTPUT);
    const pre = $('#console-output');
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
    pre.textContent = output;
    if (atBottom)
      pre.scrollTop = pre.scrollHeight;
  });

  api.onTestsFinished(({ exitCode, stopped }) => {
    running = false;
    for (const [id, value] of results) {
      if (value.status === 'queued')
        results.delete(id);
      else if (value.status === 'running')
        results.set(id, { status: 'stopped', message: 'Execution was stopped.' });
    }
    // Robot exit codes: 0-250 number of failed tests, 251 help/version, 252+ errors.
    if (!stopped && exitCode >= 252)
      showError('Robot Framework could not run the tests. See the console output below the results.');
    scheduleRender();
    if (pendingChanges.size)
      processChanges();
  });

  // -------------------------------------------------------------------------
  // Watch mode

  async function processChanges() {
    const paths = [...pendingChanges];
    pendingChanges.clear();
    if (!rootSuite || !paths.some((path) => window.RFWatch.RELEVANT.test(path)))
      return;
    await discover({ quiet: true }); // test names and files may have changed
    if (running || !rootSuite || (!watchAll && !watched.size))
      return;
    const tests = [...testIndex.values()].map(({ test, suites }) => ({ id: test.id, source: test.source, suites: suites.map((s) => s.id) }));
    const ids = window.RFWatch.affectedTests({ paths, tests, watched, watchAll });
    if (ids.length)
      run(ids.length === tests.length ? [] : ids, { background: true });
  }

  window.addEventListener('rfide:files-changed', (event) => {
    for (const path of event.detail.paths)
      pendingChanges.add(path);
    if (!running)
      processChanges();
  });

  // -------------------------------------------------------------------------
  // Controls

  $('#tests-run-all').addEventListener('click', () => run(filter ? visibleTests().map((t) => t.id) : []));
  $('#tests-stop').addEventListener('click', () => api.stopTests());
  $('#tests-refresh').addEventListener('click', discover);
  $('#tests-filter').addEventListener('input', (event) => {
    filter = event.target.value.trim();
    scheduleRender();
  });

  $('#tests-watch').addEventListener('click', () => {
    watchAll = !watchAll;
    scheduleRender();
  });

  window.addEventListener('rfide:project-opened', () => {
    rootSuite = null;
    testIndex = new Map();
    results.clear();
    runs.clear();
    collapsedSuites.clear();
    stepToggles.clear();
    selected = null;
    running = false;
    watched.clear();
    watchAll = false;
    traces.clear();
    traceView = null;
    pendingChanges.clear();
    output = '';
    filter = '';
    $('#tests-filter').value = '';
    $('#console-output').textContent = '';
    discover();
  });

  scheduleRender();
})();
