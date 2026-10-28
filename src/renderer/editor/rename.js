'use strict';

// Rename support: where a user keyword or a variable occurs in the lines of a
// file. Deciding which files and which definition an occurrence belongs to is
// left to the caller (editor/index.js); edits are { line, start, end, text }
// with 1-based lines and 0-based columns.

const { analyzeLine, normalizeKeyword } = require('./robotSyntax');
const { collectCalls } = require('./argumentCheck');
const { normalizeVariable } = require('./navigation');

const BDD_PREFIX = /^(given|when|then|and|but)\s+/i;
// Keywords whose arguments are conditions evaluated as Python, where variables can be written `$name`.
const CONDITION_KEYWORDS = new Set(['evaluate', 'shouldbetrue', 'shouldnotbetrue', 'skipif', 'passexecutionif', 'setvariableif',
  'runkeywordif', 'runkeywordunless', 'returnfromkeywordif', 'continueforloopif', 'exitforloopif'].map(normalizeKeyword));

/**
 * The part of a keyword call cell naming `keyword`, without BDD prefix and `resource.` prefix:
 * { start, end } offsets in the cell, or null when the cell calls something else.
 * @param {{ name: string, library?: string }} keyword
 */
function keywordPart(text, keyword) {
  const target = normalizeKeyword(keyword.name);
  const bdd = BDD_PREFIX.exec(text);
  for (const offset of bdd ? [0, bdd[0].length] : [0]) {
    const rest = text.slice(offset);
    if (normalizeKeyword(rest) === target)
      return { start: offset, end: text.length };
    const dot = rest.lastIndexOf('.');
    if (dot > 0 && keyword.library && rest.slice(0, dot).toLowerCase() === keyword.library.toLowerCase()
        && normalizeKeyword(rest.slice(dot + 1)) === target)
      return { start: offset + dot + 1, end: text.length };
  }
  return null;
}

/**
 * Occurrences of a user keyword: calls (settings, [Setup], [Template], ...), keywords passed to
 * Run Keyword and similar, and its definition when `definition` is true.
 */
function keywordOccurrences(lines, keyword, { definition = false } = {}) {
  const found = [];
  const add = (cell, part) => found.push({ line: cell.line, start: cell.start + part.start, end: cell.start + part.end });
  for (const call of collectCalls(lines)) {
    const part = keywordPart(call.keyword.text, keyword);
    if (part)
      add(call.keyword, part);
    // Run Keyword, Run Keywords, Wait Until Keyword Succeeds, Repeat Keyword, ...
    if (normalizeKeyword(call.keyword.text).includes('keyword')) {
      for (const arg of call.args) {
        const argPart = keywordPart(arg.text, keyword);
        if (argPart && argPart.start === 0)
          add(arg, argPart);
      }
    }
  }
  if (definition) {
    let section = 'none';
    lines.forEach((text, index) => {
      const result = analyzeLine(text, section);
      section = result.section;
      const name = result.cells.find((cell) => cell.type === 'name');
      if (section === 'keywords' && name && normalizeKeyword(name.text) === normalizeKeyword(keyword.name))
        found.push({ line: index + 1, start: name.start, end: name.start + name.text.length });
    });
  }
  return found.sort((a, b) => a.line - b.line || a.start - b.start);
}

/**
 * Which part of a variable written `${...}` names the variable with key `key`: the whole name
 * (without an embedded argument's `:pattern`), or the base of the extended syntax (`${obj.attr}`).
 * @returns {{ start: number, end: number } | null} offsets in `name`
 */
function variablePart(name, key) {
  const inner = name.slice(2, -1);
  if (/[$@&%]\{/.test(inner))
    return null; // built from other variables: only the nested ones are renamed
  const plain = inner.replace(/:.*$/s, '');
  if (normalizeVariable(inner) === key || normalizeVariable(plain) === key)
    return { start: 2, end: 2 + (normalizeVariable(inner) === key ? inner.length : plain.length) };
  const base = /^[\p{L}\p{N}_ ]*/u.exec(inner)[0];
  return base && normalizeVariable(base) === key ? { start: 2, end: 2 + base.length } : null;
}

/** Every `${...}` in a cell, nested ones included; `\${...}` is escaped. */
function variablesInCell(text) {
  const found = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (!'$@&%'.includes(text[i]) || text[i + 1] !== '{' || text[i + 2] === '{')
      continue;
    let depth = 0;
    let j = i + 1;
    for (; j < text.length; j++) {
      if (text[j] === '{')
        depth++;
      else if (text[j] === '}' && --depth === 0)
        break;
    }
    if (j < text.length)
      found.push({ name: text.slice(i, j + 1), start: i });
  }
  return found;
}

/** `$name` variables of a Python expression (conditions and `${{ }}`). */
function expressionVariables(text) {
  const found = [];
  const pattern = /(?<![\\$\w])\$([A-Za-z_]\w*)(?![\w{])/g;
  let match;
  while ((match = pattern.exec(text)) !== null)
    found.push({ name: `\${${match[1]}}`, start: match.index + 1, length: match[1].length });
  return found;
}

/**
 * Occurrences of variables with key `key` in a file, both `${name}` and the `$name` form of
 * Python expressions (IF/ELSE IF/WHILE conditions, Evaluate and similar, inline Python).
 * Documentation is left alone.
 * @param {(name: string, line: number) => boolean} accept whether the variable used at `line`
 *   is the one being renamed (scoping and shadowing)
 * @returns {{ line: number, start: number, end: number, expression: boolean }[]}
 */
function variableOccurrences(lines, key, accept) {
  const found = [];
  let section = 'none';
  let inDocumentation = false;
  lines.forEach((text, index) => {
    const line = index + 1;
    const result = analyzeLine(text, section);
    section = result.section;
    if (!['settings', 'variables', 'tests', 'keywords'].includes(section))
      return;
    const cells = result.cells.filter((cell) => cell.text !== '');
    if (!cells.length || cells[0].type === 'section')
      return;
    if (cells[0].type !== 'continuation')
      inDocumentation = cells.some((cell) => cell.type === 'setting' && /^(documentation|\[documentation\])$/i.test(cell.text));
    if (inDocumentation)
      return;
    const keywordCell = cells.find((cell) => cell.type === 'keyword');
    cells.forEach((cell, i) => {
      for (const use of variablesInCell(cell.text)) {
        const part = variablePart(use.name, key);
        if (part && accept(use.name, line))
          found.push({ line, start: cell.start + use.start + part.start, end: cell.start + use.start + part.end, expression: false });
      }
      const previous = cells[i - 1];
      const condition = (previous && previous.type === 'control' && ['IF', 'ELSE IF', 'WHILE'].includes(previous.text))
        || (previous === keywordCell && keywordCell && CONDITION_KEYWORDS.has(normalizeKeyword(keywordCell.text)))
        || cell.text.includes('${{');
      if (!condition)
        return;
      for (const use of expressionVariables(cell.text)) {
        if (normalizeVariable(use.name) === key && accept(use.name, line))
          found.push({ line, start: cell.start + use.start, end: cell.start + use.start + use.length, expression: true });
      }
    });
  });
  return found;
}

/**
 * Problem with a new keyword or variable name, or null when it is valid.
 * @param {'keyword' | 'variable'} kind
 */
function invalidName(name, kind) {
  if (!name.trim())
    return 'The name cannot be empty.';
  if (name !== name.trim())
    return 'The name cannot start or end with spaces.';
  if (/\t| {2}/.test(name))
    return 'The name cannot contain tabs or consecutive spaces: they separate cells.';
  if (name.startsWith('#'))
    return 'The name cannot start with #.';
  if (kind === 'variable' && /[{}]/.test(name))
    return 'Write the variable name without ${ }.';
  if (kind === 'keyword' && /\$\{/.test(name))
    return 'Keywords with embedded arguments cannot be renamed here.';
  return null;
}

/** Applies edits ({ line, start, end, text }) to lines; they must not overlap. */
function applyEdits(lines, edits) {
  const result = [...lines];
  const sorted = [...edits].sort((a, b) => b.line - a.line || b.start - a.start);
  for (const edit of sorted) {
    const text = result[edit.line - 1];
    result[edit.line - 1] = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  return result;
}

module.exports = { keywordPart, keywordOccurrences, variablePart, variableOccurrences, expressionVariables, invalidName, applyEdits };
