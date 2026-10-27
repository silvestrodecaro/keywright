'use strict';

// Line-based analysis of Robot Framework (space separated format), shared by
// the editor's syntax highlighting and keyword completion. The only state
// carried between lines is the current section.

const SECTIONS = [
  [/^settings?$/, 'settings'],
  [/^variables?$/, 'variables'],
  [/^(test cases?|tasks?)$/, 'tests'],
  [/^keywords?$/, 'keywords'],
  [/^comments?$/, 'comments'],
];

// Settings whose value is a keyword call.
const KEYWORD_SETTINGS = new Set([
  'suite setup', 'suite teardown', 'test setup', 'test teardown', 'task setup', 'task teardown',
  'test template', 'task template', '[setup]', '[teardown]', '[template]',
]);

const CONTROL = new Set(['FOR', 'END', 'IF', 'ELSE IF', 'ELSE', 'WHILE', 'TRY', 'EXCEPT', 'FINALLY',
  'BREAK', 'CONTINUE', 'RETURN', 'VAR', 'GROUP', 'AND']);
const FOR_SEPARATORS = new Set(['IN', 'IN RANGE', 'IN ENUMERATE', 'IN ZIP']);

// Assertion operators of the Browser library (and a few common BuiltIn ones).
const OPERATORS = new Set(['==', '!=', '<', '>', '<=', '>=', '*=', '^=', '$=', '$', 'contains', 'not contains',
  'equal', 'equals', 'should be', 'inequal', 'should not be', 'starts', 'should start with', 'ends',
  'should end with', 'matches', 'validate', 'then', 'evaluate']);

const SEPARATOR = /\t+| {2,}/g;
const ASSIGNMENT = /^[$@&]\{[^}]+\}( ?=)?$/;
const NAMED_ARG = /^([A-Za-z_][A-Za-z0-9_ ]*?)=/;

/** Splits a line into cells: [{ text, start }]. Leading indentation gives an empty first cell. */
function splitCells(line) {
  const cells = [];
  let start = 0;
  SEPARATOR.lastIndex = 0;
  let match;
  while ((match = SEPARATOR.exec(line)) !== null) {
    cells.push({ text: line.slice(start, match.index), start });
    start = match.index + match[0].length;
  }
  cells.push({ text: line.slice(start), start });
  // A single leading tab or space also indents in Robot.
  if (cells[0].text !== '' && /^\s/.test(cells[0].text)) {
    const indent = cells[0].text.length - cells[0].text.trimStart().length;
    cells.splice(0, 1, { text: '', start: 0 }, { text: cells[0].text.slice(indent), start: indent });
  }
  return cells.filter((cell, index) => index === 0 || cell.text !== '');
}

function sectionOf(line) {
  const match = /^\*+\s*([^*]*?)\s*\**\s*$/.exec(line);
  if (!match)
    return null;
  const name = match[1].toLowerCase().replace(/\s+/g, ' ');
  for (const [pattern, section] of SECTIONS)
    if (pattern.test(name))
      return section;
  return 'unknown';
}

/**
 * Analyzes one line.
 * @param {string} line
 * @param {string} section section in effect before this line ('none' at the start)
 * @returns {{ section: string, cells: { text: string, start: number, type: string }[], comment: number | null }}
 *   cell types: section, comment, name, setting, keyword, control, variable, argument, operator, continuation
 */
function analyzeLine(line, section = 'none') {
  const header = sectionOf(line);
  if (header)
    return { section: header, cells: [{ text: line, start: 0, type: 'section' }], comment: null };
  if (section === 'comments' || section === 'none' || section === 'unknown')
    return { section, cells: line ? [{ text: line, start: 0, type: 'comment' }] : [], comment: line ? 0 : null };

  let cells = splitCells(line);
  let comment = null;
  const commentIndex = cells.findIndex((cell) => cell.text.startsWith('#'));
  if (commentIndex >= 0) {
    comment = cells[commentIndex].start;
    cells = cells.slice(0, commentIndex);
  }
  const typed = cells.map((cell) => ({ ...cell, type: 'argument' }));
  const content = typed.filter((cell, index) => !(index === 0 && cell.text === ''));
  const indented = typed.length > 0 && typed[0].text === '';

  let i = 0;
  if (content[0] && content[0].text === '...') {
    content[0].type = 'continuation';
    return { section, cells: typed, comment };
  }

  if (section === 'settings') {
    if (content[0]) {
      content[0].type = 'setting';
      if (KEYWORD_SETTINGS.has(content[0].text.toLowerCase()) && content[1])
        content[1].type = 'keyword';
    }
  } else if (section === 'variables') {
    if (content[0])
      content[0].type = 'variable';
  } else if (section === 'tests' || section === 'keywords') {
    if (!indented) {
      if (content[0])
        content[0].type = 'name';
      i = 1;
    }
    classifyBody(content.slice(i));
  }
  for (const cell of content)
    if (cell.type === 'argument' && OPERATORS.has(cell.text))
      cell.type = 'operator';
  return { section, cells: typed, comment };
}

/** Classifies the cells of a test/keyword body line (after indentation). */
function classifyBody(cells) {
  let i = 0;
  if (cells[i] && /^\[.*\]$/.test(cells[i].text)) {
    cells[i].type = 'setting';
    if (KEYWORD_SETTINGS.has(cells[i].text.toLowerCase()) && cells[i + 1])
      cells[i + 1].type = 'keyword';
    return;
  }
  while (cells[i] && ASSIGNMENT.test(cells[i].text)) {
    cells[i].type = 'variable';
    i++;
  }
  const first = cells[i];
  if (!first)
    return;
  if (CONTROL.has(first.text)) {
    first.type = 'control';
    if (first.text === 'FOR') {
      for (const cell of cells.slice(i + 1)) {
        if (FOR_SEPARATORS.has(cell.text))
          cell.type = 'control';
        else if (ASSIGNMENT.test(cell.text) && !cells.slice(i + 1).some((c) => c.type === 'control'))
          cell.type = 'variable';
      }
    } else if (first.text === 'VAR' && cells[i + 1]) {
      cells[i + 1].type = 'variable';
    }
    return;
  }
  first.type = 'keyword';
}

/**
 * Splits a cell's text into variable and plain parts: [{ start, end, variable }].
 * Handles nested braces (`${a${b}}`) and backslash escapes.
 */
function variableRanges(text) {
  const parts = [];
  let plainStart = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if ('$@&%'.includes(text[i]) && text[i + 1] === '{') {
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === '{')
          depth++;
        else if (text[j] === '}' && --depth === 0)
          break;
      }
      if (j < text.length) {
        let end = j + 1;
        while (text[end] === '[') { // item access: ${dict}[key]
          const close = text.indexOf(']', end);
          if (close < 0)
            break;
          end = close + 1;
        }
        if (i > plainStart)
          parts.push({ start: plainStart, end: i, variable: false });
        parts.push({ start: i, end, variable: true });
        plainStart = i = end;
        continue;
      }
    }
    i++;
  }
  if (plainStart < text.length)
    parts.push({ start: plainStart, end: text.length, variable: false });
  return parts;
}

/**
 * Tokens for a line, in order: [{ start, type }]. Types are those of
 * analyzeLine plus 'param' (the `name=` of a named argument) and 'whitespace'.
 */
function tokenizeLine(line, section = 'none') {
  const result = analyzeLine(line, section);
  const tokens = [];
  let position = 0; // end of the previous cell
  const push = (start, type) => {
    if (tokens.length && tokens[tokens.length - 1].start === start)
      tokens[tokens.length - 1].type = type;
    else
      tokens.push({ start, type });
  };
  const separate = (start) => {
    if (start > position)
      push(position, 'whitespace');
  };
  for (const cell of result.cells) {
    if (cell.text === '')
      continue;
    separate(cell.start);
    if (cell.type === 'section' || cell.type === 'comment') {
      push(cell.start, cell.type);
      position = cell.start + cell.text.length;
      continue;
    }
    let offset = 0;
    if (cell.type === 'argument') {
      const named = NAMED_ARG.exec(cell.text);
      if (named) {
        push(cell.start, 'param');
        offset = named[0].length;
      }
    }
    const scanVariables = cell.type !== 'variable' && cell.type !== 'continuation';
    const parts = scanVariables ? variableRanges(cell.text.slice(offset)) : [{ start: 0, end: cell.text.length - offset, variable: false }];
    for (const part of parts)
      push(cell.start + offset + part.start, part.variable ? 'variable' : cell.type);
    position = cell.start + cell.text.length;
  }
  if (result.comment !== null && !(result.cells.length === 1 && result.cells[0].type === 'comment')) {
    separate(result.comment);
    push(result.comment, 'comment');
  }
  return { tokens, section: result.section };
}

/**
 * Describes the cell under the cursor (`column` is a 0-based offset), for
 * completion: { type, start, end, text } or null on a separator. Positions
 * after the last cell (e.g. after typing two spaces) report the type the next
 * cell would have.
 */
function cellAt(line, column, section) {
  const before = line.slice(0, column);
  const probe = /(\t| {2,})$/.test(before) || before === '' ? before + 'x' : before;
  const { cells } = analyzeLine(probe, section);
  const cell = cells[cells.length - 1];
  if (!cell)
    return null;
  const end = cell.start + (line.slice(cell.start).search(/\t| {2,}/) >= 0 ? line.slice(cell.start).search(/\t| {2,}/) : line.length - cell.start);
  return { type: cell.type, start: cell.start, end: Math.max(end, column), text: line.slice(cell.start, column) };
}

/** Robot keyword name normalization: case, spaces and underscores are ignored. */
function normalizeKeyword(name) {
  return String(name).toLowerCase().replace(/[\s_]/g, '');
}

module.exports = { analyzeLine, tokenizeLine, cellAt, splitCells, variableRanges, normalizeKeyword, sectionOf };
