'use strict';

// Quick fixes for the editor's problems: similar names, new keywords and
// variables, missing END. Pure functions over the lines of a file; insertions
// are { afterLine, lines } (insert `lines` after the 1-based `afterLine`, 0 = top).

const { analyzeLine, sectionOf } = require('./robotSyntax');
const { splitFromEquals } = require('./argumentCheck');

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

/**
 * Candidates close to `name` (typos), best first.
 * @param {string[]} candidates
 * @param {(text: string) => string} normalize how names are compared (case, spaces, ...)
 */
function similarNames(name, candidates, normalize, max = 3) {
  const target = normalize(name);
  const limit = Math.max(1, Math.floor(target.length / 3));
  const seen = new Set();
  return candidates
    .map((candidate) => ({ candidate, key: normalize(candidate) }))
    .filter(({ key }) => key !== target && !seen.has(key) && seen.add(key))
    .map((item) => ({ ...item, score: distance(target, item.key) }))
    .filter(({ score, key }) => score <= limit || (key.startsWith(target) && target.length >= 4))
    .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate))
    .slice(0, max)
    .map(({ candidate }) => candidate);
}

/**
 * A new keyword for an unknown call: positional arguments become ${arg1}..., named ones
 * (`name=value`) optional arguments.
 * @param {string} name
 * @param {string[]} args argument cells of the call
 */
function keywordStub(name, args) {
  const positional = [];
  const named = [];
  for (const arg of args) {
    const argName = splitFromEquals(arg);
    if (argName !== null && /^[A-Za-z_][\w ]*$/.test(argName))
      named.push(`\${${argName}}=\${EMPTY}`);
    else if (!named.length)
      positional.push(`\${arg${positional.length + 1}}`);
  }
  const lines = [name];
  if (positional.length || named.length)
    lines.push(`    [Arguments]    ${[...positional, ...named].join('    ')}`);
  lines.push('    Fail    Not implemented');
  return lines;
}

/** Sections of the file: [{ kind, line, lastContent }] with 1-based lines. */
function sections(lines) {
  const found = [];
  lines.forEach((text, index) => {
    const kind = sectionOf(text);
    if (kind)
      found.push({ kind, line: index + 1, lastContent: index + 1 });
    else if (found.length && text.trim())
      found[found.length - 1].lastContent = index + 1;
  });
  return found;
}

/** Where to add a keyword: at the end of the Keywords section, or in a new one at the end of the file. */
function keywordInsertion(lines, stub) {
  const section = sections(lines).find((s) => s.kind === 'keywords');
  if (section)
    return { afterLine: section.lastContent, lines: ['', ...stub], keywordLine: section.lastContent + 2 };
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim())
    end--;
  const prefix = end ? ['', ''] : [];
  return { afterLine: end, lines: [...prefix, '*** Keywords ***', ...stub], keywordLine: end + prefix.length + 2 };
}

/** Where to define a variable: at the end of the Variables section, or in a new one after the settings. */
function variableInsertion(lines, definition) {
  const all = sections(lines);
  const section = all.find((s) => s.kind === 'variables');
  if (section)
    return { afterLine: section.lastContent, lines: [definition] };
  const settings = all.find((s) => s.kind === 'settings');
  if (settings)
    return { afterLine: settings.lastContent, lines: ['', '', '*** Variables ***', definition] };
  return { afterLine: 0, lines: ['*** Variables ***', definition, '', ''] };
}

/**
 * Where the END of a block opened at `headerLine` (FOR, IF, WHILE, TRY) goes: after the last line
 * indented deeper than the header, with the header's indentation.
 */
function endInsertion(lines, headerLine) {
  const header = lines[headerLine - 1];
  const indent = /^\s*/.exec(header)[0];
  const depth = indent.replace(/\t/g, '    ').length;
  let last = headerLine;
  for (let i = headerLine; i < lines.length; i++) {
    const text = lines[i];
    if (!text.trim() || /^\s*#/.test(text))
      continue;
    const lineDepth = /^\s*/.exec(text)[0].replace(/\t/g, '    ').length;
    if (lineDepth <= depth && !/^\s*\.\.\./.test(text))
      break;
    last = i + 1;
  }
  return { afterLine: last, lines: [`${indent}END`] };
}

/** Applies an insertion to lines (for tests and for files written to disk). */
function applyInsertion(lines, insertion) {
  return [...lines.slice(0, insertion.afterLine), ...insertion.lines, ...lines.slice(insertion.afterLine)];
}

/** The text of a keyword call's arguments at a 1-based line (continuation lines included). */
function callArguments(lines, line, keywordStart) {
  let section = 'none';
  const results = lines.map((text) => {
    const result = analyzeLine(text, section);
    section = result.section;
    return result;
  });
  const cells = results[line - 1].cells.filter((cell) => cell.text !== '');
  const index = cells.findIndex((cell) => cell.start === keywordStart);
  if (index < 0)
    return [];
  const args = cells.slice(index + 1).map((cell) => cell.text);
  for (let i = line; i < lines.length; i++) {
    const next = results[i].cells.filter((cell) => cell.text !== '');
    if (!next.length)
      continue;
    if (next[0].type !== 'continuation')
      break;
    args.push(...next.slice(1).map((cell) => cell.text));
  }
  return args;
}

module.exports = { similarNames, keywordStub, keywordInsertion, variableInsertion, endInsertion, applyInsertion, callArguments };
