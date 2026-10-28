// Monaco editor integration, bundled by scripts/build.mjs into dist/editor.js.
// Exposes window.RFEditor for the (non-bundled) renderer scripts.
import * as monaco from 'monaco-editor';
import { tokenizeLine, analyzeLine, cellAt, normalizeKeyword, sectionOf, testCases } from './robotSyntax.js';
import { collectCalls, checkCall } from './argumentCheck.js';
import { parseFile, findVariable, variableAt, isBuiltinVariable, lookupKeys, importCandidates, variableFileDefinitions, outline,
  isDynamicVariableFile, unresolvedVariables, normalizeVariable } from './navigation.js';
import { keywordPart, keywordOccurrences, variablePart, variableOccurrences, invalidName, applyEdits } from './rename.js';
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
    // Peek views (references, definitions)
    'peekView.border': '#00b0a0',
    'peekViewTitle.background': '#1d2027',
    'peekViewEditor.background': '#1a1c22',
    'peekViewEditorGutter.background': '#1a1c22',
    'peekViewEditor.matchHighlightBackground': '#00b0a040',
    'peekViewResult.background': '#1d2027',
    'peekViewResult.matchHighlightBackground': '#00b0a040',
    'peekViewResult.selectionBackground': '#2e3340',
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
    for (const source of new Set(targets.map((kw) => kw.source)))
      await ensureModel(source);
    return targets.map((kw) => ({ uri: uriFor(kw.source), range: new monaco.Range(kw.lineno, 1, kw.lineno, 1) }));
  },
});

// ---------------------------------------------------------------------------
// Navigation: outline (Ctrl+Shift+O), imported files and variable definitions

function languageForPath(path) {
  const lower = path.toLowerCase();
  const match = monaco.languages.getLanguages().find((lang) => (lang.extensions || []).some((ext) => lower.endsWith(ext.toLowerCase())));
  return match ? match.id : 'plaintext';
}

function modelPath(model) {
  return model.uri.path.replace(/^\//, '');
}

/** Lines of a project file: its model when open (it may have unsaved edits), else the file on disk; null if missing. */
async function readLines(path) {
  const model = monaco.editor.getModel(uriFor(path));
  if (model)
    return model.getLinesContent();
  const file = await window.rfide.readProjectFile(path).catch(() => null);
  return file && file.content !== null ? file.content.split(/\r?\n/) : null;
}

/** Monaco needs a model for a definition's file (preview) before opening it. */
async function ensureModel(path) {
  if (monaco.editor.getModel(uriFor(path)))
    return;
  const file = await window.rfide.readProjectFile(path).catch(() => null);
  if (file && file.content !== null && !monaco.editor.getModel(uriFor(path)))
    monaco.editor.createModel(file.content, languageForPath(path), uriFor(path));
}

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

monaco.languages.registerDocumentSymbolProvider(LANGUAGE, {
  displayName: 'Robot Framework',
  provideDocumentSymbols(model) {
    const { SymbolKind } = monaco.languages;
    const kinds = { section: SymbolKind.Namespace, test: SymbolKind.Method, keyword: SymbolKind.Function, variable: SymbolKind.Variable,
      resource: SymbolKind.File, variables: SymbolKind.File, library: SymbolKind.Module };
    const symbol = (item) => {
      const end = Math.max(item.end, item.line);
      return {
        name: item.name,
        detail: '',
        kind: kinds[item.kind],
        tags: [],
        range: new monaco.Range(item.line, 1, end, model.getLineMaxColumn(end)),
        selectionRange: new monaco.Range(item.line, 1, item.line, model.getLineMaxColumn(item.line)),
        children: (item.children || []).map(symbol),
      };
    };
    return outline(model.getLinesContent()).map(symbol);
  },
});

// Ctrl+click / F12 on an imported file or on a variable.
monaco.languages.registerDefinitionProvider(LANGUAGE, {
  async provideDefinition(model, position) {
    const path = modelPath(model);
    const lines = model.getLinesContent();
    const line = position.lineNumber;
    const offset = position.column - 1;
    const item = parseFile(lines).imports.find((i) => i.line === line && i.start <= offset && offset <= i.end);
    if (item) {
      const target = await firstExisting(importCandidates(path, item.path));
      if (!target)
        return null;
      await ensureModel(target.path);
      return [{
        uri: uriFor(target.path),
        range: new monaco.Range(1, 1, 1, 1),
        originSelectionRange: new monaco.Range(line, item.start + 1, line, item.end + 1),
      }];
    }
    const variable = variableAt(lines[line - 1], offset);
    if (!variable || variable.name.startsWith('%') || isBuiltinVariable(variable.name))
      return null;
    const found = await resolveVariable(path, lines, variable.name, line);
    if (!found)
      return null;
    await ensureModel(found.path);
    const d = found.definition;
    return [{
      uri: uriFor(found.path),
      range: new monaco.Range(d.line, d.start + 1, d.line, d.end + 1),
      originSelectionRange: new monaco.Range(line, variable.start + 1, line, variable.end + 1),
    }];
  },
});

monaco.languages.registerHoverProvider(LANGUAGE, {
  async provideHover(model, position) {
    const line = position.lineNumber;
    const variable = variableAt(model.getLineContent(line), position.column - 1);
    if (!variable)
      return null;
    const range = new monaco.Range(line, variable.start + 1, line, variable.end + 1);
    const name = '`' + variable.name + '`';
    if (variable.name.startsWith('%'))
      return { range, contents: [{ value: `${name} environment variable` }] };
    if (isBuiltinVariable(variable.name))
      return { range, contents: [{ value: `${name} built-in variable` }] };
    const path = modelPath(model);
    const found = await resolveVariable(path, model.getLinesContent(), variable.name, line);
    if (!found)
      return { range, contents: [{ value: `${name} is not defined in this file or in its resource and variable files (it may come from the command line or a library)` }] };
    const d = found.definition;
    const where = found.path === path ? `line ${d.line}` : `${found.path}:${d.line}`;
    const how = d.how === 'assignment' && d.from ? 'assigned from `' + d.from + '`' : d.how;
    const value = d.values && d.values.length ? '\n\n```\n' + [d.name, ...d.values].join('    ') + '\n```' : '';
    return { range, contents: [{ value: `**${d.name}**: ${how} (${where})${value}` }] };
  },
});

// ---------------------------------------------------------------------------
// Rename (F2): user keywords and variables, across the project's files.
// Open files get the edits in the editor (unsaved, undoable); the others are written to disk.

async function projectRobotFiles() {
  const flatten = (nodes) => nodes.flatMap((node) => (node.type === 'dir' ? flatten(node.children || [])
    : /\.(robot|resource)$/i.test(node.path) ? [node.path] : []));
  return flatten(await window.rfide.projectTree());
}

/** The files that import `target` (directly or through other resources), `target` included. */
function filesImporting(target, contents) {
  const importsOf = new Map([...contents].map(([path, lines]) => [path, parseFile(lines).imports
    .filter((item) => item.type !== 'library')
    .map((item) => importCandidates(path, item.path).find((candidate) => contents.has(candidate) || candidate === target))
    .filter(Boolean)]));
  const reaches = (path, seen = new Set()) => {
    if (path === target)
      return true;
    if (seen.has(path))
      return false;
    seen.add(path);
    return (importsOf.get(path) || []).some((next) => reaches(next, seen));
  };
  return [...contents.keys()].filter((path) => reaches(path));
}

/** What F2 at `position` renames: { kind, range, text, ... }, { reject } or null. */
async function renameTarget(model, position) {
  const path = modelPath(model);
  const lines = model.getLinesContent();
  const line = position.lineNumber;
  const offset = position.column - 1;

  const variable = variableAt(lines[line - 1], offset);
  if (variable) {
    if (variable.name.startsWith('%') || isBuiltinVariable(variable.name))
      return { reject: 'Built-in and environment variables cannot be renamed.' };
    const found = await resolveVariable(path, lines, variable.name, line);
    if (!found)
      return { reject: `No definition of ${variable.name} was found in this file or its imports.` };
    const definition = found.definition;
    const part = variablePart(variable.name, definition.key);
    if (!part)
      return { reject: `${variable.name} cannot be renamed here.` };
    return {
      kind: 'variable',
      definition,
      definitionPath: found.path,
      range: new monaco.Range(line, variable.start + part.start + 1, line, variable.start + part.end + 1),
      text: variable.name.slice(part.start, part.end),
      // References are found, but the definition is not in a Robot file.
      reject: definition.how === 'variable file' ? `${variable.name} is defined in the variable file ${found.path}: rename it there.` : undefined,
    };
  }

  const section = sectionAt(model, line);
  const cell = analyzeLine(lines[line - 1], section).cells.find((c) => (c.type === 'keyword' || (c.type === 'name' && section === 'keywords'))
    && offset >= c.start && offset <= c.start + c.text.length);
  if (!cell)
    return null;
  const candidates = cell.type === 'name'
    ? keywords.filter((kw) => kw.user && kw.source === path && normalizeKeyword(kw.name) === normalizeKeyword(cell.text))
    : keywordsCalled(cell.text);
  const userKeywords = candidates.filter((kw) => kw.user && kw.source);
  if (!userKeywords.length) {
    if (candidates.length !== 1 || candidates[0].name.includes('${'))
      return { reject: candidates.length ? `'${cell.text}' matches ${candidates.length} library keywords.` : `No keyword named '${cell.text}' was found.` };
    // A library keyword: its calls can be listed (references), not renamed.
    const part = keywordPart(cell.text, candidates[0]);
    return part && {
      kind: 'keyword',
      keyword: candidates[0],
      range: new monaco.Range(line, cell.start + part.start + 1, line, cell.start + part.end + 1),
      text: cell.text.slice(part.start, part.end),
      reject: `'${cell.text}' comes from the ${candidates[0].library} library: only keywords defined in the project can be renamed.`,
    };
  }
  const keyword = userKeywords[0];
  const sameName = keywords.filter((kw) => kw.user && normalizeKeyword(kw.name) === normalizeKeyword(keyword.name));
  if (sameName.length > 1)
    return { reject: `${sameName.length} keywords are named '${keyword.name}' (${sameName.map((kw) => kw.source).join(', ')}): rename is ambiguous.` };
  if (keyword.name.includes('${'))
    return { reject: 'Keywords with embedded arguments cannot be renamed.' };
  const part = cell.type === 'name' ? { start: 0, end: cell.text.length } : keywordPart(cell.text, keyword);
  if (!part)
    return null;
  return {
    kind: 'keyword',
    keyword,
    range: new monaco.Range(line, cell.start + part.start + 1, line, cell.start + part.end + 1),
    text: cell.text.slice(part.start, part.end),
  };
}

/** Lines of every .robot/.resource file of the project (open files with their unsaved edits). */
async function projectContents() {
  const contents = new Map();
  for (const path of await projectRobotFiles()) {
    const lines = await readLines(path);
    if (lines)
      contents.set(path, lines);
  }
  return contents;
}

/**
 * Where the keyword or variable of `target` (from renameTarget) occurs, by file:
 * Map<path, { line, start, end, expression? }[]>.
 */
async function symbolOccurrences(target, contents) {
  const occurrences = new Map();
  const add = (path, list) => {
    if (list.length)
      occurrences.set(path, list);
  };

  if (target.kind === 'keyword') {
    const keyword = target.keyword;
    const scope = !keyword.user ? [...contents.keys()]
      : /\.resource$/i.test(keyword.source) ? filesImporting(keyword.source, contents) : [keyword.source];
    for (const path of scope.filter((p) => contents.has(p)))
      add(path, keywordOccurrences(contents.get(path), keyword, { definition: keyword.user && path === keyword.source }));
    return occurrences;
  }

  const { definition, definitionPath } = target;
  const sameDefinition = (other) => !!other && other.line === definition.line && other.start === definition.start;
  const local = !!definition.block && !definition.fileWide;
  const scope = local ? [definitionPath] : filesImporting(definitionPath, contents);
  for (const path of scope.filter((p) => contents.has(p))) {
    const lines = contents.get(path);
    const parsed = parseFile(lines);
    // Other files see the variable through their imports, unless they define it themselves.
    let imported = false;
    if (path !== definitionPath) {
      const found = await resolveVariable(path, lines, definition.name, 0);
      imported = !!found && found.path === definitionPath && sameDefinition(found.definition);
    }
    const accept = (name, line) => {
      const own = findVariable(parsed, name, line);
      return path === definitionPath ? sameDefinition(own) : !own && imported;
    };
    add(path, variableOccurrences(lines, definition.key, accept));
  }
  return occurrences;
}

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

// Shift+F12: references of a keyword (library ones too) or a variable.
monaco.languages.registerReferenceProvider(LANGUAGE, {
  async provideReferences(model, position, context) {
    const target = await renameTarget(model, position);
    if (!target || !target.kind)
      return [];
    const occurrences = await symbolOccurrences(target, await projectContents());
    const isDefinition = (path, o) => (target.kind === 'keyword'
      ? target.keyword.user && path === target.keyword.source && o.line === target.keyword.lineno
      : path === target.definitionPath && o.line === target.definition.line && o.start === target.definition.start + 2);
    const locations = [];
    for (const [path, list] of occurrences) {
      await ensureModel(path); // the peek view shows the lines of every file
      for (const o of list) {
        if (context.includeDeclaration || !isDefinition(path, o))
          locations.push({ uri: uriFor(path), range: new monaco.Range(o.line, o.start + 1, o.line, o.end + 1) });
      }
    }
    // Variable files are not Robot files: add their definition.
    if (context.includeDeclaration && target.kind === 'variable' && target.definition.how === 'variable file') {
      const d = target.definition;
      await ensureModel(target.definitionPath);
      locations.unshift({ uri: uriFor(target.definitionPath), range: new monaco.Range(d.line, d.start + 1, d.line, d.end + 1) });
    }
    return locations;
  },
});

/** Applies a rename: workspace edits for open files (returned), files written to disk for the others. */
async function applyRename(edits) {
  const workspace = [];
  let written = 0;
  for (const [path, list] of edits) {
    const open = RFEditor.has(path) ? monaco.editor.getModel(uriFor(path)) : null;
    if (open) {
      for (const edit of list) {
        workspace.push({
          resource: open.uri,
          versionId: open.getVersionId(),
          textEdit: { range: new monaco.Range(edit.line, edit.start + 1, edit.line, edit.end + 1), text: edit.text },
        });
      }
      continue;
    }
    const file = await window.rfide.readProjectFile(path);
    const eol = file.content.includes('\r\n') ? '\r\n' : '\n';
    const content = applyEdits(file.content.split(/\r?\n/), list).join(eol);
    await window.rfide.writeProjectFile(path, content);
    const preview = monaco.editor.getModel(uriFor(path)); // definition preview of a closed file
    if (preview)
      preview.setValue(content);
    written++;
  }
  return { workspace, written };
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
      window.dispatchEvent(new CustomEvent('rfide:status', { detail: { text } }));
      return { edits: workspace };
    } catch (error) {
      return { edits: [], rejectReason: error.message };
    }
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

// Variables known across the project (see src/main/projectVariables.js), reloaded after file changes.
let projectVariablesPromise = null;

function projectVariables() {
  if (!projectVariablesPromise) {
    projectVariablesPromise = window.rfide.projectVariables()
      .then((r) => ({ runtime: new Set(r.runtime), suite: new Set(r.suite), dynamicSuite: r.dynamicSuite }))
      .catch(() => null);
  }
  return projectVariablesPromise;
}

for (const event of ['rfide:files-changed', 'rfide:file-saved', 'rfide:project-opened']) {
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

async function validate(model, path) {
  if (model.isDisposed() || model.getLanguageId() !== LANGUAGE)
    return;
  monaco.editor.setModelMarkers(model, 'keywords', keywordMarkers(model));
  const version = model.getVersionId();
  const [result, variables] = await Promise.all([
    window.rfide.checkFile(path, model.getValue()),
    variableMarkers(model, path).catch(() => []),
  ]);
  if (model.isDisposed() || model.getVersionId() !== version)
    return; // edited meanwhile: a newer check is scheduled
  monaco.editor.setModelMarkers(model, 'variables', variables);
  monaco.editor.setModelMarkers(model, 'robot', robotMarkers(result));
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
  const [result, variables] = await Promise.all([
    window.rfide.checkFile(path, text),
    variableMarkers(document, path).catch(() => []),
  ]);
  return [...robotMarkers(result), ...keywordMarkers(document), ...variables];
}

function toProblem(marker) {
  return {
    severity: marker.severity === monaco.MarkerSeverity.Error ? 'error' : 'warning',
    message: marker.message,
    line: marker.startLineNumber,
    column: marker.startColumn,
    source: marker.source,
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
    const result = await window.rfide.formatFile(modelPath(model), text);
    if (!result.ok) {
      window.dispatchEvent(new CustomEvent('rfide:format-failed', { detail: result }));
      return [];
    }
    if (model.isDisposed() || model.getVersionId() !== version)
      return []; // edited while formatting
    const changed = result.formatted !== text;
    window.dispatchEvent(new CustomEvent('rfide:status', { detail: { text: changed ? 'Formatted with Robocop' : 'Already formatted' } }));
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
monaco.editor.registerCommand('rfide.createKeyword', async (_accessor, { path, stub }) => {
  const model = RFEditor.has(path) ? monaco.editor.getModel(uriFor(path)) : null;
  let insertion;
  if (model) {
    insertion = keywordInsertion(model.getLinesContent(), stub);
    model.pushEditOperations([], [insertionEdit(model, insertion)], () => null);
  } else {
    const file = await window.rfide.readProjectFile(path);
    const eol = file.content.includes('\r\n') ? '\r\n' : '\n';
    const lines = file.content.split(/\r?\n/);
    insertion = keywordInsertion(lines, stub);
    const content = applyInsertion(lines, insertion).join(eol);
    await window.rfide.writeProjectFile(path, content);
    monaco.editor.getModel(uriFor(path))?.setValue(content); // definition preview
  }
  window.dispatchEvent(new CustomEvent('rfide:open-file', { detail: { path, line: insertion.keywordLine + stub.length - 1, column: 5 } }));
  window.dispatchEvent(new CustomEvent('rfide:status', { detail: { text: `Created keyword '${stub[0]}' in ${path}` } }));
});

const BDD = /^(given|when|then|and|but)\s+/i;

async function keywordFixes(model, marker, name) {
  const actions = [];
  const path = modelPath(model);
  const lines = model.getLinesContent();
  const bdd = BDD.exec(name)?.[0] || '';
  const base = name.slice(bdd.length);
  for (const candidate of similarNames(base, [...new Set(keywords.map((kw) => kw.name))].filter((n) => !n.includes('${')), normalizeKeyword)) {
    actions.push(quickFix(`Change to '${candidate}'`, model, marker,
      [{ range: new monaco.Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn), text: bdd + candidate }],
      actions.length === 0));
  }
  const stub = keywordStub(base, callArguments(lines, marker.startLineNumber, marker.startColumn - 1));
  const create = (target, title) => ({ title, kind: 'quickfix', diagnostics: [marker],
    command: { id: 'rfide.createKeyword', title, arguments: [{ path: target, stub }] } });
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

  function emitDirty(path) {
    for (const listener of dirtyListeners)
      listener(path, isDirty(path));
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
      setBreakpointLines(path, [...(breakpointLines.get(path) || [])]);
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
        const file = await window.rfide.readProjectFile(path).catch(() => null);
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
    const lines = breakpointsOf(path); // kept for when the file is opened again
    breakpointDecorations.delete(path);
    if (lines.length)
      breakpointLines.set(path, new Set(lines));
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

  const breakpointLines = new Map(); // path -> Set<line>, for files that are not open
  const breakpointDecorations = new Map(); // path -> decoration ids on the open model
  const breakpointListeners = new Set();
  let breakpointTimer = null;
  let debugLine = null; // { model, ids }
  let pendingDebugLine = null; // { path, line } until the file is opened

  function breakpointDecoration(line) {
    return {
      range: new monaco.Range(line, 1, line, 1),
      options: {
        glyphMarginClassName: 'breakpoint-glyph',
        glyphMargin: { position: monaco.editor.GlyphMarginLane.Left },
        glyphMarginHoverMessage: { value: 'Breakpoint: click or F9 to remove' },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    };
  }

  function breakpointsOf(path) {
    const model = files.get(path)?.model;
    const ids = breakpointDecorations.get(path);
    const lines = model && ids ? ids.map((id) => model.getDecorationRange(id)?.startLineNumber).filter(Boolean)
      : [...(breakpointLines.get(path) || [])];
    return [...new Set(lines)].sort((a, b) => a - b);
  }

  function setBreakpointLines(path, lines) {
    const sorted = [...new Set(lines)].sort((a, b) => a - b);
    if (sorted.length)
      breakpointLines.set(path, new Set(sorted));
    else
      breakpointLines.delete(path);
    const model = files.get(path)?.model;
    if (model)
      breakpointDecorations.set(path, model.deltaDecorations(breakpointDecorations.get(path) || [], sorted.map(breakpointDecoration)));
  }

  /** All breakpoints: { path: [lines] }. */
  function allBreakpoints() {
    const result = {};
    for (const path of new Set([...breakpointLines.keys(), ...breakpointDecorations.keys()])) {
      const lines = breakpointsOf(path);
      if (lines.length)
        result[path] = lines;
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
    const lines = breakpointsOf(path);
    setBreakpointLines(path, lines.includes(line) ? lines.filter((l) => l !== line) : [...lines, line]);
    emitBreakpoints();
  }

  /** Replaces all breakpoints (e.g. restored for a project). */
  function setBreakpoints(all) {
    for (const path of new Set([...breakpointLines.keys(), ...breakpointDecorations.keys(), ...Object.keys(all)]))
      setBreakpointLines(path, all[path] || []);
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
    robotFileKey = editor.createContextKey('rfideRobotFile', false);
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
    editor.addCommand(monaco.KeyCode.F9, () => {
      const line = editor.getPosition()?.lineNumber;
      if (line && current && files.get(current)?.model.getLanguageId() === LANGUAGE)
        toggleBreakpoint(current, line);
    });
    editor.addAction({
      id: 'rfide.runTestAtCursor',
      label: 'Run Test at Cursor',
      precondition: 'rfideRobotFile',
      contextMenuGroupId: '0_run',
      contextMenuOrder: 1,
      run: () => {
        const test = testAtCursor();
        if (test)
          requestRun([test.name]);
      },
    });
    editor.addAction({
      id: 'rfide.runTestsInFile',
      label: 'Run Tests in File',
      precondition: 'rfideRobotFile',
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
    editor.executeEdits('rfide-pick', [{ range, text: separator + text, forceMoveMarkers: true }]);
    editor.pushUndoStop();
    editor.focus();
    return true;
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
    projectProblems,
    openPaths: () => [...files.keys()],
    formatDocument: () => editor?.getAction('editor.action.formatDocument')?.run(),
    /** Replaces search matches ({ line, column, length, replacement }) in an open file, as one undoable edit. */
    replaceMatches(path, matches) {
      const model = files.get(path)?.model;
      if (!model || !matches.length)
        return 0;
      model.pushEditOperations([], matches.map((m) => ({
        range: new monaco.Range(m.line, m.column, m.line, m.column + m.length),
        text: m.replacement,
      })), () => null);
      return matches.length;
    },
    selectedText: () => {
      const selection = editor?.getSelection();
      return selection && editor.getModel() ? editor.getModel().getValueInRange(selection) : '';
    },
    focus: () => editor && editor.focus(),
    onDirtyChange: (listener) => dirtyListeners.add(listener),
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
  return monaco.Uri.from({ scheme: 'rfide', path: '/' + path });
}

window.RFEditor = RFEditor;
