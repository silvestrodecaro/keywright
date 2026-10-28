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
  /** Steps of suite setups and teardowns, by suite id (same shape as `runs`). */
  const suiteRuns = new Map();
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
  let debugging = false; // the current run stops at breakpoints
  let paused = null; // the last debug-paused event, while paused

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
      renderDebug();
      pushEditorStates();
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

  function allTests(suite) {
    return [...suite.tests, ...suite.suites.flatMap(allTests)];
  }

  function suiteStatus(suite, tests = visibleTests(suite)) {
    const statuses = tests.map((test) => results.get(test.id)?.status);
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
    if (!matchesTagFilter(test)) {
      row.classList.add('is-tag-excluded');
      row.title = `${test.id} (not selected by the tag filter)`;
    }
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
    const filter = tagFilter();
    if (filter.include.length || filter.exclude.length) {
      const matching = visibleTests().filter(matchesTagFilter).length;
      summary.push(el('span', { className: 'status-tags', textContent: `⌗ ${matching} match tags`, title: 'Tests selected by the tag filter (Run options)' }));
    }
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

    // Suite setups run outermost first, suite teardowns innermost first.
    const suiteSteps = (kind) => (kind === 'setup' ? suites : [...suites].reverse())
      .map((suite) => ({ suite, steps: (suiteRuns.get(suite.id)?.roots || []).filter((step) => step.kind === kind) }))
      .filter((group) => group.steps.length);
    const setups = suiteSteps('setup');
    const teardowns = suiteSteps('teardown');
    const suiteSection = (title, groups) => [
      el('h3', { textContent: title }),
      el('div', { className: 'steps-tree' }, ...groups.flatMap(({ suite, steps }) => [
        el('div', { className: 'steps-suite muted', textContent: suite.name }),
        ...steps.map((step) => renderStep(suite.id, step, 0)),
      ])),
    ];

    if (runData || setups.length) {
      const images = [...setups, ...teardowns].flatMap(({ suite }) => allImages(suiteRuns.get(suite.id)))
        .concat(runData ? allImages(runData) : []);
      if (images.length)
        nodes.push(el('div', { className: 'results-images' }, ...[...new Set(images)].map((src) => el('img', { src, alt: 'Screenshot', loading: 'lazy' }))));
      if (setups.length)
        nodes.push(...suiteSection('Suite Setup', setups));
      nodes.push(el('h3', { textContent: 'Steps' }));
      const steps = el('div', { className: 'steps-tree' },
        ...(runData ? runData.logs.map(renderLog) : []),
        ...(runData ? runData.roots.map((step) => renderStep(test.id, step, 0)) : []));
      if (!runData || (!runData.roots.length && !runData.logs.length)) {
        const setupFailed = /^Parent suite setup failed/.test(result?.message || '');
        const text = setupFailed ? 'Not run: the suite setup failed.'
          : !runData || result?.status === 'running' || result?.status === 'queued' ? 'Starting…' : 'No steps were recorded.';
        steps.append(el('div', { className: 'empty', textContent: text }));
      }
      nodes.push(steps);
      if (teardowns.length)
        nodes.push(...suiteSection('Suite Teardown', teardowns));
    } else if (!result) {
      nodes.push(el('div', { className: 'empty', textContent: 'This test has not been run yet.' }));
    }
    target.replaceChildren(...nodes);
    target.scrollTop = scroll;
  }

  /** Last statuses by .robot file, for the run glyphs in the editor gutter. */
  function pushEditorStates() {
    const states = new Map();
    const add = (suite) => {
      if (suite.source && /\.robot$/i.test(suite.source))
        states.set(suite.source, {
          suite: suiteStatus(suite, allTests(suite)),
          tests: new Map(suite.tests.map((test) => [test.name, results.get(test.id)?.status])),
        });
      suite.suites.forEach(add);
    };
    if (rootSuite)
      add(rootSuite);
    window.RFEditor.setTestStates(states, running);
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
    // Tag filters apply to Run all and suites; running a single test is an explicit choice.
    const filter = select.length && select.every((id) => testIndex.has(id)) ? { include: [], exclude: [] } : tagFilter();
    const scope = testsInScope(select).filter((id) => window.RFTags.selected(testIndex.get(id).test.tags, filter));
    if (!scope.length) {
      showError('No test matches the tag filter of the Run options.');
      return;
    }
    for (const id of scope) {
      results.set(id, { status: 'queued' });
      runs.delete(id);
      traces.delete(id);
      for (const suite of testIndex.get(id)?.suites || [])
        suiteRuns.delete(suite.id);
    }
    traceView = null; // the Browser library deletes old traces when the run starts
    output = '';
    $('#console-output').textContent = '';
    running = true;
    scheduleRender();
    if (!background)
      window.dispatchEvent(new CustomEvent('rfide:show-results'));
    debugging = $('#tests-debug').checked;
    paused = null;
    const debug = debugging ? { breakpoints: window.RFEditor.breakpoints(), pauseOnFailure: $('#tests-debug-failures').checked } : undefined;
    const options = runOptions();
    const result = await api.runTests({ select, headed: $('#tests-headed').checked, trace: $('#tests-trace').checked, debug,
      include: filter.include, exclude: filter.exclude, dryrun: options.dryrun, browser: options.browser, extraArgs: options.extraArgs });
    if (!result.ok) {
      running = false;
      for (const [id, value] of results)
        if (value.status === 'queued')
          results.delete(id);
      showError(result.error);
      scheduleRender();
    }
  }

  function suiteForFile(path, suite = rootSuite) {
    if (!suite)
      return null;
    if (suite.source === path)
      return suite;
    for (const child of suite.suites) {
      const found = suiteForFile(path, child);
      if (found)
        return found;
    }
    return null;
  }

  /** Ids of the given tests of a file (or of its suite), or null if they are not discovered. */
  function idsInFile(path, names) {
    const suite = suiteForFile(path);
    if (!suite)
      return null;
    if (!names)
      return [suite.id];
    const ids = names.map((name) => suite.tests.find((test) => test.name === name)?.id);
    return ids.every(Boolean) ? ids : null;
  }

  /**
   * Run requested from the editor gutter or context menu.
   * @param {{ path: string, names: string[] | null, saved: boolean }} request saved: the file was just saved
   */
  async function runFromEditor({ path, names, saved }) {
    if (running)
      return;
    let ids = saved ? null : idsInFile(path, names);
    if (!ids) {
      await discover({ quiet: true }); // new or renamed tests
      ids = idsInFile(path, names);
    }
    if (!ids) {
      const what = names ? `Test '${names.join("', '")}'` : `File ${path}`;
      showError(`${what} was not found by Robot Framework. Only files in the tests folder (testsDir in rfide.json) can be run.`);
      window.dispatchEvent(new CustomEvent('rfide:show-testing'));
      return;
    }
    run(ids);
  }

  window.addEventListener('rfide:run-from-editor', (event) => runFromEditor(event.detail));

  // -------------------------------------------------------------------------
  // Runner events

  /** Where a step or log goes: its test, or the suite whose setup/teardown is running. */
  function runDataFor(event) {
    return event.test ? runs.get(event.test) : suiteRuns.get(event.suite);
  }

  function onEvent(event) {
    switch (event.type) {
      case 'suite-start':
        suiteRuns.set(event.id, { steps: new Map(), roots: [], logs: [] });
        break;
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
        const runData = runDataFor(event);
        if (!runData)
          break;
        const step = { ...event, status: 'running', children: [], logs: [] };
        runData.steps.set(step.id, step);
        const parent = event.parent && runData.steps.get(event.parent);
        (parent ? parent.children : runData.roots).push(step);
        break;
      }
      case 'step-end': {
        const step = runDataFor(event)?.steps.get(event.id);
        if (step)
          Object.assign(step, { status: event.status, message: event.message, elapsed: event.elapsed });
        break;
      }
      case 'trace':
        traces.set(event.test || event.suite, event.path);
        break;
      case 'debug-evaluated':
        onEvaluated(event);
        break;
      case 'debug-paused':
        paused = event;
        evaluateWatches();
        window.dispatchEvent(new CustomEvent('rfide:show-testing'));
        if (event.source && !/^([a-z]:)?[\\/]/i.test(event.source)) { // project file
          window.RFEditor.showDebugLine(event.source, event.lineno); // applied when the file opens
          window.dispatchEvent(new CustomEvent('rfide:open-file', { detail: { path: event.source, line: event.lineno } }));
        }
        break;
      case 'debug-resumed':
        paused = null;
        window.RFEditor.clearDebugLine();
        break;
      case 'log': {
        const runData = runDataFor(event);
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
    debugging = false;
    paused = null;
    window.RFEditor.clearDebugLine();
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
  // Debugger: breakpoints come from the editor; while paused the panel shows
  // the call stack and the variables.

  function sendDebug(command) {
    if (debugging && (paused || command === 'pause'))
      api.debugCommand({ command });
  }

  function openLocation(frame) {
    if (frame.source && frame.lineno && !/^([a-z]:)?[\\/]/i.test(frame.source))
      window.dispatchEvent(new CustomEvent('rfide:open-file', { detail: { path: frame.source, line: frame.lineno } }));
  }

  function renderVariable(variable) {
    return el('div', { className: 'debug-variable', title: `${variable.name} (${variable.type}) = ${variable.value}` },
      el('span', { className: 'tok-var', textContent: variable.name }),
      el('span', { className: 'debug-value', textContent: variable.value }),
      el('span', { className: 'debug-type muted', textContent: variable.type }));
  }

  function renderDebug() {
    const panel = $('#debug-panel');
    panel.hidden = !(running && debugging);
    $('#tests-debug').disabled = running;
    if (panel.hidden)
      return;
    const where = { breakpoint: ' at breakpoint', failure: ' on failure' }[paused?.reason] || '';
    const status = paused ? `Paused${where}: ${paused.name}` : 'Running…';
    $('#debug-message').hidden = !paused?.message;
    $('#debug-message').textContent = paused?.message || '';
    $('#debug-status').textContent = status;
    $('#debug-status').title = status;
    for (const id of ['#debug-continue', '#debug-over', '#debug-into', '#debug-out'])
      $(id).disabled = !paused;
    $('#debug-pause').disabled = !!paused;
    const frames = paused ? paused.frames : [];
    $('#debug-stack').replaceChildren(...frames.map((frame, index) => {
      const row = el('li', { className: 'debug-frame' + (index === 0 ? ' is-current' : ''), title: frame.source || '' },
        el('span', { className: 'debug-frame-name', textContent: frame.name }),
        el('span', { className: 'muted', textContent: frame.source ? `${frame.source.split('/').pop()}:${frame.lineno}` : '' }));
      row.addEventListener('click', () => openLocation(frame));
      return row;
    }));
    if (paused && paused.test)
      $('#debug-stack').append(el('li', { className: 'debug-frame muted', textContent: `Test: ${paused.test.split('.').pop()}` }));
    $('#debug-variables').replaceChildren(...(paused ? paused.variables : []).map((group, index) => {
      const details = el('details', { className: 'debug-scope', open: index === 0 || group.scope === 'Test' },
        el('summary', { textContent: `${group.scope} (${group.variables.length})` }),
        ...group.variables.map(renderVariable));
      return details;
    }));
    if (!paused)
      $('#debug-variables').append(el('div', { className: 'empty', textContent: 'Variables are shown while paused.' }));
    renderEvaluations();
  }

  // Watch and evaluate. Watches are evaluated at every pause (never running keywords);
  // the input evaluates once (variables, Python, or a keyword call) and keeps a history.
  let watches = loadWatches();
  const evaluations = []; // { expression, result }, newest last
  const pendingEvaluations = new Map(); // id -> entry waiting for its result
  let evaluationId = 0;

  function loadWatches() {
    try {
      return JSON.parse(localStorage.getItem('rfide.watches') || '[]').map((expression) => ({ expression, result: null }));
    } catch {
      return [];
    }
  }

  function saveWatches() {
    try {
      localStorage.setItem('rfide.watches', JSON.stringify(watches.map((w) => w.expression)));
    } catch {
      // storage unavailable
    }
  }

  function evaluate(entry, keywords) {
    const id = `e${++evaluationId}`;
    entry.result = { pending: true };
    pendingEvaluations.set(id, entry);
    api.debugCommand({ command: 'evaluate', id, expression: entry.expression, keywords });
  }

  function evaluateWatches() {
    for (const watch of watches)
      evaluate(watch, false);
  }

  function onEvaluated(event) {
    const entry = pendingEvaluations.get(event.id);
    if (!entry)
      return;
    pendingEvaluations.delete(event.id);
    entry.result = event;
  }

  function evaluationRow(entry, actions) {
    const result = entry.result;
    const value = !result ? (paused ? '' : 'not paused') : result.pending ? '…' : result.ok ? result.value : result.error;
    return el('div', { className: 'debug-variable debug-evaluation' + (result && !result.pending && !result.ok ? ' is-error' : ''),
      title: result && result.ok ? `${entry.expression} (${result.valueType}) = ${result.value}` : value },
    el('span', { className: 'tok-var', textContent: entry.expression }),
    el('span', { className: 'debug-value', textContent: value }),
    ...actions);
  }

  function renderEvaluations() {
    $('#debug-watches').replaceChildren(...watches.map((watch) => {
      const remove = el('button', { type: 'button', className: 'icon-btn debug-row-action', title: 'Remove watch', textContent: '✕' });
      remove.addEventListener('click', () => {
        watches = watches.filter((w) => w !== watch);
        saveWatches();
        scheduleRender();
      });
      return evaluationRow(watch, [remove]);
    }));
    if (!watches.length)
      $('#debug-watches').append(el('div', { className: 'empty', textContent: 'Add watches from the results below (👁).' }));
    $('#debug-console').replaceChildren(...[...evaluations].reverse().map((entry) => {
      const watch = el('button', { type: 'button', className: 'icon-btn debug-row-action', title: 'Watch: evaluate at every pause', textContent: '👁' });
      watch.addEventListener('click', () => {
        if (!watches.some((w) => w.expression === entry.expression)) {
          watches.push({ expression: entry.expression, result: entry.result });
          saveWatches();
          scheduleRender();
        }
      });
      return evaluationRow(entry, [watch]);
    }));
  }

  $('#debug-eval-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#debug-eval-input');
    const expression = input.value.trim();
    if (!expression || !paused)
      return;
    const entry = { expression, result: null };
    evaluations.push(entry);
    if (evaluations.length > 50)
      evaluations.shift();
    evaluate(entry, true);
    input.value = '';
    scheduleRender();
  });

  $('#tests-debug').addEventListener('change', (event) => {
    $('#tests-debug-failures').disabled = !event.target.checked;
  });
  $('#tests-debug-failures').addEventListener('change', (event) => {
    if (running && debugging)
      api.debugCommand({ command: 'options', pauseOnFailure: event.target.checked });
  });

  $('#debug-continue').addEventListener('click', () => sendDebug('continue'));
  $('#debug-over').addEventListener('click', () => sendDebug('over'));
  $('#debug-into').addEventListener('click', () => sendDebug('into'));
  $('#debug-out').addEventListener('click', () => sendDebug('out'));
  $('#debug-pause').addEventListener('click', () => sendDebug('pause'));
  $('#debug-stop').addEventListener('click', () => api.stopTests());

  // F5 / F10 / F11 / Shift+F11, like VS Code, while a debug run is active.
  document.addEventListener('keydown', (event) => {
    if (!debugging || !running)
      return;
    const command = event.key === 'F5' ? 'continue' : event.key === 'F10' ? 'over'
      : event.key === 'F11' ? (event.shiftKey ? 'out' : 'into') : null;
    if (!command)
      return;
    event.preventDefault();
    event.stopPropagation();
    sendDebug(command);
  }, true);

  // Breakpoints: kept per project in this browser profile, sent to a running debug session.
  let breakpointsKey = null;
  window.RFEditor.onBreakpointsChange((breakpoints) => {
    if (running && debugging)
      api.debugCommand({ command: 'breakpoints', breakpoints });
    try {
      if (breakpointsKey)
        localStorage.setItem(breakpointsKey, JSON.stringify(breakpoints));
    } catch {
      // storage unavailable: breakpoints last for this session only
    }
  });

  window.addEventListener('rfide:project-opened', (event) => {
    breakpointsKey = event.detail && event.detail.root ? `rfide.breakpoints:${event.detail.root}` : null;
    let saved = {};
    try {
      saved = JSON.parse((breakpointsKey && localStorage.getItem(breakpointsKey)) || '{}');
    } catch {
      saved = {};
    }
    window.RFEditor.setBreakpoints(saved);
  });

  // -------------------------------------------------------------------------
  // Run options: tag filters, browser, dry run, extra arguments (kept per project)

  const RUN_OPTION_FIELDS = { include: '#run-include', exclude: '#run-exclude', browser: '#run-browser', extraArgs: '#run-args' };
  let runOptionsKey = null;

  function runOptions() {
    const values = Object.fromEntries(Object.entries(RUN_OPTION_FIELDS).map(([name, selector]) => [name, $(selector).value.trim()]));
    return { ...values, dryrun: $('#run-dryrun').checked };
  }

  function tagFilter() {
    return { include: window.RFTags.parseList($('#run-include').value), exclude: window.RFTags.parseList($('#run-exclude').value) };
  }

  function matchesTagFilter(test) {
    return window.RFTags.selected(test.tags, tagFilter());
  }

  function renderRunOptions() {
    const options = runOptions();
    const active = [
      options.include || options.exclude ? 'tags' : null,
      options.browser || null,
      options.dryrun ? 'dry run' : null,
      options.extraArgs ? 'arguments' : null,
    ].filter(Boolean);
    $('#run-options-active').textContent = active.length ? `(${active.join(', ')})` : '';
  }

  function saveRunOptions() {
    renderRunOptions();
    scheduleRender();
    try {
      if (runOptionsKey)
        localStorage.setItem(runOptionsKey, JSON.stringify(runOptions()));
    } catch {
      // storage unavailable
    }
  }

  for (const selector of [...Object.values(RUN_OPTION_FIELDS), '#run-dryrun'])
    $(selector).addEventListener(selector === '#run-browser' || selector === '#run-dryrun' ? 'change' : 'input', saveRunOptions);

  window.addEventListener('rfide:project-opened', (event) => {
    runOptionsKey = event.detail && event.detail.root ? `rfide.runOptions:${event.detail.root}` : null;
    let saved = {};
    try {
      saved = JSON.parse((runOptionsKey && localStorage.getItem(runOptionsKey)) || '{}');
    } catch {
      saved = {};
    }
    for (const [name, selector] of Object.entries(RUN_OPTION_FIELDS))
      $(selector).value = saved[name] || '';
    $('#run-dryrun').checked = !!saved.dryrun;
    $('#run-options').open = Object.values(saved).some(Boolean);
    renderRunOptions();
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
    suiteRuns.clear();
    collapsedSuites.clear();
    stepToggles.clear();
    selected = null;
    running = false;
    debugging = false;
    paused = null;
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
