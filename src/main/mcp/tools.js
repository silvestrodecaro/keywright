'use strict';

const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const projects = require('../projects');
const { searchProject } = require('../projectSearch');
const { ToolError } = require('./protocol');

const MAX_LIST_ENTRIES = 2000;
const MAX_KEYWORDS = 60;
const OUTPUT_TAIL = 4000;
// Below the shortest default tool timeout of common clients (Codex: 60 s).
const RUN_WAIT_SECONDS = 45;
const MAX_RUN_WAIT_SECONDS = 55;
const MAX_TEST_LOGS = 40;
const IMPORTANT_LEVELS = new Set(['FAIL', 'ERROR', 'WARN']);
const SOURCE_CONTEXT = 3;
const MAX_FAILURE_IMAGES = 2;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

const INSTRUCTIONS = `Keywright is a desktop IDE for Robot Framework projects that use the Browser library.
These tools act on the project open in Keywright, as the user sees it.

To write a test:
1. Read the project: project_info, list_files, read_file. Reuse the keywords of its resource files; find_keywords searches project and library keywords.
2. Explore the application: browser_open, then browser_snapshot. Act with browser_click, browser_fill, browser_select, ... on the element refs of the latest snapshot (ref=e5). Each action returns the matching Browser library step and a new snapshot. Add checks with browser_assert.
3. browser_steps returns the steps (or a complete test) built from those actions, with the selectors the script needs.
4. Write the .robot file in the tests folder with write_file or edit_file. Prefer the project's keywords and variables over raw steps where they exist.
5. Verify with check_file, then run_tests, and fix failures until the test passes. run_tests returns within about 45 seconds; while tests are still running, call wait_for_run. test_failure_details shows the failing line, the log and Browser's screenshot.

Paths are relative to the project folder, with forward slashes. Deleted files go to the Recycle Bin. The user sees your file changes in Keywright and can undo them. Files with unsaved changes in the Keywright editor cannot be changed through these tools; ask the user to save or close them.`;

const pathProperty = (description) => ({ type: 'string', description });
const ref = { type: 'string', description: 'Element ref from the latest browser_snapshot, e.g. e5.' };

/** Forward slashes, no leading or trailing slash. */
function cleanPath(relative) {
  return String(relative ?? '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+|\/+$/g, '');
}

function samePath(a, b) {
  return process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Whether `inner` is `outer` or inside the folder `outer`. */
function within(inner, outer) {
  return samePath(inner, outer) || samePath(inner.slice(0, outer.length + 1), `${outer}/`);
}

/**
 * Follows a run started through MCP and keeps collecting its events after a tool
 * call returns, so the model can wait in steps shorter than its client's tool
 * timeout (60 s in Codex, 180 s in Antigravity by default): per-test status and
 * message, the failing keyword, and the console tail.
 */
class RunTracker {
  /** @param {import('events').EventEmitter} runner emits 'event', 'output' and 'finished' */
  constructor(runner) {
    this.runner = runner;
    this.current = null;
  }

  /** Starts a run through `start` and begins collecting; throws when it cannot start. */
  async start(start) {
    const run = { tests: new Map(), steps: new Map(), output: '', done: false, result: null };
    let finish;
    run.finished = new Promise((resolve) => { finish = resolve; });
    const onEvent = (event) => {
      if (event.type === 'test-start')
        run.tests.set(event.id, { name: event.id, status: 'RUNNING', logs: [], images: [] });
      else if (event.type === 'step-start')
        run.steps.set(event.id, { name: event.name, args: event.args || [], lineno: event.lineno, source: event.source || null });
      else if (event.type === 'step-end' && event.status === 'FAIL' && event.test) {
        const test = run.tests.get(event.test);
        const step = run.steps.get(event.id);
        // The first failing step to end is the innermost one.
        if (test && step && !test.failedStep) {
          const where = step.source ? ` (${step.source}${step.lineno ? `:${step.lineno}` : ''})` : step.lineno ? ` (line ${step.lineno})` : '';
          test.failedStep = `${step.name}${step.args.length ? `    ${step.args.join('    ')}` : ''}${where}`;
          test.failedAt = step.source && step.lineno ? { source: step.source, line: step.lineno } : null;
        }
      } else if (event.type === 'log' && event.test) {
        // Messages and Browser's screenshots (main.js adds `images` as file URLs).
        const test = run.tests.get(event.test);
        if (test) {
          test.logs.push({ level: event.level, text: event.html ? htmlToText(event.text) : String(event.text || '') });
          // Over the limit, the oldest ordinary message goes; failures and warnings stay.
          const drop = test.logs.length > MAX_TEST_LOGS ? test.logs.findIndex((log) => !IMPORTANT_LEVELS.has(log.level)) : -1;
          if (drop >= 0)
            test.logs.splice(drop, 1);
          test.images.push(...(event.images || []));
        }
      } else if (event.type === 'test-end') {
        const test = run.tests.get(event.id) || { name: event.id };
        Object.assign(test, { status: event.status, message: event.message || '', elapsed: event.elapsed });
        run.tests.set(event.id, test);
      }
    };
    const onOutput = (text) => { run.output = (run.output + text).slice(-OUTPUT_TAIL * 2); };
    const cleanup = () => {
      this.runner.off('event', onEvent);
      this.runner.off('output', onOutput);
      this.runner.off('finished', onFinished);
    };
    const onFinished = (result) => {
      cleanup();
      run.done = true;
      run.result = result;
      finish();
    };
    this.runner.on('event', onEvent);
    this.runner.on('output', onOutput);
    this.runner.on('finished', onFinished);
    try {
      await start();
    } catch (error) {
      cleanup();
      throw error;
    }
    this.current = run;
    return run;
  }

  /**
   * Waits up to `seconds` for the current run to finish.
   * @returns {Promise<object | null>} a snapshot of the run, null when none was started
   */
  async wait(seconds) {
    const run = this.current;
    if (!run)
      return null;
    let timer;
    await Promise.race([run.finished, new Promise((resolve) => { timer = setTimeout(resolve, seconds * 1000); })]);
    clearTimeout(timer);
    return {
      done: run.done,
      ...(run.result || {}),
      tests: [...run.tests.values()],
      output: run.output.slice(-OUTPUT_TAIL),
    };
  }
}

function formatRun(run, outputDir) {
  const lines = [];
  const passed = run.tests.filter((t) => t.status === 'PASS').length;
  const failed = run.tests.filter((t) => t.status === 'FAIL');
  const skipped = run.tests.filter((t) => t.status === 'SKIP').length;
  if (!run.done) {
    const running = run.tests.find((t) => t.status === 'RUNNING');
    lines.push(`Still running: ${passed} passed, ${failed.length} failed, ${skipped} skipped so far${running ? `; now running ${running.name}` : ''}.`
      + ' Call wait_for_run to keep waiting, or stop_tests.');
  } else {
    lines.push(run.stopped ? 'The run was stopped.' : `Finished: ${passed} passed, ${failed.length} failed, ${skipped} skipped (exit code ${run.exitCode}).`);
  }
  for (const test of run.tests) {
    if (test.status === 'RUNNING')
      continue;
    lines.push(`${test.status}  ${test.name}${test.elapsed !== undefined ? `  (${test.elapsed}s)` : ''}`);
    if (test.status === 'FAIL') {
      if (test.failedStep)
        lines.push(`      failing keyword: ${test.failedStep}`);
      if (test.message)
        lines.push(`      ${test.message.split('\n').join('\n      ')}`);
    }
  }
  if (run.done && (!run.tests.length || run.exitCode >= 252 || failed.length))
    lines.push('', 'Console output (end):', run.output.trim() || '(none)');
  if (failed.length)
    lines.push('', 'For the failing source lines, the log and the screenshot of a failure, call test_failure_details.');
  if (run.done && outputDir)
    lines.push('', `Robot log: ${path.join(outputDir, 'log.html')}`);
  return lines.join('\n');
}

/** Text of an HTML log message: Browser logs screenshots and some messages as HTML. */
function htmlToText(html) {
  return String(html || '')
    .replace(/<img[^>]*src="([^"]+)"[^>]*>/gi, '[image $1]')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .trim();
}

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/**
 * The failing keyword in its source, the test's log, and its last screenshots, as
 * MCP content: text first, then images the model can look at.
 */
function failureDetails(root, test) {
  const lines = [`${test.status}  ${test.name}`];
  if (test.message)
    lines.push(`Message: ${test.message}`);
  if (test.failedStep)
    lines.push(`Failing keyword: ${test.failedStep}`);
  if (test.failedAt) {
    try {
      const source = fs.readFileSync(projects.resolveInProject(root, test.failedAt.source), 'utf8').split(/\r?\n/);
      const first = Math.max(1, test.failedAt.line - SOURCE_CONTEXT);
      const last = Math.min(source.length, test.failedAt.line + SOURCE_CONTEXT);
      lines.push('', `${test.failedAt.source}:`);
      for (let number = first; number <= last; number++)
        lines.push(`${number === test.failedAt.line ? '>' : ' '} ${String(number).padStart(4)}  ${source[number - 1]}`);
    } catch {
      // outside the project (a library resource) or since removed: the name and line remain
    }
  }
  if (test.logs?.length) {
    lines.push('', 'Log:');
    for (const log of test.logs)
      lines.push(`  ${log.level}  ${log.text.split('\n').join('\n         ')}`);
  }
  const content = [];
  const images = [...new Set(test.images || [])].slice(-MAX_FAILURE_IMAGES);
  for (const url of images) {
    let file;
    try {
      file = fileURLToPath(url);
      const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
      if (!type || fs.statSync(file).size > MAX_IMAGE_BYTES)
        continue;
      content.push({ type: 'image', data: fs.readFileSync(file).toString('base64'), mimeType: type });
    } catch {
      // removed by a later run
    }
  }
  lines.push('', content.length ? `Screenshot${content.length > 1 ? 's' : ''} below (${content.length}).` : 'No screenshot was taken.');
  return [{ type: 'text', text: lines.join('\n') }, ...content];
}

/** Flattens the explorer tree into one path per line; folders end with "/". */
function flattenTree(entries, lines = []) {
  for (const entry of entries) {
    if (lines.length >= MAX_LIST_ENTRIES)
      break;
    lines.push(entry.type === 'dir' ? `${entry.path}/` : entry.path);
    if (entry.children)
      flattenTree(entry.children, lines);
  }
  return lines;
}

function describeSuite(suite, depth = 0, lines = []) {
  const indent = '  '.repeat(depth);
  lines.push(`${indent}${suite.name}${suite.source ? `  [${suite.source}]` : ''}`);
  for (const test of suite.tests || [])
    lines.push(`${indent}  - ${test.name}${test.tags?.length ? `  [tags: ${test.tags.join(', ')}]` : ''}  (id: ${test.id})`);
  for (const child of suite.suites || [])
    describeSuite(child, depth + 1, lines);
  return lines;
}

/**
 * The MCP tools, bound to the application through `app`:
 * @param {{
 *   project: () => ({ root: string, name: string, python: string|null, config: object } | null),
 *   dirtyPaths: () => string[],
 *   trash: (absolutePath: string) => Promise<void>,
 *   keywords: () => Promise<{ ok: boolean, error?: string, keywords: object[] }>,
 *   check: (relative: string, text: string) => Promise<{ ok: boolean, problems: object[], error?: string }>,
 *   discover: () => Promise<{ ok: boolean, suite?: object, error?: string }>,
 *   runner: import('events').EventEmitter & { running: boolean, stop(): void },
 *   startRun: (options: object) => Promise<void>,
 *   browser: import('./agentBrowser').AgentBrowser,
 *   browsers: Record<string, { browser: string, channel: string|null }>,
 *   launchError: (error: Error, browser?: string) => string,
 *   changes?: import('./changes').ChangeLog,
 * }} app
 */
function createTools(app) {
  function project() {
    const current = app.project();
    if (!current)
      throw new ToolError('No project is open in Keywright. Ask the user to open one.');
    return current;
  }

  function requireSaved(relative, action) {
    const dirty = app.dirtyPaths().filter((file) => within(cleanPath(file), relative));
    if (dirty.length)
      throw new ToolError(`Cannot ${action} ${relative}: ${dirty.join(', ')} ${dirty.length === 1 ? 'has' : 'have'} unsaved changes in the Keywright editor. Ask the user to save or discard them first.`);
  }

  function writeFile(root, relative, content, tool) {
    const target = projects.resolveInProject(root, relative);
    let revision = null;
    let before = null;
    if (fs.existsSync(target)) {
      if (fs.statSync(target).isDirectory())
        throw new ToolError(`${relative} is a folder.`);
      ({ revision, content: before } = projects.readProjectFile(root, relative));
      if (revision === undefined)
        throw new ToolError(`${relative} is binary or too large to be replaced as text.`);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
    }
    const result = projects.writeProjectFile(root, relative, content, revision);
    if (!result.ok)
      throw new ToolError(`${relative} changed on disk while it was being written. Read it again and retry.`);
    app.changes?.wrote(root, relative, before, content, tool);
    return revision === null ? 'created' : 'updated';
  }

  function readText(root, relative) {
    let file;
    try {
      file = projects.readProjectFile(root, relative);
    } catch (error) {
      throw new ToolError(error.code === 'ENOENT' ? `${relative} does not exist.` : error.message);
    }
    if (file.content === null)
      throw new ToolError(`${relative}: ${file.reason}`);
    return file.content;
  }

  async function browserCall(perform) {
    try {
      return await perform();
    } catch (error) {
      if (error instanceof ToolError)
        throw error;
      throw new ToolError(app.launchError(error));
    }
  }

  const runs = new RunTracker(app.runner);

  async function waitAndFormat(seconds = RUN_WAIT_SECONDS) {
    const limit = Math.min(Math.max(Number(seconds) || RUN_WAIT_SECONDS, 1), MAX_RUN_WAIT_SECONDS);
    const run = await runs.wait(limit);
    if (!run)
      return app.runner.running ? 'Tests started in Keywright are running; only runs started with run_tests can be followed here.' : 'No run was started with run_tests.';
    const current = app.project();
    return formatRun(run, current ? path.resolve(current.root, current.config.outputDir) : null);
  }

  const tools = [
    // Project ---------------------------------------------------------------
    {
      name: 'project_info',
      title: 'Project information',
      description: 'The open project: folder, configured tests/resources/results folders, Python interpreter, and whether tests or the browser are running.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      handler: () => {
        const current = app.project();
        if (!current)
          return 'No project is open in Keywright.';
        return {
          name: current.name,
          root: current.root,
          testsDir: current.config.testsDir,
          resourcesDir: current.config.resourcesDir,
          outputDir: current.config.outputDir,
          python: current.python || 'not found: create the .venv or set the interpreter in Project settings',
          testsRunning: app.runner.running,
          browserOpen: app.browser.open,
          unsavedEditorFiles: app.dirtyPaths(),
        };
      },
    },
    {
      name: 'list_files',
      title: 'List project files',
      description: 'Lists project files and folders (folders end with "/"). Skips .git, .venv, node_modules and caches.',
      inputSchema: { type: 'object', properties: { path: pathProperty('Folder to list; the whole project when omitted.') } },
      annotations: { readOnlyHint: true },
      handler: ({ path: folder }) => {
        const { root } = project();
        const relative = cleanPath(folder);
        if (relative) {
          const target = projects.resolveInProject(root, relative);
          if (!fs.existsSync(target) || !fs.statSync(target).isDirectory())
            throw new ToolError(`${relative} is not a folder.`);
        }
        const lines = flattenTree(projects.listTree(root, relative));
        if (lines.length >= MAX_LIST_ENTRIES)
          lines.push(`… (first ${MAX_LIST_ENTRIES} entries; list a subfolder to see more)`);
        return lines.length ? lines.join('\n') : '(empty)';
      },
    },
    {
      name: 'read_file',
      title: 'Read a file',
      description: 'Reads a text file of the project from disk.',
      inputSchema: { type: 'object', properties: { path: pathProperty('File path, e.g. tests/login.robot') }, required: ['path'] },
      annotations: { readOnlyHint: true },
      handler: ({ path: file }) => {
        const relative = cleanPath(file);
        const text = readText(project().root, relative);
        const unsaved = app.dirtyPaths().some((dirty) => samePath(cleanPath(dirty), relative));
        return unsaved ? `(The Keywright editor has unsaved changes to this file; this is the version on disk.)\n${text}` : text;
      },
    },
    {
      name: 'write_file',
      title: 'Write a file',
      description: 'Creates a file, or replaces its whole content. Creates missing folders. Open editor tabs reload the new content.',
      inputSchema: {
        type: 'object',
        properties: { path: pathProperty('File path, e.g. tests/login.robot'), content: { type: 'string', description: 'The complete file content.' } },
        required: ['path', 'content'],
      },
      annotations: { destructiveHint: true },
      handler: ({ path: file, content }) => {
        const { root } = project();
        const relative = cleanPath(file);
        if (!relative)
          throw new ToolError('Give a file path.');
        requireSaved(relative, 'write');
        return `${relative} ${writeFile(root, relative, content, 'write_file')}.`;
      },
    },
    {
      name: 'edit_file',
      title: 'Edit a file',
      description: 'Replaces an exact piece of text in a file. old_text must occur exactly once unless replace_all is true; include enough surrounding lines to make it unique.',
      inputSchema: {
        type: 'object',
        properties: {
          path: pathProperty('File path.'),
          old_text: { type: 'string', description: 'The exact text to replace, including indentation.' },
          new_text: { type: 'string', description: 'The replacement text.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
      annotations: { destructiveHint: true },
      handler: ({ path: file, old_text: oldText, new_text: newText, replace_all: replaceAll = false }) => {
        const { root } = project();
        const relative = cleanPath(file);
        requireSaved(relative, 'edit');
        if (!oldText)
          throw new ToolError('old_text is empty. Use write_file to create or replace a whole file.');
        const text = readText(root, relative);
        let from = oldText;
        let to = newText;
        // Windows files: accept text sent with \n line endings.
        if (!text.includes(from) && text.includes('\r\n') && !from.includes('\r\n')) {
          from = from.replace(/\n/g, '\r\n');
          to = to.replace(/\r?\n/g, '\r\n');
        }
        const count = text.split(from).length - 1;
        if (count === 0)
          throw new ToolError(`old_text was not found in ${relative}. Read the file again; indentation and spacing must match exactly.`);
        if (count > 1 && !replaceAll)
          throw new ToolError(`old_text occurs ${count} times in ${relative}. Add surrounding lines to make it unique, or set replace_all.`);
        const updated = replaceAll ? text.split(from).join(to) : text.replace(from, () => to);
        writeFile(root, relative, updated, 'edit_file');
        return `${relative} updated (${replaceAll ? count : 1} replacement${replaceAll && count > 1 ? 's' : ''}).`;
      },
    },
    {
      name: 'delete_path',
      title: 'Delete a file or folder',
      description: 'Moves a file or folder of the project to the Recycle Bin.',
      inputSchema: { type: 'object', properties: { path: pathProperty('File or folder path.') }, required: ['path'] },
      annotations: { destructiveHint: true },
      handler: async ({ path: file }) => {
        const { root } = project();
        const relative = cleanPath(file);
        requireSaved(relative, 'delete');
        let entry;
        try {
          ({ entry } = projects.projectEntry(root, relative));
        } catch (error) {
          throw new ToolError(error.message);
        }
        const backup = app.changes?.backup(entry) ?? null;
        await app.trash(entry);
        app.changes?.deleted(root, relative, backup, 'delete_path');
        return `${relative} moved to the Recycle Bin.`;
      },
    },
    {
      name: 'rename_path',
      title: 'Rename a file or folder',
      description: 'Renames a file or folder in its folder. To move a file elsewhere, write_file the new path and delete_path the old one.',
      inputSchema: {
        type: 'object',
        properties: { path: pathProperty('File or folder path.'), new_name: { type: 'string', description: 'New name only, without folders.' } },
        required: ['path', 'new_name'],
      },
      annotations: { destructiveHint: true },
      handler: ({ path: file, new_name: name }) => {
        const { root } = project();
        const relative = cleanPath(file);
        requireSaved(relative, 'rename');
        let renamed;
        try {
          renamed = projects.renameProjectPath(root, relative, name);
        } catch (error) {
          throw new ToolError(error.message);
        }
        if (renamed !== relative)
          app.changes?.renamed(root, relative, renamed, 'rename_path');
        return `Renamed to ${renamed}.`;
      },
    },
    {
      name: 'search_project',
      title: 'Search the project',
      description: 'Searches the text of project files on disk (not the results folder).',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text, or a regular expression with regex: true.' },
          regex: { type: 'boolean' },
          match_case: { type: 'boolean' },
          include: { type: 'string', description: 'Comma-separated globs of files to search, e.g. *.robot, resources/**' },
        },
        required: ['query'],
      },
      annotations: { readOnlyHint: true },
      handler: ({ query, regex = false, match_case: matchCase = false, include = '' }) => {
        const current = project();
        let result;
        try {
          result = searchProject(current.root, { query, regex, caseSensitive: matchCase, wholeWord: false, include }, { outputDir: current.config.outputDir });
        } catch (error) {
          throw new ToolError(error.message);
        }
        const lines = [];
        for (const file of result.files)
          for (const match of file.matches)
            lines.push(`${file.path}:${match.line}: ${String(match.preview).trim()}`);
        if (result.truncated)
          lines.push('… (more matches; narrow the search)');
        return lines.length ? lines.join('\n') : 'No matches.';
      },
    },
    {
      name: 'find_keywords',
      title: 'Find keywords',
      description: 'Searches the keywords available to the project: its own (resource and test files) and those of imported libraries such as Browser. Returns names, arguments and short documentation; set full_doc for complete documentation.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Words in the keyword name or documentation, e.g. "fill text" or "login".' },
          library: { type: 'string', description: 'Only this library or resource, e.g. Browser.' },
          full_doc: { type: 'boolean', description: 'Include the complete documentation.' },
        },
        required: ['query'],
      },
      annotations: { readOnlyHint: true },
      handler: async ({ query, library, full_doc: fullDoc = false }) => {
        project();
        const index = await app.keywords();
        if (!index.ok)
          throw new ToolError(index.error || 'Keywords are not available.');
        const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
        const source = (kw) => kw.library || kw.source || '';
        const scored = index.keywords
          .filter((kw) => !library || source(kw).toLowerCase().includes(String(library).toLowerCase()))
          .map((kw) => {
            const name = kw.name.toLowerCase();
            const doc = String(kw.shortdoc || kw.doc || '').toLowerCase();
            let score = 0;
            for (const word of words) {
              if (name.includes(word)) score += 3;
              else if (doc.includes(word)) score += 1;
              else return { kw, score: -1 };
            }
            if (name === words.join(' ')) score += 10;
            if (kw.user) score += 1; // the project's own keywords first
            return { kw, score };
          })
          .filter(({ score }) => score >= 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_KEYWORDS);
        if (!scored.length)
          return 'No keyword matches.';
        return scored.map(({ kw }) => {
          const args = (kw.args || []).map((a) => (typeof a === 'string' ? a : a.repr || a.name)).join('    ');
          const where = kw.user ? `${kw.source}${kw.lineno ? `:${kw.lineno}` : ''}` : kw.library;
          const head = `${kw.name}${args ? `    ${args}` : ''}    [${where || 'project'}]`;
          const doc = fullDoc ? kw.doc : kw.shortdoc;
          return doc ? `${head}\n  ${String(doc).trim().split('\n').join('\n  ')}` : head;
        }).join('\n');
      },
    },
    {
      name: 'check_file',
      title: 'Check a Robot file',
      description: 'Parses a .robot or .resource file with Robot Framework and reports syntax errors and problems, without running it.',
      inputSchema: { type: 'object', properties: { path: pathProperty('File path.') }, required: ['path'] },
      annotations: { readOnlyHint: true },
      handler: async ({ path: file }) => {
        const { root } = project();
        const relative = cleanPath(file);
        const result = await app.check(relative, readText(root, relative));
        if (!result.ok)
          throw new ToolError(result.error || 'The check is not available: the project needs its Python environment.');
        if (!result.problems.length)
          return 'No problems found.';
        return result.problems.map((p) => `line ${p.line ?? p.lineno ?? '?'}: ${p.severity ? `${p.severity}: ` : ''}${p.message}`).join('\n');
      },
    },

    // Tests -----------------------------------------------------------------
    {
      name: 'discover_tests',
      title: 'List tests',
      description: 'Lists the suites and tests in the tests folder, with tags and ids for run_tests.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      handler: async () => {
        project();
        const result = await app.discover();
        if (!result.ok)
          throw new ToolError(result.error);
        return describeSuite(result.suite).join('\n');
      },
    },
    {
      name: 'run_tests',
      title: 'Run tests',
      description: `Runs Robot Framework tests from the files on disk. The run appears in Keywright's Testing panel. Waits up to wait_seconds (default ${RUN_WAIT_SECONDS}) and returns each finished test's status, the failing keyword and message, and the console output on failure. If tests are still running, call wait_for_run.`,
      inputSchema: {
        type: 'object',
        properties: {
          tests: { type: 'array', items: { type: 'string' }, description: 'Ids (full names) of tests or suites from discover_tests; all tests when omitted.' },
          include_tags: { type: 'array', items: { type: 'string' } },
          exclude_tags: { type: 'array', items: { type: 'string' } },
          headed: { type: 'boolean', description: "Show the browser (the project must use ${HEADLESS}, as Keywright's template does)." },
          wait_seconds: { type: 'integer', description: `Seconds to wait before returning partial results (1-${MAX_RUN_WAIT_SECONDS}, default ${RUN_WAIT_SECONDS}).` },
        },
      },
      handler: async ({ tests = [], include_tags: include = [], exclude_tags: exclude = [], headed = false, wait_seconds: waitSeconds }) => {
        project();
        if (app.runner.running)
          throw new ToolError('Tests are already running. Call wait_for_run for a run started here, or stop_tests.');
        try {
          await runs.start(() => app.startRun({ select: tests, include, exclude, headed }));
        } catch (error) {
          throw new ToolError(error.message);
        }
        const notice = app.dirtyPaths().length
          ? `\n\nNote: the Keywright editor has unsaved changes (${app.dirtyPaths().join(', ')}); the run used the files on disk.` : '';
        return await waitAndFormat(waitSeconds) + notice;
      },
    },
    {
      name: 'wait_for_run',
      title: 'Wait for tests',
      description: `Waits for the run started with run_tests, up to seconds (default ${RUN_WAIT_SECONDS}), and returns its results so far or its final result.`,
      inputSchema: { type: 'object', properties: { seconds: { type: 'integer', description: `1-${MAX_RUN_WAIT_SECONDS}, default ${RUN_WAIT_SECONDS}.` } } },
      annotations: { readOnlyHint: true },
      handler: ({ seconds }) => waitAndFormat(seconds),
    },
    {
      name: 'test_failure_details',
      title: 'Why a test failed',
      description: 'Details of a failed test from the last run started with run_tests: the failing keyword with its file, line and surrounding source, the test\'s log messages, and the screenshot Browser took on failure.',
      inputSchema: { type: 'object', properties: { test: { type: 'string', description: 'Test id (full name) from the run results; the first failed test when omitted.' } } },
      annotations: { readOnlyHint: true },
      handler: async ({ test: id }) => {
        const current = project();
        const run = await runs.wait(0);
        if (!run)
          throw new ToolError('No run was started with run_tests.');
        const failed = run.tests.filter((t) => t.status === 'FAIL');
        const test = id ? run.tests.find((t) => t.name === id || t.name.endsWith(`.${id}`)) : failed[0];
        if (!test)
          throw new ToolError(id ? `No test "${id}" in the last run. Tests: ${run.tests.map((t) => t.name).join(', ')}` : 'No test failed in the last run.');
        return failureDetails(current.root, test);
      },
    },
    {
      name: 'stop_tests',
      title: 'Stop tests',
      description: 'Stops the running tests.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => {
        if (!app.runner.running)
          return 'No tests are running.';
        app.runner.stop();
        return 'Stopping.';
      },
    },

    // Browser ---------------------------------------------------------------
    {
      name: 'browser_open',
      title: 'Open a browser',
      description: 'Opens a visible browser for exploring the application under test, optionally at a URL, and returns the page snapshot. Starts a new list of recorded steps.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          browser: { type: 'string', enum: ['chromium', 'chrome', 'msedge', 'firefox', 'webkit'], description: 'Default chromium.' },
          width: { type: 'integer', description: 'Viewport width (default 1280).' },
          height: { type: 'integer', description: 'Viewport height (default 720).' },
        },
      },
      handler: ({ url, browser = 'chromium', width, height }) => browserCall(async () => {
        const target = app.browsers[browser] || app.browsers.chromium;
        const viewport = width && height ? { width, height } : null;
        await app.browser.start({ ...target, viewport });
        return url ? app.browser.navigate(url) : app.browser.snapshot();
      }),
    },
    {
      name: 'browser_navigate',
      title: 'Go to a URL',
      description: 'Loads a URL in the active page (recorded as Go To, or New Page for the first address).',
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      handler: ({ url }) => browserCall(() => app.browser.navigate(url)),
    },
    {
      name: 'browser_back',
      title: 'Go back',
      description: "Goes back to the previous page in the active page's history (recorded as Go Back) and returns the snapshot.",
      inputSchema: { type: 'object', properties: {} },
      handler: () => browserCall(() => app.browser.history('back')),
    },
    {
      name: 'browser_forward',
      title: 'Go forward',
      description: "Goes forward in the active page's history (recorded as Go Forward) and returns the snapshot.",
      inputSchema: { type: 'object', properties: {} },
      handler: () => browserCall(() => app.browser.history('forward')),
    },
    {
      name: 'browser_reload',
      title: 'Reload',
      description: 'Reloads the active page (recorded as Reload) and returns the snapshot.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => browserCall(() => app.browser.history('reload')),
    },
    {
      name: 'browser_snapshot',
      title: 'Read the page',
      description: 'The active page as an accessibility snapshot with element refs. Refs are valid until the next snapshot.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      handler: () => browserCall(() => app.browser.snapshot()),
    },
    {
      name: 'browser_click',
      title: 'Click',
      description: 'Clicks an element.',
      inputSchema: {
        type: 'object',
        properties: {
          ref,
          button: { type: 'string', enum: ['left', 'right', 'middle'] },
          double_click: { type: 'boolean' },
          modifiers: { type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] } },
        },
        required: ['ref'],
      },
      handler: ({ ref: target, button, double_click: doubleClick, modifiers }) => browserCall(() => app.browser.click(target, { button, doubleClick, modifiers })),
    },
    {
      name: 'browser_fill',
      title: 'Fill a field',
      description: 'Replaces the value of a text field. submit: true presses Enter afterwards.',
      inputSchema: { type: 'object', properties: { ref, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['ref', 'text'] },
      handler: ({ ref: target, text, submit }) => browserCall(() => app.browser.fill(target, text, { submit })),
    },
    {
      name: 'browser_press',
      title: 'Press a key',
      description: 'Presses a key or shortcut on an element, e.g. Enter, Tab, Escape, Control+a.',
      inputSchema: { type: 'object', properties: { ref, key: { type: 'string' } }, required: ['ref', 'key'] },
      handler: ({ ref: target, key }) => browserCall(() => app.browser.press(target, key)),
    },
    {
      name: 'browser_select',
      title: 'Select options',
      description: 'Selects options of a <select> by value or label.',
      inputSchema: { type: 'object', properties: { ref, values: { type: 'array', items: { type: 'string' } } }, required: ['ref', 'values'] },
      handler: ({ ref: target, values }) => browserCall(() => app.browser.select(target, values)),
    },
    {
      name: 'browser_check',
      title: 'Check or uncheck',
      description: 'Checks or unchecks a checkbox or radio button.',
      inputSchema: { type: 'object', properties: { ref, checked: { type: 'boolean', description: 'Default true.' } }, required: ['ref'] },
      handler: ({ ref: target, checked = true }) => browserCall(() => app.browser.setChecked(target, checked)),
    },
    {
      name: 'browser_hover',
      title: 'Hover',
      description: 'Moves the mouse over an element.',
      inputSchema: { type: 'object', properties: { ref }, required: ['ref'] },
      handler: ({ ref: target }) => browserCall(() => app.browser.hover(target)),
    },
    {
      name: 'browser_assert',
      title: 'Add a check',
      description: 'Verifies an element now (waiting up to 5 seconds) and adds the matching Browser assertion to the steps: text (contains, or equals with exact), visible, value of a field, or checked state.',
      inputSchema: {
        type: 'object',
        properties: {
          ref,
          kind: { type: 'string', enum: ['text', 'visible', 'value', 'checked'] },
          text: { type: 'string', description: 'For kind text.' },
          exact: { type: 'boolean', description: 'For kind text: equal instead of contains.' },
          value: { type: 'string', description: 'For kind value.' },
          checked: { type: 'boolean', description: 'For kind checked (default true).' },
        },
        required: ['ref', 'kind'],
      },
      handler: ({ ref: target, kind, text, exact, value, checked }) => browserCall(() => app.browser.assert(target, kind, { text, exact, value, checked })),
    },
    {
      name: 'browser_wait_for',
      title: 'Wait',
      description: 'Waits for a text to appear or disappear (up to 30 seconds), or for some seconds, then returns the snapshot. Not recorded as a step.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' }, text_gone: { type: 'string' }, seconds: { type: 'number' } } },
      handler: ({ text, text_gone: textGone, seconds }) => browserCall(() => app.browser.waitFor({ text, textGone, seconds })),
    },
    {
      name: 'browser_screenshot',
      title: 'Screenshot',
      description: 'A screenshot of the active page, to check layout or images the snapshot does not describe.',
      inputSchema: { type: 'object', properties: { full_page: { type: 'boolean' } } },
      annotations: { readOnlyHint: true },
      handler: async ({ full_page: fullPage }) => [await browserCall(() => app.browser.screenshot({ fullPage }))],
    },
    {
      name: 'browser_tabs',
      title: 'Pages',
      description: 'Lists the open pages, or makes page `select` (1-based) the active one.',
      inputSchema: { type: 'object', properties: { select: { type: 'integer' } } },
      handler: ({ select }) => browserCall(() => app.browser.tabs(select)),
    },
    {
      name: 'browser_steps',
      title: 'Recorded steps',
      description: 'The Browser library steps recorded from the browser actions since browser_open, or a complete .robot test with complete: true. clear: true starts a new list from the current page.',
      inputSchema: {
        type: 'object',
        properties: {
          complete: { type: 'boolean', description: 'A complete test with settings, New Browser and New Context.' },
          test_name: { type: 'string' },
          clear: { type: 'boolean', description: 'Return the steps, then start a new list.' },
        },
      },
      handler: ({ complete = false, test_name: testName, clear = false }) => {
        const text = app.browser.steps({ complete, testName });
        if (clear)
          app.browser.clearSteps();
        return text || '(no steps recorded yet)';
      },
    },
    {
      name: 'browser_close',
      title: 'Close the browser',
      description: 'Closes the browser opened with browser_open.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        if (!app.browser.open)
          return 'The browser is not open.';
        await app.browser.close();
        return 'Browser closed.';
      },
    },
  ];
  for (const tool of tools)
    tool.inputSchema.additionalProperties ??= false;
  return tools;
}

module.exports = { createTools, RunTracker, formatRun, cleanPath, within, INSTRUCTIONS };
