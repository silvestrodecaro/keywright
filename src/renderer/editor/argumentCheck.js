'use strict';

// Keyword calls of a Robot file and validation of their arguments against the
// keyword signatures (libdoc argument specs). Mirrors Robot Framework's own
// NamedArgumentResolver and ArgumentValidator (robot/running/arguments), so the
// editor reports the error Robot would raise, with the same message.

const { analyzeLine, variableRanges } = require('./robotSyntax');

const LIST_OR_DICT_VARIABLE = /^[@&]\{[^}]+\}$/;

/**
 * Keyword calls with their arguments, joining `...` continuation lines.
 * @param {string[]} lines file content
 * @returns {{ keyword: Cell, args: Cell[] }[]} cells: { text, line (1-based), start (0-based) }
 */
function collectCalls(lines) {
  const calls = [];
  let section = 'none';
  let pending = null;
  lines.forEach((text, index) => {
    const result = analyzeLine(text, section);
    section = result.section;
    const cells = result.cells.filter((cell) => cell.text !== '').map((cell) => ({ ...cell, line: index + 1 }));
    if (cells.length === 0)
      return; // empty or comment-only lines do not end a call
    if (cells[0].type === 'continuation') {
      if (pending)
        pending.args.push(...cells.slice(1));
      return;
    }
    pending = null;
    const keywordIndex = cells.findIndex((cell) => cell.type === 'keyword');
    if (keywordIndex >= 0) {
      pending = { keyword: cells[keywordIndex], args: cells.slice(keywordIndex + 1) };
      calls.push(pending);
    }
  });
  return calls;
}

/** Robot's split_from_equals: the name before the first `=` that is not escaped nor inside a variable. */
function splitFromEquals(text) {
  for (const part of variableRanges(text)) {
    if (part.variable)
      continue;
    for (let i = part.start; i < part.end; i++) {
      if (text[i] === '\\')
        i++; // escaped character
      else if (text[i] === '=')
        return text.slice(0, i);
    }
  }
  return null;
}

function plural(count) {
  return count === 1 ? '' : 's';
}

/** Robot's seq2str: 'a', 'b' and 'c'. */
function quoted(names) {
  const items = names.map((name) => `'${name}'`);
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0];
}

/**
 * The name Robot uses in its messages: `Library.Keyword` and `resource.Keyword`,
 * but just `Keyword` for keywords defined in the suite file itself.
 */
function fullName(kw) {
  if (!kw.library || (kw.user && !/\.resource$/i.test(kw.source || '')))
    return kw.name;
  return `${kw.library}.${kw.name}`;
}

/**
 * Validates the arguments of one call and returns the first error Robot would report.
 * @param {{ keyword: object, args: object[] }} call  from collectCalls
 * @param {{ name: string, library?: string, user?: boolean,
 *           args: { name: string, required: boolean, kind: string }[] }} kw
 * @returns {{ message: string, cell: object }[]} zero or one problem, with the cell to underline
 */
function checkCall(call, kw) {
  const spec = kw.args.filter((arg) => !arg.kind.endsWith('_MARKER'));
  const names = (kind) => spec.filter((arg) => arg.kind === kind).map((arg) => arg.name);
  const positionalOnly = names('POSITIONAL_ONLY');
  const positionalOrNamed = names('POSITIONAL_OR_NAMED');
  const namedOnly = names('NAMED_ONLY');
  const positionalNames = [...positionalOnly, ...positionalOrNamed];
  const required = new Set(spec.filter((arg) => arg.required).map((arg) => arg.name));
  const varPositional = spec.some((arg) => arg.kind === 'VAR_POSITIONAL');
  const varNamed = spec.some((arg) => arg.kind === 'VAR_NAMED');
  const fail = (message, cell) => [{ message: `Keyword '${fullName(kw)}' ${message}.`, cell }];

  // Like Robot's dry-run: list and dict variables make the arguments unknown.
  if (call.args.some((cell) => LIST_OR_DICT_VARIABLE.test(cell.text)))
    return [];

  // Resolve positional and named arguments.
  const positional = call.args.slice(0, positionalOnly.length);
  const named = []; // { name, cell }
  for (const cell of call.args.slice(positionalOnly.length)) {
    const name = splitFromEquals(cell.text);
    const isNamed = name !== null && (named.length > 0 || varNamed || positionalOrNamed.includes(name) || namedOnly.includes(name));
    if (isNamed)
      named.push({ name, cell });
    else if (named.length)
      return fail('got positional argument after named arguments', cell);
    else
      positional.push(cell);
  }
  const namedNames = new Set(named.map((n) => n.name));
  const namedCell = (name) => named.find((n) => n.name === name).cell;

  // Validate, in Robot's order.
  for (const name of positionalNames.slice(0, positional.length)) {
    if (namedNames.has(name) && !positionalOnly.includes(name))
      return fail(`got multiple values for argument '${name}'`, namedCell(name));
  }
  const count = positional.length + named.filter((n) => positionalOrNamed.includes(n.name)).length;
  const min = positionalNames.filter((name) => required.has(name)).length;
  const max = varPositional ? Infinity : positionalNames.length;
  if (count < min || count > max) {
    let expected = min === max ? `${min} argument${plural(min)}`
      : max !== Infinity ? `${min} to ${max} arguments` : `at least ${min} argument${plural(min)}`;
    if (varNamed || namedOnly.length)
      expected = expected.replace('argument', 'non-named argument');
    const cell = count > max ? (positional[max] || call.keyword) : call.keyword;
    return fail(`expected ${expected}, got ${count}`, cell);
  }
  for (const name of positionalNames.slice(positional.length)) {
    if (required.has(name) && !namedNames.has(name))
      return fail(`missing value for argument '${name}'`, call.keyword);
  }
  const missing = namedOnly.filter((name) => required.has(name) && !namedNames.has(name)).sort();
  if (missing.length)
    return fail(`missing named-only argument${plural(missing.length)} ${quoted(missing)}`, call.keyword);
  if (!varNamed) {
    const extra = [...namedNames].filter((name) => !positionalOrNamed.includes(name) && !namedOnly.includes(name)).sort();
    if (extra.length)
      return fail(`got unexpected named argument${plural(extra.length)} ${quoted(extra)}`, namedCell(extra[0]));
  }
  return [];
}

module.exports = { collectCalls, checkCall, splitFromEquals };
