// Completion: section headers, settings, keywords from the catalog and block snippets.
// Monaco is passed in, so the provider runs in Node tests without the bundle.
import { cellAt } from './robotSyntax.js';
import { allKeywords, signature } from './keywordCatalog.js';
import { sectionAt } from './modelCells.js';

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

export function snippetFor(kw) {
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

export function completionProvider(monaco) {
  return {
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

      const suggestions = allKeywords().map((kw) => ({
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
  };
}

export function registerCompletionProvider(monaco, language) {
  return monaco.languages.registerCompletionItemProvider(language, completionProvider(monaco));
}
