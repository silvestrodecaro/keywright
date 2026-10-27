// Monaco editor integration, bundled by scripts/build.mjs into dist/editor.js.
// Exposes window.RFEditor for the (non-bundled) renderer scripts.
import * as monaco from 'monaco-editor';
import { tokenizeLine, analyzeLine, cellAt, normalizeKeyword, sectionOf } from './robotSyntax.js';
import { collectCalls, checkCall } from './argumentCheck.js';

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

monaco.editor.defineTheme('rfide-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'section.rf', foreground: 'c792ea', fontStyle: 'bold' },
    { token: 'name.rf', foreground: 'ffcb6b' },
    { token: 'setting.rf', foreground: 'c792ea' },
    { token: 'keyword.rf', foreground: '82aaff' },
    { token: 'control.rf', foreground: 'c792ea', fontStyle: 'bold' },
    { token: 'variable.rf', foreground: 'f78c6c' },
    { token: 'argument.rf', foreground: 'c3e88d' },
    { token: 'param.rf', foreground: '89ddff' },
    { token: 'operator.rf', foreground: 'ff9cac' },
    { token: 'continuation.rf', foreground: '6b7385' },
    { token: 'comment.rf', foreground: '6b7385', fontStyle: 'italic' },
  ],
  colors: {
    'editor.background': '#16181d',
    'editor.lineHighlightBackground': '#1d2027',
    'editorLineNumber.foreground': '#4b5263',
    'editorLineNumber.activeForeground': '#8a91a0',
    'editorWhitespace.foreground': '#2e3340',
    'editorIndentGuide.background1': '#262a33',
    'editorWidget.background': '#1d2027',
    'editorSuggestWidget.background': '#1d2027',
    'editorHoverWidget.background': '#1d2027',
  },
});

// ---------------------------------------------------------------------------
// Keywords: completion, hover and go to definition

const BUILTIN_SNIPPETS = [
  // Snippet syntax: a literal `$` is written `\\$`.
  ['FOR', 'FOR    \\${${1:item}}    IN    @{${2:items}}\n    $0\nEND', 'FOR loop'],
  ['FOR IN RANGE', 'FOR    \\${${1:i}}    IN RANGE    ${2:10}\n    $0\nEND', 'FOR loop over a range'],
  ['IF', 'IF    ${1:\\$condition}\n    $0\nEND', 'IF block'],
  ['IF ELSE', 'IF    ${1:\\$condition}\n    $2\nELSE\n    $0\nEND', 'IF / ELSE block'],
  ['WHILE', 'WHILE    ${1:\\$condition}\n    $0\nEND', 'WHILE loop'],
  ['TRY', 'TRY\n    $1\nEXCEPT    ${2:message}\n    $0\nEND', 'TRY / EXCEPT block'],
  ['VAR', 'VAR    \\${${1:name}}    ${2:value}', 'Create a variable'],
  ['RETURN', 'RETURN    ${1:value}', 'Return from the keyword'],
];
const SETTINGS = ['Library', 'Resource', 'Variables', 'Documentation', 'Metadata', 'Suite Setup', 'Suite Teardown',
  'Test Setup', 'Test Teardown', 'Test Template', 'Test Timeout', 'Test Tags', 'Keyword Tags'];
const TEST_SETTINGS = ['[Documentation]', '[Tags]', '[Setup]', '[Teardown]', '[Template]', '[Timeout]'];
const KEYWORD_SETTINGS = ['[Documentation]', '[Arguments]', '[Tags]', '[Setup]', '[Teardown]', '[Timeout]'];
const SECTION_HEADERS = ['*** Settings ***', '*** Variables ***', '*** Test Cases ***', '*** Tasks ***', '*** Keywords ***', '*** Comments ***'];

let keywords = [];
let byName = new Map();
let embedded = []; // [{ regex, keyword }] for keywords with embedded arguments
// False when some library could not be imported: unknown keywords are then not reported.
let keywordsComplete = false;

function setKeywords(list, { complete = true } = {}) {
  keywords = list;
  keywordsComplete = complete && list.length > 0;
  byName = new Map();
  embedded = [];
  for (const kw of list) {
    const key = normalizeKeyword(kw.name);
    if (!byName.has(key))
      byName.set(key, []);
    byName.get(key).push(kw);
    if (kw.name.includes('${')) {
      const pattern = kw.name.split(/\$\{[^}]+\}/).map((part) => normalizeKeyword(part).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+?');
      embedded.push({ regex: new RegExp(`^${pattern}$`), keyword: kw });
    }
  }
}

function findKeywords(name) {
  let text = name.trim();
  let found = byName.get(normalizeKeyword(text)) || [];
  // `Library.Keyword` and `resource.Keyword` qualified names.
  const dot = text.lastIndexOf('.');
  if (!found.length && dot > 0) {
    const library = text.slice(0, dot).toLowerCase();
    found = (byName.get(normalizeKeyword(text.slice(dot + 1))) || []).filter((kw) => kw.library.toLowerCase() === library);
  }
  if (!found.length)
    found = embedded.filter(({ regex }) => regex.test(normalizeKeyword(text))).map(({ keyword }) => keyword);
  return found;
}

function signature(kw) {
  return [kw.name, ...kw.args.map((arg) => arg.repr)].join('    ');
}

function snippetFor(kw) {
  let index = 1;
  const escape = (text) => text.replace(/[\\$}]/g, '\\$&');
  // Embedded arguments become placeholders in the name itself.
  let name = '';
  let last = 0;
  for (const match of kw.name.matchAll(/\$\{([^}:]+)(?::[^}]*)?\}/g)) {
    name += escape(kw.name.slice(last, match.index)) + `\${${index++}:${escape(match[1])}}`;
    last = match.index + match[0].length;
  }
  name += escape(kw.name.slice(last));
  const required = kw.args.filter((arg) => arg.required && (arg.kind === 'POSITIONAL_ONLY' || arg.kind === 'POSITIONAL_OR_NAMED'));
  return [name, ...required.map((arg) => `\${${index++}:${escape(arg.name)}}`)].join('    ');
}

function documentation(kw) {
  const header = `**${kw.name}** — ${kw.user ? `keyword in \`${kw.source}\`` : `${kw.library} library`}\n\n\`\`\`robotframework\n${signature(kw)}\n\`\`\``;
  const doc = kw.doc || '';
  const body = kw.docFormat === 'HTML' ? { value: doc, supportHtml: true } : { value: doc };
  return doc ? [{ value: header }, body] : [{ value: header }];
}

function sectionAt(model, lineNumber) {
  for (let line = lineNumber - 1; line >= 1; line--) {
    const section = sectionOf(model.getLineContent(line));
    if (section)
      return section;
  }
  return 'none';
}

monaco.languages.registerCompletionItemProvider(LANGUAGE, {
  triggerCharacters: ['['],
  provideCompletionItems(model, position) {
    const line = model.getLineContent(position.lineNumber);
    const before = line.slice(0, position.column - 1);
    const range = (start) => new monaco.Range(position.lineNumber, start + 1, position.lineNumber, position.column);

    if (/^\*/.test(before))
      return { suggestions: SECTION_HEADERS.map((label) => ({ label, kind: monaco.languages.CompletionItemKind.Module, insertText: label, range: range(0) })) };

    const section = sectionAt(model, position.lineNumber);
    const cell = cellAt(line, position.column - 1, section);
    if (!cell)
      return { suggestions: [] };
    const cellRange = range(cell.start);
    const { Function, Snippet, Property } = monaco.languages.CompletionItemKind;

    if (cell.type === 'setting' || (cell.text.startsWith('[') && (section === 'tests' || section === 'keywords'))) {
      const names = section === 'settings' ? SETTINGS : section === 'keywords' ? KEYWORD_SETTINGS : TEST_SETTINGS;
      return { suggestions: names.map((label) => ({ label, kind: Property, insertText: label, range: cellRange })) };
    }
    if (cell.type !== 'keyword' && cell.type !== 'control')
      return { suggestions: [] };

    const suggestions = keywords.map((kw) => ({
      label: { label: kw.name, description: kw.user ? kw.source : kw.library },
      kind: Function,
      detail: signature(kw),
      documentation: { value: kw.shortdoc || '' },
      insertText: snippetFor(kw),
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      filterText: kw.name,
      sortText: (kw.user ? '0' : kw.library === 'BuiltIn' ? '2' : '1') + kw.name,
      range: cellRange,
    }));
    if (section === 'tests' || section === 'keywords') {
      for (const [label, insertText, detail] of BUILTIN_SNIPPETS)
        suggestions.push({ label, kind: Snippet, detail, insertText, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, sortText: '3' + label, range: cellRange });
    }
    return { suggestions };
  },
});

/** The keyword cell under `position`, if any. */
function keywordCellAt(model, position) {
  const line = model.getLineContent(position.lineNumber);
  const { cells } = analyzeLine(line, sectionAt(model, position.lineNumber));
  const column = position.column - 1;
  return cells.find((cell) => cell.type === 'keyword' && column >= cell.start && column <= cell.start + cell.text.length) || null;
}

monaco.languages.registerHoverProvider(LANGUAGE, {
  provideHover(model, position) {
    const cell = keywordCellAt(model, position);
    if (!cell)
      return null;
    const found = findKeywords(cell.text);
    if (!found.length)
      return null;
    return {
      range: new monaco.Range(position.lineNumber, cell.start + 1, position.lineNumber, cell.start + cell.text.length + 1),
      contents: found.flatMap((kw, i) => (i ? [{ value: '---' }] : []).concat(documentation(kw))),
    };
  },
});

monaco.languages.registerDefinitionProvider(LANGUAGE, {
  async provideDefinition(model, position) {
    const cell = keywordCellAt(model, position);
    if (!cell)
      return null;
    const targets = findKeywords(cell.text).filter((kw) => kw.user && kw.source);
    // Monaco needs a model for the target (definition preview) before opening it.
    for (const source of new Set(targets.map((kw) => kw.source))) {
      if (!monaco.editor.getModel(uriFor(source))) {
        const file = await window.rfide.readProjectFile(source).catch(() => null);
        if (file && file.content !== null && !monaco.editor.getModel(uriFor(source)))
          monaco.editor.createModel(file.content, LANGUAGE, uriFor(source));
      }
    }
    return targets.map((kw) => ({ uri: uriFor(kw.source), range: new monaco.Range(kw.lineno, 1, kw.lineno, 1) }));
  },
});

// ---------------------------------------------------------------------------
// Diagnostics: Robot's parser (via the Python helper) and unknown keywords

const BDD_PREFIX = /^(given|when|then|and|but)\s+/i;

/** Keywords called in a cell, accepting BDD prefixes (Given/When/Then/And/But). */
function keywordsCalled(name) {
  const found = findKeywords(name);
  if (found.length || !BDD_PREFIX.test(name))
    return found;
  return findKeywords(name.replace(BDD_PREFIX, ''));
}

/** Unknown keywords (warnings) and invalid arguments (errors), checked against the keyword index. */
function keywordMarkers(model) {
  const text = model.getValue();
  // With templates the first cell of a test row is data, not a keyword.
  if (!keywordsComplete || /^(test|task) template\b|\[template\]/im.test(text))
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

async function validate(model, path) {
  if (model.isDisposed() || model.getLanguageId() !== LANGUAGE)
    return;
  monaco.editor.setModelMarkers(model, 'keywords', keywordMarkers(model));
  const version = model.getVersionId();
  const result = await window.rfide.checkFile(path, model.getValue());
  if (model.isDisposed() || model.getVersionId() !== version)
    return; // edited meanwhile: a newer check is scheduled
  monaco.editor.setModelMarkers(model, 'robot', result.problems.map((problem) => ({
    severity: problem.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
    message: problem.message,
    startLineNumber: problem.line,
    startColumn: problem.column,
    endLineNumber: problem.endLine,
    endColumn: problem.endColumn,
    source: 'Robot Framework',
  })));
}

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

  function emitDirty(path) {
    for (const listener of dirtyListeners)
      listener(path, isDirty(path));
  }

  function languageFor(path) {
    const lower = path.toLowerCase();
    const match = monaco.languages.getLanguages().find((lang) => (lang.extensions || []).some((ext) => lower.endsWith(ext.toLowerCase())));
    return match ? match.id : 'plaintext';
  }

  function isDirty(path) {
    const file = files.get(path);
    return !!file && file.model.getAlternativeVersionId() !== file.savedVersion;
  }

  function mount(container) {
    editor = monaco.editor.create(container, {
      model: null,
      theme: 'rfide-dark',
      automaticLayout: true,
      fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace',
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
    });
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

  function open(path, content, line = null) {
    if (current && files.has(current))
      files.get(current).viewState = editor.saveViewState();
    let file = files.get(path);
    if (!file) {
      // A model may already exist without a tab (created for a definition preview).
      let model = monaco.editor.getModel(uriFor(path));
      if (model)
        model.setValue(content);
      else
        model = monaco.editor.createModel(content, languageFor(path), uriFor(path));
      file = { model, savedVersion: model.getAlternativeVersionId(), viewState: null };
      files.set(path, file);
      model.onDidChangeContent(() => {
        emitDirty(path);
        scheduleValidation(path);
      });
      scheduleValidation(path, 0);
    }
    current = path;
    editor.setModel(file.model);
    if (file.viewState)
      editor.restoreViewState(file.viewState);
    if (line) {
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: 1 });
    }
    editor.focus();
    for (const listener of problemListeners)
      listener(path, problemCounts(file.model));
  }

  function close(path) {
    const file = files.get(path);
    if (!file)
      return;
    if (current === path) {
      editor.setModel(null);
      current = null;
    }
    clearTimeout(validationTimers.get(path));
    validationTimers.delete(path);
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

  function markSaved(path) {
    const file = files.get(path);
    if (file) {
      file.savedVersion = file.model.getAlternativeVersionId();
      emitDirty(path);
    }
  }

  /** Replaces the content of an open file changed on disk, unless it has unsaved edits. */
  function reload(path, content) {
    const file = files.get(path);
    if (!file || isDirty(path) || file.model.getValue() === content)
      return;
    file.model.setValue(content);
    markSaved(path);
  }

  return {
    mount,
    open,
    close,
    markSaved,
    reload,
    isDirty,
    has: (path) => files.has(path),
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
    problems: (path) => (files.has(path) ? problemCounts(files.get(path).model) : null),
    focus: () => editor && editor.focus(),
    onDirtyChange: (listener) => dirtyListeners.add(listener),
    onSave: (listener) => saveListeners.add(listener),
    onOpenRequest: (listener) => openListeners.add(listener),
    onProblems: (listener) => problemListeners.add(listener),
    startRecording,
    updateRecording,
    stopRecording,
    recordingPath: () => recording?.path ?? null,
    cursorLine: () => editor?.getPosition()?.lineNumber ?? null,
  };
})();

function uriFor(path) {
  return monaco.Uri.from({ scheme: 'rfide', path: '/' + path });
}

window.RFEditor = RFEditor;
