// Hover: keyword documentation and where a variable is defined.
// Monaco and the project lookups are passed in, so Node tests run the providers with stubs.
import { variableAt, isBuiltinVariable } from './navigation.js';
import { findKeywords, signature } from './keywordCatalog.js';
import { keywordCellAt } from './modelCells.js';

/** Text shown literally in Markdown (keyword names may contain * _ or backticks). */
function markdownText(text) {
  return String(text).replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
}

/** A code block whose fence is longer than any backtick run in `code`. */
function codeBlock(code, language) {
  const fence = '`'.repeat(Math.max(3, ...[...String(code).matchAll(/`+/g)].map((run) => run[0].length + 1)));
  return `${fence}${language}\n${code}\n${fence}`;
}

export function documentation(kw) {
  const where = kw.user ? `keyword in ${markdownText(kw.source)}` : `${markdownText(kw.library)} library`;
  const header = `**${markdownText(kw.name)}** — ${where}\n\n${codeBlock(signature(kw), 'robotframework')}`;
  const doc = kw.doc || '';
  const body = kw.docFormat === 'HTML' ? { value: doc, supportHtml: true } : { value: doc };
  return doc ? [{ value: header }, body] : [{ value: header }];
}

/**
 * The keyword and variable hover providers, in registration order.
 * @param {{ modelPath: (model) => string, resolveVariable: (path, lines, name, line) => Promise<object|null> }} project
 */
export function hoverProviders(monaco, { modelPath, resolveVariable }) {
  const keyword = {
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
  };

  const variable = {
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
  };

  return [keyword, variable];
}

/** Registers the keyword hover, then the variable hover: Monaco shows their contents in that order. */
export function registerHoverProviders(monaco, language, project) {
  return hoverProviders(monaco, project).map((provider) => monaco.languages.registerHoverProvider(language, provider));
}
