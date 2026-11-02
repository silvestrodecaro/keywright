'use strict';

// Navigation inside Robot files: the outline (sections, tests, keywords,
// variables), variable definitions and imported files. Pure functions over the
// lines of a file; reading imported files is left to the caller.

const { analyzeLine } = require('./robotSyntax');

const VARIABLE = /^[$@&]\{[^}]+\}$/;
const SET_VARIABLE = /^(?:builtin\.)?set(?:test|task|suite|global|local)variable$/;

// Built-in variables (robot/variables/scopes.py and the number/boolean syntax).
const BUILTIN = new Set(['curdir', 'tempdir', 'execdir', 'space', 'empty', 'true', 'false', 'none', 'null', '/', ':', '\\n',
  'options', 'outputdir', 'outputfile', 'logfile', 'reportfile', 'debugfile', 'prevtestname', 'prevteststatus',
  'prevtestmessage', 'suitename', 'suitesource', 'suitedocumentation', 'suitemetadata', 'suitestatus', 'suitemessage',
  'testname', 'testdocumentation', 'testtags', 'teststatus', 'testmessage', 'keywordstatus', 'keywordmessage',
  'loglevel', 'taskname', 'taskdocumentation', 'tasktags', 'taskstatus', 'taskmessage']);

/** Robot's variable name matching: case, spaces and underscores are ignored; `${x}`, `@{x}` and `&{x}` are the same. */
function normalizeVariable(name) {
  const inner = /^[$@&%]\{(.*)\}$/.exec(name);
  return (inner ? inner[1] : name).toLowerCase().replace(/[\s_]/g, '');
}

/** The innermost `${...}` (or @, &, %) around a 0-based offset of the line: { name, start, end }. */
function variableAt(text, offset) {
  let found = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (!'$@&%'.includes(text[i]) || text[i + 1] !== '{')
      continue;
    let depth = 0;
    let j = i + 1;
    for (; j < text.length; j++) {
      if (text[j] === '{')
        depth++;
      else if (text[j] === '}' && --depth === 0)
        break;
    }
    if (j < text.length && i <= offset && offset <= j)
      found = { name: text.slice(i, j + 1), start: i, end: j + 1 }; // later matches are nested inside earlier ones
  }
  return found;
}

/** Normalized names to look up for a variable use: `${obj.attr}` also tries `obj` (extended syntax). */
function lookupKeys(name) {
  const key = normalizeVariable(name);
  // Robot's extended variable syntax: the base name ends at the first character that is not a letter, digit,
  // underscore or space (`${obj.attr}`, `${SPACE * 4}`, `${list[0]}`).
  const inner = /^[$@&%]\{(.*)\}$/.exec(name);
  const base = inner && /^[\p{L}\p{N}_ ]*/u.exec(inner[1])[0];
  const baseKey = base ? normalizeVariable(base) : '';
  return baseKey && baseKey !== key ? [key, baseKey] : [key];
}

function isBuiltinVariable(name) {
  return lookupKeys(name).some((key) => BUILTIN.has(key) || /^-?(\d[\d_]*(\.\d+)?(e-?\d+)?|0[xob][\da-f]+)$/i.test(key));
}

/** Variable name defined by a cell like `${x}`, `${x}=`, `${x} =` or `${arg}=default`. */
function definedName(text) {
  const match = /^([$@&]\{[^}]+\})/.exec(text.replace(/^\\/, ''));
  return match && VARIABLE.test(match[1]) ? match[1] : null;
}

/**
 * Parses a file for navigation.
 * @param {string[]} lines
 * @returns {{
 *   sections: { kind: string, name: string, line: number, end: number }[],
 *   blocks: { kind: 'test' | 'keyword', name: string, line: number, end: number }[],
 *   variables: Definition[], locals: Definition[],
 *   imports: { type: 'resource' | 'variables' | 'library', path: string, line: number, start: number, end: number }[],
 * }}
 *   Definition: { name, key, line, start, end, how, value?, block? } (line 1-based, start/end 0-based);
 *   locals with `fileWide` come from Set Test/Suite/Global Variable.
 */
function parseFile(lines) {
  const sections = [];
  const blocks = [];
  const variables = [];
  const locals = [];
  const imports = [];
  let section = 'none';
  let block = null;
  let lastVariable = null;
  let continuesArguments = false;

  const define = (cell, how, extra = {}) => {
    const name = definedName(cell.text);
    if (!name)
      return null;
    const start = cell.start + (cell.text.startsWith('\\') ? 1 : 0);
    const definition = { name, key: normalizeVariable(name), line: cell.line, start, end: start + name.length, how, block, ...extra };
    locals.push(definition);
    return definition;
  };
  const close = (line) => {
    if (block)
      block.end = line;
    block = null;
  };

  lines.forEach((text, index) => {
    const line = index + 1;
    const result = analyzeLine(text, section);
    section = result.section;
    const cells = result.cells.filter((cell) => cell.text !== '').map((cell) => ({ ...cell, line }));
    if (cells[0]?.type === 'section') {
      close(line - 1);
      if (sections.length)
        sections[sections.length - 1].end = line - 1;
      sections.push({ kind: section, name: text.replace(/\*/g, '').trim(), line, end: lines.length });
      lastVariable = null;
      return;
    }
    if (!cells.length)
      return;
    const continuation = cells[0].type === 'continuation';

    if (section === 'variables') {
      if (continuation) {
        lastVariable?.values.push(...cells.slice(1).map((cell) => cell.text));
        return;
      }
      const name = definedName(cells[0].text);
      lastVariable = name ? { name, key: normalizeVariable(name), line, start: cells[0].start, end: cells[0].start + name.length,
        how: 'variable', values: cells.slice(1).map((cell) => cell.text) } : null;
      if (lastVariable)
        variables.push(lastVariable);
    } else if (section === 'settings') {
      const type = cells[0].text.toLowerCase();
      if (!continuation && ['resource', 'variables', 'library'].includes(type) && cells[1])
        imports.push({ type, path: cells[1].text, line, start: cells[1].start, end: cells[1].start + cells[1].text.length });
    } else if (section === 'tests' || section === 'keywords') {
      let body = continuation ? cells.slice(1) : cells;
      const nameCell = cells.find((cell) => cell.type === 'name');
      if (nameCell) {
        close(line - 1);
        block = { kind: section === 'tests' ? 'test' : 'keyword', name: nameCell.text, line, end: lines.length };
        blocks.push(block);
        continuesArguments = false;
        if (section === 'keywords') {
          // Embedded arguments: `Open ${page} Page`.
          let match;
          const embedded = /[$]\{[^}]+\}/g;
          while ((match = embedded.exec(nameCell.text)) !== null) {
            const definition = define({ text: match[0], start: nameCell.start + match.index, line }, 'embedded argument');
            if (definition && definition.name.includes(':')) { // custom pattern: `${count:\d+}`
              definition.name = definition.name.replace(/:.*\}$/, '}');
              definition.key = normalizeVariable(definition.name);
            }
          }
        }
        body = cells.slice(cells.indexOf(nameCell) + 1);
      }
      if (!body.length || !block)
        return;
      if (continuation) {
        if (continuesArguments)
          body.forEach((cell) => define(cell, 'argument'));
        return;
      }
      continuesArguments = false;
      const first = body.findIndex((cell) => cell.type !== 'variable');
      body.slice(0, first < 0 ? body.length : first).forEach((cell) => define(cell, 'assignment', { from: body[first]?.text }));
      const head = body[first];
      if (!head)
        return;
      const upper = head.text.toUpperCase();
      if (upper === '[ARGUMENTS]') {
        continuesArguments = true;
        body.slice(first + 1).forEach((cell) => define(cell, 'argument'));
      } else if (upper === 'FOR') {
        body.slice(first + 1).filter((cell) => cell.type === 'variable').forEach((cell) => define(cell, 'FOR loop variable'));
      } else if (upper === 'VAR' && body[first + 1]) {
        const rest = body.slice(first + 2).map((cell) => cell.text);
        const scoped = rest.some((text) => /^scope=(test|task|suite|suites|global)$/i.test(text));
        define(body[first + 1], 'VAR', { values: rest.filter((text) => !/^(scope|separator)=/i.test(text)), fileWide: scoped });
      } else if (upper === 'EXCEPT') {
        const as = body.findIndex((cell) => cell.text === 'AS');
        if (as >= 0 && body[as + 1])
          define(body[as + 1], 'EXCEPT ... AS');
      } else if (head.type === 'keyword' && SET_VARIABLE.test(head.text.toLowerCase().replace(/[\s_]/g, '')) && body[first + 1]) {
        define(body[first + 1], head.text, { fileWide: true, values: body.slice(first + 2).map((cell) => cell.text) });
      }
    }
  });
  return { sections, blocks, variables, locals, imports };
}

/**
 * The definition of a variable used at `line`, in the file itself: local definitions of the
 * enclosing test/keyword (the nearest one above), then the Variables section, then Set ... Variable.
 */
function findVariable(parsed, name, line) {
  for (const key of lookupKeys(name)) {
    const block = parsed.blocks.find((b) => b.line <= line && line <= b.end);
    if (block) {
      const inBlock = parsed.locals.filter((d) => d.key === key && d.block === block && !d.fileWide);
      const above = inBlock.filter((d) => d.line <= line);
      if (above.length || inBlock.length)
        return above.length ? above[above.length - 1] : inBlock[0];
    }
    const found = parsed.variables.find((d) => d.key === key) || parsed.locals.find((d) => d.key === key && d.fileWide);
    if (found)
      return found;
  }
  return null;
}

/**
 * Whether the variables of a variable file cannot be read from its text: Python files with
 * get_variables() or star imports, and formats other than Python, YAML and JSON.
 */
function isDynamicVariableFile(path, lines) {
  if (!/\.(py|ya?ml|json)$/i.test(path))
    return true;
  return /\.py$/i.test(path) && lines.some((text) => /^(def\s+get_?variables\b|getVariables\s*=|get_variables\s*=|from\s+\S+\s+import\s+\*)/i.test(text));
}

/** Variables defined at the top level of a Python, YAML or JSON variable file: [{ key, name, line, start, end, value }]. */
function variableFileDefinitions(path, lines) {
  if (/\.json$/i.test(path)) {
    let data;
    try {
      data = JSON.parse(lines.join('\n'));
    } catch {
      return [];
    }
    if (!data || typeof data !== 'object' || Array.isArray(data))
      return [];
    return Object.entries(data).map(([name, value]) => {
      const index = Math.max(0, lines.findIndex((text) => text.includes(JSON.stringify(name))));
      const start = Math.max(0, lines[index].indexOf(JSON.stringify(name)));
      return { name, key: normalizeVariable(name), line: index + 1, start, end: start + name.length + 2,
        how: 'variable file', values: [JSON.stringify(value)] };
    });
  }
  const pattern = /\.py$/i.test(path) ? /^([A-Za-z_]\w*)\s*(?::[^=]*)?=(?!=)\s*(.*)$/ : /^([A-Za-z_][\w ]*?)\s*:\s*(.*)$/;
  const definitions = [];
  lines.forEach((text, index) => {
    const match = pattern.exec(text);
    if (match && !match[1].startsWith('_'))
      definitions.push({ name: match[1].replace(/^(LIST|DICT)__/, ''), line: index + 1, start: 0, end: match[1].length,
        how: 'variable file', values: [match[2].trim()] });
  });
  return definitions.map((d) => ({ ...d, key: normalizeVariable(d.name) }));
}

/** Normalizes a relative path ('a/./b/../c' -> 'a/c'); null when it leaves the project. */
function normalizePath(path) {
  const parts = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.')
      continue;
    if (part === '..') {
      if (!parts.length)
        return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

/**
 * Project-relative files an import may refer to, most likely first: relative to the importing
 * file, then to the project root (on the Python path when Robot runs). [] for names like `Browser`.
 */
function importCandidates(fromPath, importPath) {
  let path = importPath.replace(/\$\{\/\}/g, '/').replace(/\\+/g, '/');
  if (!/\/|\.(robot|resource|txt|tsv|rst|py|ya?ml|json)$/i.test(path))
    return [];
  const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const anchored = /\$\{(CURDIR|EXECDIR)\}/i.test(path);
  path = path.replace(/\$\{CURDIR\}/gi, dir || '.').replace(/\$\{EXECDIR\}/gi, '.');
  if (/[$@&%]\{/.test(path) || /^([a-z]:)?\//i.test(path))
    return []; // other variables or absolute paths
  const candidates = anchored ? [normalizePath(path)] : [normalizePath(`${dir}/${path}`), normalizePath(path)];
  return [...new Set(candidates.filter(Boolean))];
}

/**
 * Variables used in a cell: every `${...}` (or @, &, %), nested ones included, except those whose
 * name is built from other variables (`${a_${b}}`: only `${b}` is returned) and inline Python (`${{ }}`).
 */
function variableUses(text) {
  const uses = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (!'$@&%'.includes(text[i]) || text[i + 1] !== '{')
      continue;
    let depth = 0;
    let j = i + 1;
    for (; j < text.length; j++) {
      if (text[j] === '{')
        depth++;
      else if (text[j] === '}' && --depth === 0)
        break;
    }
    if (j >= text.length)
      continue;
    const name = text.slice(i, j + 1);
    if (!/[$@&%]\{/.test(name.slice(2, -1)) && !name.startsWith('{', 2))
      uses.push({ name, start: i, end: j + 1 });
  }
  return uses;
}

/**
 * Variables used in the file that are not defined in it (see findVariable), skipping built-in,
 * environment variables and documentation. Imports and runtime scopes are for the caller to check.
 * @returns {{ name: string, keys: string[], line: number, start: number, end: number }[]}
 */
function unresolvedVariables(lines) {
  const parsed = parseFile(lines);
  const unresolved = [];
  let section = 'none';
  let inDocumentation = false;
  lines.forEach((text, index) => {
    const line = index + 1;
    const result = analyzeLine(text, section);
    section = result.section;
    if (!['settings', 'variables', 'tests', 'keywords'].includes(section))
      return;
    const cells = result.cells.filter((cell) => cell.text !== '');
    if (!cells.length)
      return;
    if (cells[0].type !== 'continuation')
      inDocumentation = cells.some((cell) => /^(documentation|\[documentation\])$/i.test(cell.text) && cell.type === 'setting');
    if (inDocumentation)
      return;
    for (const cell of cells) {
      if (cell.type === 'section' || cell.type === 'comment' || cell.type === 'name')
        continue;
      for (const use of variableUses(cell.text)) {
        if (use.name.startsWith('%') || isBuiltinVariable(use.name) || findVariable(parsed, use.name, line))
          continue;
        unresolved.push({ name: use.name, keys: lookupKeys(use.name), line, start: cell.start + use.start, end: cell.start + use.end });
      }
    }
  });
  return unresolved;
}

/** Keys of the variables a file sets for other tests and keywords at run time (Set ... Variable, VAR scope=). */
function runtimeVariableKeys(lines) {
  return parseFile(lines).locals.filter((d) => d.fileWide).map((d) => d.key);
}

/** Outline of the file for Monaco's document symbols: sections with their tests, keywords, variables and imports. */
function outline(lines) {
  const parsed = parseFile(lines);
  return parsed.sections.map((section) => {
    const inSection = (item) => section.line < item.line && item.line <= section.end;
    let children = [];
    if (section.kind === 'tests' || section.kind === 'keywords')
      children = parsed.blocks.filter(inSection).map((b) => ({ name: b.name, kind: b.kind, line: b.line, end: b.end }));
    else if (section.kind === 'variables')
      children = parsed.variables.filter(inSection).map((v) => ({ name: v.name, kind: 'variable', line: v.line, end: v.line }));
    else if (section.kind === 'settings')
      children = parsed.imports.filter(inSection).map((i) => ({ name: i.path, kind: i.type, line: i.line, end: i.line }));
    return { name: section.name, kind: 'section', line: section.line, end: section.end, children };
  });
}

module.exports = {
  normalizeVariable, variableAt, isBuiltinVariable, parseFile, findVariable, variableFileDefinitions,
  importCandidates, outline, lookupKeys, isDynamicVariableFile, variableUses, unresolvedVariables, runtimeVariableKeys,
};
