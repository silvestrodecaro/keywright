// Monaco editor integration, bundled by scripts/build.mjs into dist/editor.js.
// Exposes window.RFEditor for the (non-bundled) renderer scripts.
import * as monaco from 'monaco-editor';
// The UI fonts (IBM Plex, the type of the Browser library's site) ride along in dist/editor.css.
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-400-italic.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import { tokenizeLine, analyzeLine, normalizeKeyword, testCases } from './robotSyntax.js';
import { collectCalls, checkCall } from './argumentCheck.js';
import { parseFile, findVariable, lookupKeys, importCandidates, variableFileDefinitions,
  isDynamicVariableFile, unresolvedVariables, normalizeVariable } from './navigation.js';
import { invalidName, applyEdits } from './rename.js';
import { setKeywords, allKeywords, catalogComplete, findKeywords, keywordsCalled } from './keywordCatalog.js';
import { registerCompletionProvider } from './completion.js';
import { registerHoverProviders } from './hover.js';
import { createSymbols } from './symbols.js';
import { registerNavigationProviders } from './definitions.js';
import { similarNames, keywordStub, keywordInsertion, variableInsertion, endInsertion, applyInsertion, callArguments } from './quickFix.js';

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    return new Worker(label === 'json' ? 'dist/json.worker.js' : 'dist/editor.worker.js');
  },
};

const LANGUAGE = 'robotframework';

// ---------------------------------------------------------------------------
// Language: tokens, configuration and theme

monaco.languages.register({ id: LANGUAGE, extensions: ['.robot', '.resource'], aliases: ['Robot Framework'] });

class LineState {
  constructor(section) {
    this.section = section;
  }
  clone() {
    return new LineState(this.section);
  }
  equals(other) {
    return other instanceof LineState && other.section === this.section;
  }
}

monaco.languages.setTokensProvider(LANGUAGE, {
  getInitialState: () => new LineState('none'),
  tokenize(line, state) {
    const { tokens, section } = tokenizeLine(line, state.section);
    return {
      tokens: tokens.map((token) => ({ startIndex: token.start, scopes: `${token.type}.rf` })),
      endState: new LineState(section),
    };
  },
});

monaco.languages.setLanguageConfiguration(LANGUAGE, {
  comments: { lineComment: '#' },
  brackets: [['{', '}'], ['[', ']']],
  autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '"', close: '"', notIn: ['string'] }],
  folding: { offSide: true },
  wordPattern: /[^\s|]+(?: [^\s|]+)*/,
});

// Monaco measures the font when an editor is created; IBM Plex Mono may still be loading then.
document.fonts.ready.then(() => monaco.editor.remeasureFonts());

monaco.editor.defineTheme('keywright-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'section.rf', foreground: 'c9a6e9', fontStyle: 'bold' },
    { token: 'name.rf', foreground: 'e0d3a3' },
    { token: 'setting.rf', foreground: 'c9a6e9' },
    { token: 'keyword.rf', foreground: '2bd9cc' },
    { token: 'control.rf', foreground: 'c9a6e9', fontStyle: 'bold' },
    { token: 'variable.rf', foreground: 'ffb86b' },
    { token: 'argument.rf', foreground: 'b5d99c' },
    { token: 'param.rf', foreground: '9fc7d9' },
    { token: 'operator.rf', foreground: 'ff8a7e' },
    { token: 'continuation.rf', foreground: '7a868c' },
    { token: 'comment.rf', foreground: '7a868c', fontStyle: 'italic' },
  ],
  colors: {
    'editor.background': '#1c2227',
    'editor.lineHighlightBackground': '#232a30',
    'editorLineNumber.foreground': '#89979f',
    'editorLineNumber.activeForeground': '#a3afb5',
    'editorWhitespace.foreground': '#38424a',
    'editorIndentGuide.background1': '#2b333a',
    'editorWidget.background': '#232a30',
    'editorSuggestWidget.background': '#232a30',
    'editorHoverWidget.background': '#232a30',
    // Peek views (references, definitions)
    'peekView.border': '#00c0b5',
    'peekViewTitle.background': '#232a30',
    'peekViewEditor.background': '#1f262b',
    'peekViewEditorGutter.background': '#1f262b',
    'peekViewEditor.matchHighlightBackground': '#00c0b540',
    'peekViewResult.background': '#232a30',
    'peekViewResult.matchHighlightBackground': '#00c0b540',
    'peekViewResult.selectionBackground': '#38424a',
  },
});

// ---------------------------------------------------------------------------
// Keywords: completion, hover and go to definition

/** Whether the file uses test templates, where a test row's first cell is data, not a keyword. */
function usesTemplate(lines) {
  let section = 'none';
  return lines.some((line) => {
    const result = analyzeLine(line, section);
    section = result.section;
    const first = result.cells.find((cell) => cell.text && cell.type !== 'comment');
    if (!first)
      return false;
    return (section === 'settings' && /^(?:test|task) template$/i.test(first.text))
      || (section === 'tests' && /^\[template\]$/i.test(first.text));
  });
}

registerCompletionProvider(monaco, LANGUAGE);

registerHoverProviders(monaco, LANGUAGE, { modelPath, resolveVariable });

const symbols = createSymbols(monaco, { modelPath, readLines, resolveVariable, projectTree: () => window.keywright.projectTree() });
registerNavigationProviders(monaco, LANGUAGE, { modelPath, ensureModel, uriFor, firstExisting, resolveVariable, symbols });
const { renameTarget, symbolOccurrences, projectContents } = symbols;

// ---------------------------------------------------------------------------
// Project files for navigation: preview models and variable resolution
// (the providers are in definitions.js, references and rename targets in symbols.js)

function languageForPath(path) {
  const lower = path.toLowerCase();
  const match = monaco.languages.getLanguages().find((lang) => (lang.extensions || []).some((ext) => lower.endsWith(ext.toLowerCase())));
  return match ? match.id : 'plaintext';
}

function modelPath(model) {
  return model.uri.path.replace(/^\//, '');
}

// The version of each open model when its lines were last read, so a rename computed
// from them is refused if the user typed meanwhile.
const readVersions = new Map();

/** Lines of a project file: its tab's model (it may have unsaved edits), else the file on disk; null if missing. */
async function readLines(path) {
  // Only a tab's model counts: a definition preview may be older than the file on disk.
  const model = RFEditor.has(path) ? monaco.editor.getModel(uriFor(path)) : null;
  if (model) {
    readVersions.set(path, model.getVersionId());
    return model.getLinesContent();
  }
  const file = await window.keywright.readProjectFile(path).catch(() => null);
  return file && file.content !== null ? file.content.split(/\r?\n/) : null;
}

// Models created to preview a definition in a closed file (Peek, Go to Definition).
const previews = new Set();

/** Monaco needs a model for a definition's file (preview) before opening it. */
async function ensureModel(path) {
  if (monaco.editor.getModel(uriFor(path)))
    return;
  const file = await window.keywright.readProjectFile(path).catch(() => null);
  if (file && file.content !== null && !monaco.editor.getModel(uriFor(path))) {
    monaco.editor.createModel(file.content, languageForPath(path), uriFor(path));
    previews.add(path);
  }
}

/** Removes the preview models of `paths` (all when omitted) that no tab has taken over. */
function disposePreviews(paths = [...previews]) {
  for (const path of paths) {
    if (!previews.has(path))
      continue;
    previews.delete(path);
    if (RFEditor.has(path))
      continue; // opened in a tab since: the tab owns the model now
    monaco.editor.getModel(uriFor(path))?.dispose();
  }
}

/**
 * A preview changed on disk is read again in place. It is not disposed: Go to Definition
 * may be opening it at this moment, and a disposed model would leave the editor where it was.
 */
async function refreshPreviews(paths = [...previews]) {
  for (const path of paths) {
    if (!previews.has(path) || RFEditor.has(path))
      continue;
    const file = await window.keywright.readProjectFile(path).catch(() => null);
    const model = monaco.editor.getModel(uriFor(path));
    if (!model || model.isDisposed() || !previews.has(path) || RFEditor.has(path))
      continue; // opened in a tab meanwhile: the tab keeps its own content
    if (file && file.content !== null) {
      if (model.getValue() !== file.content)
        model.setValue(file.content);
    } else {
      disposePreviews([path]); // gone or unreadable: read again when next needed
    }
  }
}

window.addEventListener('keywright:files-changed', (event) => refreshPreviews(event.detail?.paths || undefined));
window.addEventListener('keywright:project-opened', () => disposePreviews());
window.addEventListener('keywright:project-closed', () => disposePreviews());

async function firstExisting(paths) {
  for (const path of paths) {
    const lines = await readLines(path);
    if (lines)
      return { path, lines };
  }
  return null;
}

/**
 * Where a variable used at `line` is defined: in the file (locals, Variables section,
 * Set ... Variable), then in its resource and variable files, recursively.
 * @returns {Promise<{ path: string, definition: object } | null>}
 */
async function resolveVariable(path, lines, name, line) {
  const parsed = parseFile(lines);
  const local = findVariable(parsed, name, line);
  if (local)
    return { path, definition: local };
  const keys = lookupKeys(name);
  const seen = new Set([path]);
  const queue = parsed.imports.filter((i) => i.type !== 'library').map((i) => ({ from: path, item: i }));
  while (queue.length) {
    const { from, item } = queue.shift();
    const target = await firstExisting(importCandidates(from, item.path));
    if (!target || seen.has(target.path))
      continue;
    seen.add(target.path);
    if (item.type === 'variables') {
      const definition = variableFileDefinitions(target.path, target.lines).find((d) => keys.includes(d.key));
      if (definition)
        return { path: target.path, definition };
      continue;
    }
    const imported = parseFile(target.lines);
    const definition = imported.variables.find((d) => keys.includes(d.key))
      || imported.locals.find((d) => d.fileWide && keys.includes(d.key));
    if (definition)
      return { path: target.path, definition };
    queue.push(...imported.imports.filter((i) => i.type !== 'library').map((i) => ({ from: target.path, item: i })));
  }
  return null;
}



// ---------------------------------------------------------------------------
// Rename (F2): user keywords and variables, across the project's files.
// Open files get the edits in the editor (unsaved, undoable); the others are written to disk.

/** Edits of a rename, by file: Map<path, { line, start, end, text }[]>. */
async function renameEdits(target, newName) {
  if (target.kind === 'keyword') {
    const existing = findKeywords(newName).filter((kw) => kw !== target.keyword && kw.user);
    if (existing.length && normalizeKeyword(newName) !== normalizeKeyword(target.keyword.name))
      throw new Error(`A keyword named '${existing[0].name}' already exists in ${existing[0].source}.`);
  }
  const occurrences = await symbolOccurrences(target, await projectContents());
  // `$name` in Python expressions must stay an identifier.
  const text = (o) => (o.expression ? newName.replace(/ /g, '_') : newName);
  return new Map([...occurrences].map(([path, list]) => [path, list.map((o) => ({ ...o, text: text(o) }))]));
}


/**
 * Applies a rename: workspace edits for open files (returned), files written to disk for the
 * others. Every closed file is read before any is written, and a failed write puts back the
 * files already written, so a rename never applies to part of the project.
 */
async function applyRename(edits) {
  const workspace = [];
  const closed = [];
  for (const [path, list] of edits) {
    const open = RFEditor.has(path) ? monaco.editor.getModel(uriFor(path)) : null;
    if (open) {
      // The version the edits were computed from: Monaco refuses them if the user typed since.
      const versionId = readVersions.get(path) ?? open.getVersionId();
      for (const edit of list) {
        workspace.push({
          resource: open.uri,
          versionId,
          textEdit: { range: new monaco.Range(edit.line, edit.start + 1, edit.line, edit.end + 1), text: edit.text },
        });
      }
      continue;
    }
    const file = await window.keywright.readProjectFile(path);
    if (file.content === null)
      throw new Error(`${path}: ${file.reason}`);
    const eol = file.content.includes('\r\n') ? '\r\n' : '\n';
    closed.push({ path, before: file.content, revision: file.revision, content: applyEdits(file.content.split(/\r?\n/), list).join(eol) });
  }
  const written = [];
  try {
    for (const file of closed) {
      const saved = await window.keywright.writeProjectFile(file.path, file.content, file.revision);
      if (!saved.ok)
        throw new Error(`${file.path} changed on disk. Reload the file and try renaming again.`);
      written.push({ ...file, revision: saved.revision });
    }
  } catch (error) {
    for (const file of written.reverse())
      await window.keywright.writeProjectFile(file.path, file.before, file.revision).catch(() => {});
    throw new Error(`${error.message} No file was changed.`);
  }
  disposePreviews(closed.map((file) => file.path));
  return { workspace, written: written.length };
}

monaco.languages.registerRenameProvider(LANGUAGE, {
  async resolveRenameLocation(model, position) {
    const target = await renameTarget(model, position);
    if (!target)
      return { rejectReason: 'Only keywords and variables can be renamed.' };
    if (target.reject)
      return { rejectReason: target.reject };
    return { range: target.range, text: target.text };
  },
  async provideRenameEdits(model, position, newName) {
    const target = await renameTarget(model, position);
    if (!target || target.reject)
      return { edits: [], rejectReason: target ? target.reject : 'Only keywords and variables can be renamed.' };
    const invalid = invalidName(newName, target.kind);
    if (invalid)
      return { edits: [], rejectReason: invalid };
    if (newName === target.text)
      return { edits: [] };
    try {
      const edits = await renameEdits(target, newName);
      const { workspace, written } = await applyRename(edits);
      const count = [...edits.values()].reduce((sum, list) => sum + list.length, 0);
      const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
      let text = `Renamed '${target.text}' to '${newName}': ${plural(count, 'occurrence')} in ${plural(edits.size, 'file')}`;
      if (written)
        text += `, ${written} saved`;
      if (workspace.length)
        text += '; open files have unsaved changes';
      window.dispatchEvent(new CustomEvent('keywright:status', { detail: { text } }));
      return { edits: workspace };
    } catch (error) {
      return { edits: [], rejectReason: error.message };
    }
  },
});

// ---------------------------------------------------------------------------
// Diagnostics: Robot's parser (via the Python helper) and unknown keywords

/** Unknown keywords (warnings) and invalid arguments (errors), checked against the keyword index. */
function keywordMarkers(model) {
  const text = model.getValue();
  // With templates the first cell of a test row is data, not a keyword.
  if (!catalogComplete() || usesTemplate(model.getLinesContent()))
    return [];
  const marker = (severity, message, cell) => ({
    severity,
    message,
    startLineNumber: cell.line,
    startColumn: cell.start + 1,
    endLineNumber: cell.line,
    endColumn: cell.start + cell.text.length + 1,
    source: 'keywords',
  });
  const markers = [];
  for (const call of collectCalls(text.split(/\r?\n/))) {
    const name = call.keyword.text;
    if (/^[$@&%]\{/.test(name) || name.toUpperCase() === 'NONE')
      continue;
    const found = keywordsCalled(name);
    if (!found.length) {
      markers.push(marker(monaco.MarkerSeverity.Warning, `No keyword with name '${name}' found.`, call.keyword));
      continue;
    }
    // Ambiguous names and embedded arguments: the signature to check is not certain.
    if (found.length > 1 || found[0].name.includes('${'))
      continue;
    for (const problem of checkCall(call, found[0]))
      markers.push(marker(monaco.MarkerSeverity.Error, problem.message, problem.cell));
  }
  return markers;
}

// Variables known across the project (see src/main/projectVariables.js), reloaded after file changes.
let projectVariablesPromise = null;

function projectVariables() {
  if (!projectVariablesPromise) {
    projectVariablesPromise = window.keywright.projectVariables()
      .then((r) => ({ runtime: new Set(r.runtime), suite: new Set(r.suite), dynamicSuite: r.dynamicSuite }))
      .catch(() => null);
  }
  return projectVariablesPromise;
}

for (const event of ['keywright:files-changed', 'keywright:file-saved', 'keywright:project-opened']) {
  window.addEventListener(event, () => {
    projectVariablesPromise = null;
    RFEditor.revalidate();
  });
}

/**
 * Variables defined by the resource and variable files a file imports (recursively).
 * `unknown`: some import cannot be read statically (missing file, path with variables,
 * module name, get_variables()), so undefined variables cannot be told apart.
 */
async function importedVariables(path, lines) {
  const keys = new Set();
  const names = []; // as written in their definitions, for suggestions
  let unknown = false;
  const seen = new Set([path]);
  const queue = parseFile(lines).imports.filter((i) => i.type !== 'library').map((i) => ({ from: path, item: i }));
  while (queue.length) {
    const { from, item } = queue.shift();
    const target = await firstExisting(importCandidates(from, item.path));
    if (!target) {
      unknown = true;
      continue;
    }
    if (seen.has(target.path))
      continue;
    seen.add(target.path);
    if (item.type === 'variables') {
      if (isDynamicVariableFile(target.path, target.lines))
        unknown = true;
      else
        variableFileDefinitions(target.path, target.lines).forEach((d) => {
          keys.add(d.key);
          names.push('${' + d.name + '}');
        });
      continue;
    }
    const imported = parseFile(target.lines);
    for (const d of [...imported.variables, ...imported.locals.filter((l) => l.fileWide)]) {
      keys.add(d.key);
      names.push(d.name);
    }
    queue.push(...imported.imports.filter((i) => i.type !== 'library').map((i) => ({ from: target.path, item: i })));
  }
  return { keys, names, unknown };
}

/** Warnings for variables defined neither in the file, its imports nor (at run time) elsewhere in the project. */
async function variableMarkers(model, path) {
  const lines = model.getLinesContent();
  const unresolved = unresolvedVariables(lines);
  if (!unresolved.length)
    return [];
  const [imported, project] = await Promise.all([importedVariables(path, lines), projectVariables()]);
  const resource = /\.resource$/i.test(path);
  if (imported.unknown || !project || (resource && project.dynamicSuite))
    return [];
  const known = (key) => imported.keys.has(key) || project.runtime.has(key) || (resource && project.suite.has(key));
  return unresolved.filter((u) => !u.keys.some(known)).map((u) => ({
    severity: monaco.MarkerSeverity.Warning,
    message: `Variable '${u.name}' is not defined in this file${resource ? ', its imports or the project\'s suites' : ' or its imports'}.`,
    startLineNumber: u.line,
    startColumn: u.start + 1,
    endLineNumber: u.line,
    endColumn: u.end + 1,
    source: 'variables',
  }));
}

// Robocop lint (style and quality rules, configured by the project's robocop.toml):
// errors become warnings, warnings and infos become infos, so they never look like Robot errors.
let lintEnabled = true;
let lintUnavailableNotified = false;

async function lintMarkers(path, text) {
  if (!lintEnabled)
    return [];
  const result = await window.keywright.lintFile(path, text);
  if (!result.available) {
    if (!lintUnavailableNotified) {
      lintUnavailableNotified = true;
      window.dispatchEvent(new CustomEvent('keywright:lint-unavailable'));
    }
    return [];
  }
  lintUnavailableNotified = false;
  return result.problems.map((problem) => ({
    severity: problem.severity === 'E' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
    message: problem.message,
    code: `${problem.rule} ${problem.name}`,
    startLineNumber: problem.line,
    startColumn: problem.column,
    endLineNumber: problem.endLine,
    endColumn: Math.max(problem.endColumn, problem.column + 1),
    source: 'robocop',
  }));
}

async function validate(model, path) {
  if (model.isDisposed() || model.getLanguageId() !== LANGUAGE)
    return;
  monaco.editor.setModelMarkers(model, 'keywords', keywordMarkers(model));
  const version = model.getVersionId();
  const text = model.getValue();
  const failed = (error) => ({ ok: false, problems: [], error: error?.message || String(error) });
  const [result, variables, lint] = await Promise.all([
    window.keywright.checkFile(path, text).catch(failed),
    variableMarkers(model, path).catch(() => []),
    lintMarkers(path, text).catch(() => []),
  ]);
  if (model.isDisposed() || model.getVersionId() !== version)
    return; // edited meanwhile: a newer check is scheduled
  monaco.editor.setModelMarkers(model, 'variables', variables);
  monaco.editor.setModelMarkers(model, 'robocop', lint);
  // No error: no Python to check with, which the project already reports elsewhere.
  monaco.editor.setModelMarkers(model, 'robot', result?.ok === false && result.error ? checkUnavailable(result.error) : robotMarkers(result));
}

/** A check that could not run (no Python, a broken environment) says so instead of finding nothing. */
function checkUnavailable(error) {
  const reason = String(error || 'The Python helper did not answer.').split('\n').slice(0, 4).join('\n');
  return [{
    severity: monaco.MarkerSeverity.Info,
    message: `Keywright could not check this file with Robot Framework: ${reason}`,
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 1,
    source: 'Keywright',
  }];
}

/** Parser problems from the Python helper (editor:check) as markers. */
function robotMarkers(result) {
  return result.problems.map((problem) => ({
    severity: problem.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
    message: problem.message,
    startLineNumber: problem.line,
    startColumn: problem.column,
    endLineNumber: problem.endLine,
    endColumn: problem.endColumn,
    source: 'Robot Framework',
  }));
}

/** All the editor's checks on the content of a file that is not open (no model needed). */
async function fileMarkers(path, text) {
  const lines = text.split(/\r?\n/);
  const document = { getValue: () => text, getLinesContent: () => lines };
  const [result, variables, lint] = await Promise.all([
    window.keywright.checkFile(path, text),
    variableMarkers(document, path).catch(() => []),
    lintMarkers(path, text).catch(() => []),
  ]);
  return [...robotMarkers(result), ...keywordMarkers(document), ...variables, ...lint];
}

function toProblem(marker) {
  return {
    severity: marker.severity === monaco.MarkerSeverity.Error ? 'error'
      : marker.severity === monaco.MarkerSeverity.Warning ? 'warning' : 'info',
    message: marker.message,
    line: marker.startLineNumber,
    column: marker.startColumn,
    source: marker.source,
    code: marker.code ? String(marker.code) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Format Document (Shift+Alt+F): Robocop's formatter with the project's Python.
// Monaco turns the whole-file edit into minimal edits, so the cursor stays put.

monaco.languages.registerDocumentFormattingEditProvider(LANGUAGE, {
  displayName: 'Robocop',
  async provideDocumentFormattingEdits(model) {
    const text = model.getValue();
    const version = model.getVersionId();
    const result = await window.keywright.formatFile(modelPath(model), text);
    if (!result.ok) {
      window.dispatchEvent(new CustomEvent('keywright:format-failed', { detail: result }));
      return [];
    }
    if (model.isDisposed() || model.getVersionId() !== version)
      return []; // edited while formatting
    const changed = result.formatted !== text;
    window.dispatchEvent(new CustomEvent('keywright:status', { detail: { text: changed ? 'Formatted with Robocop' : 'Already formatted' } }));
    return changed ? [{ range: model.getFullModelRange(), text: result.formatted }] : [];
  },
});

// ---------------------------------------------------------------------------
// Quick fixes (Ctrl+.): similar names, create keyword, define variable, add END

/** A Monaco text edit inserting `insertion` ({ afterLine, lines }) into a model. */
function insertionEdit(model, insertion) {
  const lineCount = model.getLineCount();
  if (insertion.afterLine >= lineCount) {
    const column = model.getLineMaxColumn(lineCount);
    return { range: new monaco.Range(lineCount, column, lineCount, column), text: '\n' + insertion.lines.join('\n') };
  }
  const line = insertion.afterLine + 1;
  return { range: new monaco.Range(line, 1, line, 1), text: insertion.lines.join('\n') + '\n' };
}

function quickFix(title, model, marker, edits, preferred = false) {
  return {
    title,
    kind: 'quickfix',
    diagnostics: [marker],
    isPreferred: preferred,
    edit: { edits: edits.map((textEdit) => ({ resource: model.uri, versionId: model.getVersionId(), textEdit })) },
  };
}

// Adds a keyword to a file (open: as an unsaved edit; closed: saved), then shows it.
monaco.editor.registerCommand('keywright.createKeyword', async (_accessor, { path, stub }) => {
  const model = RFEditor.has(path) ? monaco.editor.getModel(uriFor(path)) : null;
  let insertion;
  if (model) {
    insertion = keywordInsertion(model.getLinesContent(), stub);
    model.pushEditOperations([], [insertionEdit(model, insertion)], () => null);
  } else {
    const file = await window.keywright.readProjectFile(path);
    const eol = file.content.includes('\r\n') ? '\r\n' : '\n';
    const lines = file.content.split(/\r?\n/);
    insertion = keywordInsertion(lines, stub);
    const content = applyInsertion(lines, insertion).join(eol);
    const saved = await window.keywright.writeProjectFile(path, content, file.revision);
    if (!saved.ok)
      throw new Error(`${path} changed on disk. Reload the file and create the keyword again.`);
    monaco.editor.getModel(uriFor(path))?.setValue(content); // definition preview
  }
  window.dispatchEvent(new CustomEvent('keywright:open-file', { detail: { path, line: insertion.keywordLine + stub.length - 1, column: 5 } }));
  window.dispatchEvent(new CustomEvent('keywright:status', { detail: { text: `Created keyword '${stub[0]}' in ${path}` } }));
});

const BDD = /^(given|when|then|and|but)\s+/i;

async function keywordFixes(model, marker, name) {
  const actions = [];
  const path = modelPath(model);
  const lines = model.getLinesContent();
  const bdd = BDD.exec(name)?.[0] || '';
  const base = name.slice(bdd.length);
  for (const candidate of similarNames(base, [...new Set(allKeywords().map((kw) => kw.name))].filter((n) => !n.includes('${')), normalizeKeyword)) {
    actions.push(quickFix(`Change to '${candidate}'`, model, marker,
      [{ range: new monaco.Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn), text: bdd + candidate }],
      actions.length === 0));
  }
  const stub = keywordStub(base, callArguments(lines, marker.startLineNumber, marker.startColumn - 1));
  const create = (target, title) => ({ title, kind: 'quickfix', diagnostics: [marker],
    command: { id: 'keywright.createKeyword', title, arguments: [{ path: target, stub }] } });
  actions.push(create(path, `Create keyword '${base}' in this file`));
  // Resource files the file imports: the new keyword is found there too.
  for (const item of parseFile(lines).imports.filter((i) => i.type === 'resource')) {
    const target = await firstExisting(importCandidates(path, item.path));
    if (target && /\.resource$/i.test(target.path))
      actions.push(create(target.path, `Create keyword '${base}' in ${target.path}`));
  }
  return actions;
}

async function variableFixes(model, marker, name) {
  const actions = [];
  const path = modelPath(model);
  const lines = model.getLinesContent();
  const line = marker.startLineNumber;
  const parsed = parseFile(lines);
  const block = parsed.blocks.find((b) => b.line <= line && line <= b.end);
  const visible = [...parsed.variables, ...parsed.locals.filter((d) => d.fileWide || (block && d.block === block))].map((d) => d.name);
  const imported = await importedVariables(path, lines);
  const inner = (variable) => variable.slice(2, -1);
  const range = new monaco.Range(line, marker.startColumn + 2, line, marker.endColumn - 1); // the name inside ${ }
  for (const candidate of similarNames(name, [...visible, ...imported.names], (n) => normalizeVariable(n))) {
    actions.push(quickFix(`Change to ${name[0]}{${inner(candidate)}}`, model, marker, [{ range, text: inner(candidate) }], actions.length === 0));
  }
  const definition = name.startsWith('$') ? `${name}    \${EMPTY}` : name;
  actions.push(quickFix(`Define ${name} in the Variables section`, model, marker, [insertionEdit(model, variableInsertion(lines, definition))]));
  return actions;
}

// Robocop rules can be disabled with comments: `# robocop: off=rule` at the end of a line, or
// before the first section for the whole file. Rules are added to an existing disabler.
const ROBOCOP_DISABLER = /# robocop: off=[\w-]+(?:, ?[\w-]+)*/;

function robocopFixes(model, marker, rule) {
  if (!rule)
    return [];
  const disable = (line, title, preferred) => {
    const text = model.getLineContent(line);
    const existing = ROBOCOP_DISABLER.exec(text);
    if (existing) {
      const column = existing.index + existing[0].length + 1;
      return quickFix(title, model, marker, [{ range: new monaco.Range(line, column, line, column), text: `, ${rule}` }], preferred);
    }
    const end = text.trimEnd().length + 1;
    return quickFix(title, model, marker, [{ range: new monaco.Range(line, end, line, text.length + 1), text: `    # robocop: off=${rule}` }], preferred);
  };
  const actions = [disable(marker.startLineNumber, `Disable ${rule} on this line`, false)];
  if (ROBOCOP_DISABLER.test(model.getLineContent(1)) && /^#/.test(model.getLineContent(1)))
    actions.push(disable(1, `Disable ${rule} in this file`, false));
  else
    actions.push(quickFix(`Disable ${rule} in this file`, model, marker, [insertionEdit(model, { afterLine: 0, lines: [`# robocop: off=${rule}`] })]));
  return actions;
}

monaco.languages.registerCodeActionProvider(LANGUAGE, {
  async provideCodeActions(model, _range, context) {
    const actions = [];
    for (const marker of context.markers) {
      const keyword = /^No keyword with name '(.+)' found\.$/.exec(marker.message);
      const variable = /^Variable '([$@&]\{.+?\})' is not defined/.exec(marker.message);
      if (keyword)
        actions.push(...await keywordFixes(model, marker, keyword[1]));
      else if (variable)
        actions.push(...await variableFixes(model, marker, variable[1]));
      else if (marker.source === 'robocop' && marker.code)
        actions.push(...robocopFixes(model, marker, String(marker.code).split(' ')[1]));
      else if (/must have closing END/.test(marker.message))
        actions.push(quickFix('Add END', model, marker, [insertionEdit(model, endInsertion(model.getLinesContent(), marker.startLineNumber))], true));
    }
    return { actions, dispose() {} };
  },
}, { providedCodeActionKinds: ['quickfix'] });

// ---------------------------------------------------------------------------
// Editor and models

const RFEditor = (() => {
  let editor = null;
  const files = new Map(); // path -> { model, savedVersion, viewState }
  let current = null;
  const dirtyListeners = new Set();
  const saveListeners = new Set();
  const openListeners = new Set();
  const problemListeners = new Set();
  const runListeners = new Set();
  const validationTimers = new Map();

  function scheduleValidation(path, delay = 400) {
    clearTimeout(validationTimers.get(path));
    validationTimers.set(path, setTimeout(() => {
      validationTimers.delete(path);
      const file = files.get(path);
      if (file)
        validate(file.model, path);
    }, delay));
  }

  function problemCounts(model) {
    const markers = monaco.editor.getModelMarkers({ resource: model.uri });
    return {
      errors: markers.filter((m) => m.severity === monaco.MarkerSeverity.Error).length,
      warnings: markers.filter((m) => m.severity === monaco.MarkerSeverity.Warning).length,
    };
  }

  monaco.editor.onDidChangeMarkers((uris) => {
    for (const [path, file] of files) {
      if (uris.some((uri) => uri.toString() === file.model.uri.toString()))
        for (const listener of problemListeners)
          listener(path, problemCounts(file.model));
    }
  });

  // Notified on every edit (recovery copies, search); dirtyStateListeners only when a
  // file becomes modified or saved, which is all the tab strip shows.
  const dirtyStateListeners = new Set();
  const dirtyStates = new Map();

  function emitDirty(path) {
    const dirty = isDirty(path);
    for (const listener of dirtyListeners)
      listener(path, dirty);
    if (dirtyStates.get(path) !== dirty) {
      dirtyStates.set(path, dirty);
      for (const listener of dirtyStateListeners)
        listener(path, dirty);
    }
  }


  function isDirty(path) {
    const file = files.get(path);
    return !!file && file.model.getAlternativeVersionId() !== file.savedVersion;
  }

  function mount(container) {
    editor = monaco.editor.create(container, {
      model: null,
      theme: 'keywright-dark',
      automaticLayout: true,
      fontFamily: '"IBM Plex Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 21,
      tabSize: 4,
      insertSpaces: true,
      detectIndentation: false,
      renderWhitespace: 'boundary',
      minimap: { enabled: true, renderCharacters: false },
      scrollBeyondLastLine: false,
      wordBasedSuggestions: 'off',
      suggest: { showWords: false },
      fixedOverflowWidgets: true,
      padding: { top: 8 },
      glyphMargin: true,
      // The context menu's shadow root would not get the bundled stylesheet (dist/editor.css).
      useShadowDOM: false,
    });
    mountRunGlyphs();
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (current)
        for (const listener of saveListeners)
          listener(current);
    });
    // Ctrl+click / F12 on a keyword defined in another file.
    monaco.editor.registerEditorOpener({
      openCodeEditor(_source, resource, selectionOrPosition) {
        const path = resource.path.replace(/^\//, '');
        const line = selectionOrPosition && (selectionOrPosition.startLineNumber || selectionOrPosition.lineNumber);
        for (const listener of openListeners)
          listener(path, line || null);
        return true;
      },
    });
    return editor;
  }

  function open(path, content, line = null, column = 1, length = 0) {
    if (current && files.has(current))
      files.get(current).viewState = editor.saveViewState();
    let file = files.get(path);
    if (!file) {
      // A model may already exist without a tab (created for a definition preview).
      let model = monaco.editor.getModel(uriFor(path));
      if (model)
        model.setValue(content);
      else
        model = monaco.editor.createModel(content, languageForPath(path), uriFor(path));
      file = { model, savedVersion: model.getAlternativeVersionId(), viewState: null };
      files.set(path, file);
      model.onDidChangeContent(() => {
        emitDirty(path);
        scheduleValidation(path);
        if (path === current)
          scheduleGlyphs();
        if (breakpointDecorations.get(path)?.length) { // breakpoints moved with the text
          clearTimeout(breakpointTimer);
          breakpointTimer = setTimeout(emitBreakpoints, 500);
        }
      });
      scheduleValidation(path, 0);
      setBreakpointEntries(path, breakpointLines.get(path) || []);
    }
    current = path;
    editor.setModel(file.model);
    if (file.viewState)
      editor.restoreViewState(file.viewState);
    if (line) {
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: column || 1 });
      if (length)
        editor.setSelection(new monaco.Range(line, column, line, column + length));
    }
    editor.focus();
    updateGlyphs();
    if (pendingDebugLine?.path === path)
      showDebugLine(path, pendingDebugLine.line);
    for (const listener of problemListeners)
      listener(path, problemCounts(file.model));
  }

  /**
   * Problems of project files: live markers for open files (unsaved edits included),
   * the same checks on the saved content for the others.
   * @param {string[]} paths .robot/.resource files
   * @returns {Promise<{ path: string, problems: object[] }[]>}
   */
  async function projectProblems(paths) {
    const results = [];
    for (const path of paths) {
      let markers;
      if (files.has(path)) {
        markers = monaco.editor.getModelMarkers({ resource: files.get(path).model.uri });
      } else {
        const file = await window.keywright.readProjectFile(path).catch(() => null);
        if (!file || file.content === null)
          continue;
        markers = await fileMarkers(path, file.content);
      }
      const problems = markers.map(toProblem).sort((a, b) => a.line - b.line || a.column - b.column);
      results.push({ path, problems });
    }
    return results;
  }

  function close(path) {
    const file = files.get(path);
    if (!file)
      return;
    if (current === path) {
      editor.setModel(null);
      current = null;
      updateGlyphs();
    }
    clearTimeout(validationTimers.get(path));
    validationTimers.delete(path);
    const entries = breakpointsOf(path); // kept for when the file is opened again
    breakpointDecorations.delete(path);
    if (entries.length)
      breakpointLines.set(path, entries);
    else
      breakpointLines.delete(path);
    file.model.dispose();
    files.delete(path);
  }

  // -------------------------------------------------------------------------
  // Record at cursor: recorded steps replace a tracked block of whole lines.

  let recording = null; // { path, model, indent, decorations, inserted }

  function recordingRange() {
    return recording.decorations.getRange(0);
  }

  /** Starts inserting recorded steps at the cursor of the open file. */
  function startRecording(path) {
    const file = files.get(path);
    if (!file || current !== path || recording)
      return false;
    const model = file.model;
    let lineNumber = editor.getPosition().lineNumber;
    const text = model.getLineContent(lineNumber);
    // Indent like the surrounding block; a test or keyword name gets a body indentation.
    let source = text;
    for (let line = lineNumber; !source.trim() && line > 1; line--)
      source = model.getLineContent(line - 1);
    const indent = /^\s*/.exec(source)[0] || '    ';

    model.pushStackElement(); // the whole recording is a single undo step
    let inserted = false;
    if (text.trim()) {
      // Not a blank line: record into a new line below it.
      const end = model.getLineMaxColumn(lineNumber);
      model.pushEditOperations([], [{ range: new monaco.Range(lineNumber, end, lineNumber, end), text: model.getEOL() }], () => null);
      lineNumber++;
      inserted = true;
    }
    const decorations = editor.createDecorationsCollection([{
      range: new monaco.Range(lineNumber, 1, lineNumber, model.getLineMaxColumn(lineNumber)),
      options: { isWholeLine: true, className: 'recording-region', stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
    }]);
    recording = { path, model, indent, decorations, inserted, count: 0 };
    editor.updateOptions({ readOnly: true, readOnlyMessage: { value: 'Recording in progress: stop it to edit the file.' } });
    editor.revealLineInCenterIfOutsideViewport(lineNumber);
    return true;
  }

  /** Replaces the recorded block with the current steps (unindented lines). */
  function updateRecording(lines) {
    if (!recording || recording.model.isDisposed())
      return;
    const { model, indent } = recording;
    const range = recordingRange();
    const text = lines.map((l) => indent + l).join(model.getEOL());
    model.pushEditOperations([], [{ range: new monaco.Range(range.startLineNumber, 1, range.endLineNumber, model.getLineMaxColumn(range.endLineNumber)), text }], () => null);
    const endLine = range.startLineNumber + Math.max(lines.length, 1) - 1;
    recording.decorations.set([{
      range: new monaco.Range(range.startLineNumber, 1, endLine, model.getLineMaxColumn(endLine)),
      options: { isWholeLine: true, className: 'recording-region', stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
    }]);
    recording.count = lines.length;
    if (current === recording.path)
      editor.revealLineInCenterIfOutsideViewport(endLine);
  }

  /** Ends the recording; returns the number of inserted steps. */
  function stopRecording() {
    if (!recording)
      return 0;
    const { model, decorations, inserted, count, path } = recording;
    recording = null;
    editor.updateOptions({ readOnly: false });
    if (model.isDisposed())
      return 0;
    const range = decorations.getRange(0);
    decorations.clear();
    if (range && count === 0 && inserted) {
      // Nothing recorded: remove the line added for the recording.
      const previous = range.startLineNumber - 1;
      model.pushEditOperations([], [{ range: new monaco.Range(previous, model.getLineMaxColumn(previous), range.startLineNumber, model.getLineMaxColumn(range.startLineNumber)), text: '' }], () => null);
    }
    model.pushStackElement();
    if (range && count && current === path)
      editor.setPosition({ lineNumber: range.endLineNumber, column: model.getLineMaxColumn(range.endLineNumber) });
    return count;
  }

  // -------------------------------------------------------------------------
  // Run glyphs: the last status of each test (and of the file's suite) in the
  // gutter; clicking one runs it. Statuses come from the Testing panel.

  let testStates = new Map(); // path -> { suite: status, tests: Map<name, status> }
  let testsRunning = false;
  let glyphs = null;
  let glyphLines = new Map(); // line -> test names to run, or null for the whole file
  let glyphTimer = null;
  let robotFileKey = null;

  const STATUS_LABELS = { PASS: 'Passed', FAIL: 'Failed', SKIP: 'Skipped', 'NOT RUN': 'Not run', running: 'Running', queued: 'Queued', stopped: 'Stopped' };

  function escapeMarkdown(text) {
    return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
  }

  // -------------------------------------------------------------------------
  // Breakpoints (left lane of the gutter, F9) and the line where the debugger is paused.
  // Open files track their breakpoints with decorations, so they follow edits.

  const breakpointLines = new Map(); // path -> [{ line, condition }], for files that are not open
  const breakpointDecorations = new Map(); // path -> [{ id, condition }] on the open model
  const breakpointListeners = new Set();
  let breakpointTimer = null;
  let debugLine = null; // { model, ids }
  let pendingDebugLine = null; // { path, line } until the file is opened
  let conditionWidget = null;

  function breakpointDecoration({ line, condition }) {
    return {
      range: new monaco.Range(line, 1, line, 1),
      options: {
        glyphMarginClassName: 'breakpoint-glyph' + (condition ? ' is-conditional' : ''),
        glyphMargin: { position: monaco.editor.GlyphMarginLane.Left },
        glyphMarginHoverMessage: { value: condition
          ? `Breakpoint when \`${escapeMarkdown(condition)}\` · right-click to edit, click or F9 to remove`
          : 'Breakpoint · right-click to add a condition, click or F9 to remove' },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    };
  }

  /** Breakpoints as [{ line, condition }]: numbers (older saved breakpoints) are accepted too. */
  function normalizeEntries(items) {
    const byLine = new Map();
    for (const item of items || []) {
      const entry = typeof item === 'number' ? { line: item, condition: '' } : { line: item.line, condition: (item.condition || '').trim() };
      if (Number.isInteger(entry.line) && entry.line > 0)
        byLine.set(entry.line, entry);
    }
    return [...byLine.values()].sort((a, b) => a.line - b.line);
  }

  function breakpointsOf(path) {
    const model = files.get(path)?.model;
    const decorations = breakpointDecorations.get(path);
    if (model && decorations) // open: decorations follow the edits
      return normalizeEntries(decorations.map(({ id, condition }) => ({ line: model.getDecorationRange(id)?.startLineNumber, condition })));
    return normalizeEntries(breakpointLines.get(path));
  }

  function setBreakpointEntries(path, items) {
    const entries = normalizeEntries(items);
    if (entries.length)
      breakpointLines.set(path, entries);
    else
      breakpointLines.delete(path);
    const model = files.get(path)?.model;
    if (model) {
      const old = (breakpointDecorations.get(path) || []).map((d) => d.id);
      const ids = model.deltaDecorations(old, entries.map(breakpointDecoration));
      breakpointDecorations.set(path, entries.map((entry, index) => ({ id: ids[index], condition: entry.condition })));
    }
  }

  /** All breakpoints: { path: [{ line, condition? }] }. */
  function allBreakpoints() {
    const result = {};
    for (const path of new Set([...breakpointLines.keys(), ...breakpointDecorations.keys()])) {
      const entries = breakpointsOf(path).map(({ line, condition }) => (condition ? { line, condition } : { line }));
      if (entries.length)
        result[path] = entries;
    }
    return result;
  }

  function emitBreakpoints() {
    clearTimeout(breakpointTimer);
    const all = allBreakpoints();
    for (const listener of breakpointListeners)
      listener(all);
  }

  function toggleBreakpoint(path, line) {
    const entries = breakpointsOf(path);
    setBreakpointEntries(path, entries.some((e) => e.line === line) ? entries.filter((e) => e.line !== line) : [...entries, { line, condition: '' }]);
    emitBreakpoints();
  }

  /** Adds a breakpoint with a condition, or changes the condition of an existing one ('' for none). */
  function setBreakpointCondition(path, line, condition) {
    setBreakpointEntries(path, [...breakpointsOf(path).filter((e) => e.line !== line), { line, condition }]);
    emitBreakpoints();
  }

  /** Replaces all breakpoints (e.g. restored for a project). */
  /** Follows a rename: `moved(path)` gives a file's new path, or null when it did not move. */
  function moveBreakpoints(moved) {
    let changed = false;
    for (const path of new Set([...breakpointLines.keys(), ...breakpointDecorations.keys()])) {
      const next = moved(path);
      if (!next || next === path)
        continue;
      const entries = breakpointsOf(path);
      setBreakpointEntries(path, []);
      setBreakpointEntries(next, entries);
      changed = true;
    }
    if (changed)
      emitBreakpoints();
  }

  function setBreakpoints(all) {
    for (const path of new Set([...breakpointLines.keys(), ...breakpointDecorations.keys(), ...Object.keys(all)]))
      setBreakpointEntries(path, all[path] || []);
  }

  function closeConditionWidget() {
    if (conditionWidget)
      editor.removeContentWidget(conditionWidget);
    conditionWidget = null;
  }

  /** An input below the line to add or edit a breakpoint's condition (Enter applies, Escape cancels). */
  function editBreakpointCondition(line) {
    const path = current;
    if (!path || files.get(path)?.model.getLanguageId() !== LANGUAGE)
      return;
    closeConditionWidget();
    const entry = breakpointsOf(path).find((e) => e.line === line);
    const input = Object.assign(document.createElement('input'), {
      type: 'text',
      value: entry?.condition || '',
      spellcheck: false,
      placeholder: 'Stop when… e.g. $i == 5 or $status == "FAIL" (Enter; empty: always)',
    });
    const node = document.createElement('div');
    node.className = 'breakpoint-condition';
    node.append(Object.assign(document.createElement('span'), { textContent: `Line ${line}` }), input);
    conditionWidget = {
      getId: () => 'keywright.breakpointCondition',
      getDomNode: () => node,
      getPosition: () => ({ position: { lineNumber: line, column: 1 }, preference: [monaco.editor.ContentWidgetPositionPreference.BELOW] }),
    };
    editor.addContentWidget(conditionWidget);
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key !== 'Enter' && event.key !== 'Escape')
        return;
      // No default action, and focus the editor after the event: otherwise the Enter reaches it.
      event.preventDefault();
      if (event.key === 'Enter')
        setBreakpointCondition(path, line, input.value.trim());
      closeConditionWidget();
      setTimeout(() => editor.focus(), 0);
    });
    input.addEventListener('blur', () => setTimeout(closeConditionWidget, 0));
    setTimeout(() => input.focus(), 0);
  }

  /** Highlights the line where the debugger is paused (the file must be open). */
  function showDebugLine(path, line) {
    clearDebugLine();
    const model = files.get(path)?.model;
    pendingDebugLine = model ? null : { path, line };
    if (!model)
      return;
    const ids = model.deltaDecorations([], [{
      range: new monaco.Range(line, 1, line, 1),
      options: { isWholeLine: true, className: 'debug-current-line', linesDecorationsClassName: 'debug-current-arrow' },
    }]);
    debugLine = { model, ids };
    if (current === path)
      editor.revealLineInCenterIfOutsideViewport(line);
  }

  function clearDebugLine() {
    pendingDebugLine = null;
    if (debugLine && !debugLine.model.isDisposed())
      debugLine.model.deltaDecorations(debugLine.ids, []);
    debugLine = null;
  }

  function glyph(line, status, action, running) {
    const parts = [status ? `**${STATUS_LABELS[status] || status}**` : null,
      running ? 'Tests are running' : `Click to run ${action}`].filter(Boolean);
    return {
      range: new monaco.Range(line, 1, line, 1),
      options: {
        glyphMarginClassName: `test-glyph status-${String(status || 'none').toLowerCase().replace(/\s+/g, '-')}`,
        glyphMargin: { position: monaco.editor.GlyphMarginLane.Right }, // breakpoints use the left lane
        glyphMarginHoverMessage: { value: parts.join(' · ') },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    };
  }

  function isRobotFile() {
    return !!current && /\.robot$/i.test(current);
  }

  function updateGlyphs() {
    clearTimeout(glyphTimer);
    glyphLines = new Map();
    robotFileKey?.set(isRobotFile());
    const model = editor?.getModel();
    if (!glyphs)
      return;
    if (!model || !isRobotFile()) {
      glyphs.clear();
      return;
    }
    const state = testStates.get(current) || { suite: null, tests: new Map() };
    const { headers, tests } = testCases(model.getLinesContent());
    const decorations = [];
    for (const line of headers) {
      glyphLines.set(line, null);
      decorations.push(glyph(line, state.suite, 'all tests in this file', testsRunning));
    }
    for (const test of tests) {
      glyphLines.set(test.line, [test.name]);
      decorations.push(glyph(test.line, state.tests.get(test.name), `'${escapeMarkdown(test.name)}'`, testsRunning));
    }
    glyphs.set(decorations);
  }

  function scheduleGlyphs() {
    clearTimeout(glyphTimer);
    glyphTimer = setTimeout(updateGlyphs, 150);
  }

  /** @param {string[] | null} names tests to run, or null for every test of the file */
  function requestRun(names) {
    if (!isRobotFile())
      return;
    for (const listener of runListeners)
      listener({ path: current, names });
  }

  function testAtCursor() {
    const line = editor.getPosition()?.lineNumber;
    const model = editor.getModel();
    if (!line || !model)
      return null;
    return testCases(model.getLinesContent()).tests.find((test) => test.line <= line && line <= test.end) || null;
  }

  function mountRunGlyphs() {
    glyphs = editor.createDecorationsCollection();
    robotFileKey = editor.createContextKey('keywrightRobotFile', false);
    editor.onMouseDown((event) => {
      if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !event.event.leftButton)
        return;
      const line = event.target.position?.lineNumber;
      if (!line)
        return;
      if (glyphLines.has(line) && event.target.element?.classList.contains('test-glyph'))
        requestRun(glyphLines.get(line));
      else if (current && files.get(current)?.model.getLanguageId() === LANGUAGE)
        toggleBreakpoint(current, line);
    });
    editor.onContextMenu((event) => {
      const type = event.target.type;
      if (type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && type !== monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS)
        return;
      if (event.target.position)
        editBreakpointCondition(event.target.position.lineNumber);
    });
    editor.addAction({
      id: 'keywright.conditionalBreakpoint',
      label: 'Add Conditional Breakpoint…',
      contextMenuGroupId: '1_debug',
      contextMenuOrder: 1,
      run: () => {
        const line = editor.getPosition()?.lineNumber;
        if (line)
          editBreakpointCondition(line);
      },
    });
    editor.addCommand(monaco.KeyCode.F9, () => {
      const line = editor.getPosition()?.lineNumber;
      if (line && current && files.get(current)?.model.getLanguageId() === LANGUAGE)
        toggleBreakpoint(current, line);
    });
    editor.addAction({
      id: 'keywright.runTestAtCursor',
      label: 'Run Test at Cursor',
      precondition: 'keywrightRobotFile',
      contextMenuGroupId: '0_run',
      contextMenuOrder: 1,
      run: () => {
        const test = testAtCursor();
        if (test)
          requestRun([test.name]);
      },
    });
    editor.addAction({
      id: 'keywright.runTestsInFile',
      label: 'Run Tests in File',
      precondition: 'keywrightRobotFile',
      contextMenuGroupId: '0_run',
      contextMenuOrder: 2,
      run: () => requestRun(null),
    });
  }

  /**
   * Statuses shown in the gutter.
   * @param {Map<string, { suite: string | null, tests: Map<string, string> }>} states by file path
   * @param {boolean} running whether a run is in progress
   */
  function setTestStates(states, running) {
    testStates = states;
    testsRunning = running;
    updateGlyphs();
  }

  /**
   * Inserts a cell at the cursor, with a separator when it would join the text before it.
   * @returns {boolean} false when no file is shown or it is read-only
   */
  function insertCell(text) {
    const model = editor?.getModel();
    const position = editor?.getPosition();
    if (!model || !position || recording)
      return false;
    const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
    const separator = before === '' || /( {2,}|\t)$/.test(before) ? '' : before.endsWith(' ') ? '   ' : '    ';
    const range = new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);
    editor.pushUndoStop();
    editor.executeEdits('keywright-pick', [{ range, text: separator + text, forceMoveMarkers: true }]);
    editor.pushUndoStop();
    editor.focus();
    return true;
  }

  function markSaved(path, version = files.get(path)?.model.getAlternativeVersionId()) {
    const file = files.get(path);
    if (file) {
      file.savedVersion = version;
      emitDirty(path);
    }
  }

  /** Replaces the content of an open file changed on disk, unless it has unsaved edits. */
  function reload(path, content, { discardChanges = false } = {}) {
    const file = files.get(path);
    if (!file || (!discardChanges && isDirty(path)))
      return false;
    if (file.model.getValue() === content) {
      if (discardChanges)
        markSaved(path);
      return true;
    }
    file.model.setValue(content);
    markSaved(path);
    return true;
  }

  /** Puts recovered unsaved content into an open file as one undoable edit, leaving it unsaved. */
  function restoreContent(path, content) {
    const model = files.get(path)?.model;
    if (!model || model.getValue() === content)
      return false;
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null);
    return true;
  }

  /**
   * Side-by-side comparison of the disk version (left, read-only) with the editor
   * version (right, editable) of a file whose save conflicted.
   */
  function createComparison(container, { path, disk, mine, readOnly = false, focus = true }) {
    const language = languageForPath(path);
    const stamp = Date.now();
    const original = monaco.editor.createModel(disk, language, monaco.Uri.from({ scheme: 'keywright-compare', path: `/${stamp}/disk/${path}` }));
    const modified = monaco.editor.createModel(mine, language, monaco.Uri.from({ scheme: 'keywright-compare', path: `/${stamp}/mine/${path}` }));
    const diff = monaco.editor.createDiffEditor(container, {
      theme: 'keywright-dark',
      automaticLayout: true,
      fontFamily: '"IBM Plex Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 21,
      renderSideBySide: true,
      // The labels above name the two sides, so narrow windows must not switch to the inline view.
      useInlineViewWhenSpaceIsLimited: false,
      originalEditable: false,
      readOnly,
      ignoreTrimWhitespace: false,
      renderOverviewRuler: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      useShadowDOM: false,
    });
    diff.setModel({ original, modified });
    if (focus)
      diff.getModifiedEditor().focus();
    return {
      content: () => modified.getValue(),
      dispose() {
        diff.dispose();
        original.dispose();
        modified.dispose();
      },
    };
  }

  return {
    mount,
    open,
    close,
    markSaved,
    reload,
    restoreContent,
    createComparison,
    isDirty,
    has: (path) => files.has(path),
    snapshot: (path) => ({ content: files.get(path).model.getValue(), version: files.get(path).model.getAlternativeVersionId() }),
    getContent: (path) => files.get(path)?.model.getValue() ?? null,
    dirtyPaths: () => [...files.keys()].filter(isDirty),
    setKeywords(list, options) {
      setKeywords(list, options);
      for (const file of files.values())
        if (file.model.getLanguageId() === LANGUAGE)
          monaco.editor.setModelMarkers(file.model, 'keywords', keywordMarkers(file.model));
    },
    /** Re-runs the syntax check of open files (e.g. after the project's Python changed). */
    revalidate: () => files.forEach((_, path) => scheduleValidation(path, 0)),
    /** Turns Robocop lint on or off (open files are checked again). */
    setLintEnabled(enabled) {
      lintEnabled = enabled;
      lintUnavailableNotified = false;
      files.forEach((_, path) => scheduleValidation(path, 0));
    },
    problems: (path) => (files.has(path) ? problemCounts(files.get(path).model) : null),
    projectProblems,
    openPaths: () => [...files.keys()],
    formatDocument: () => editor?.getAction('editor.action.formatDocument')?.run(),
    /** Focuses the editor and runs one of its actions; false when it is unavailable here. */
    runAction(id) {
      const action = editor?.getModel() ? editor.getAction(id) : null;
      if (!action || !action.isSupported())
        return false;
      editor.focus();
      action.run();
      return true;
    },
    isRobotFile: () => isRobotFile(),
    /** Replaces search matches ({ line, column, length, replacement }) in an open file, as one undoable edit. */
    replaceMatches(path, matches) {
      const model = files.get(path)?.model;
      if (!model || !matches.length)
        return 0;
      model.pushStackElement();
      model.pushEditOperations([], matches.map((m) => ({
        range: new monaco.Range(m.line, m.column, m.line, m.column + m.length),
        text: m.replacement,
      })), () => null);
      model.pushStackElement();
      return matches.length;
    },
    selectedText: () => {
      const selection = editor?.getSelection();
      return selection && editor.getModel() ? editor.getModel().getValueInRange(selection) : '';
    },
    focus: () => editor && editor.focus(),
    onDirtyChange: (listener) => dirtyListeners.add(listener),
    onDirtyStateChange: (listener) => dirtyStateListeners.add(listener),
    moveBreakpoints,
    onSave: (listener) => saveListeners.add(listener),
    onOpenRequest: (listener) => openListeners.add(listener),
    onProblems: (listener) => problemListeners.add(listener),
    onRunTests: (listener) => runListeners.add(listener),
    breakpoints: allBreakpoints,
    setBreakpoints,
    toggleBreakpoint,
    onBreakpointsChange: (listener) => breakpointListeners.add(listener),
    showDebugLine,
    clearDebugLine,
    setTestStates,
    startRecording,
    updateRecording,
    stopRecording,
    recordingPath: () => recording?.path ?? null,
    cursorLine: () => editor?.getPosition()?.lineNumber ?? null,
    currentPath: () => current,
    insertCell,
  };
})();

function uriFor(path) {
  return monaco.Uri.from({ scheme: 'keywright', path: '/' + path });
}

window.RFEditor = RFEditor;
