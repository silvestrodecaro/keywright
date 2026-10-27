'use strict';

const ENTER_FRAME = 'internal:control=enter-frame';

/**
 * Splits a Playwright selector on ` >> ` separators that are not inside quotes.
 * @param {string} selector
 * @returns {string[]}
 */
function splitChain(selector) {
  const parts = [];
  let quote = null;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (quote) {
      if (ch === '\\')
        i++;
      else if (ch === quote)
        quote = null;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }
    if (selector.startsWith(' >> ', i)) {
      parts.push(selector.slice(start, i));
      i += 3;
      start = i + 1;
    }
  }
  parts.push(selector.slice(start));
  return parts;
}

/**
 * Converts a single (non-chained) Playwright selector part into the most
 * readable form the Browser library understands. Anything without a public
 * equivalent is kept as-is, since Browser passes selectors to Playwright.
 * @param {string} part
 */
function convertPart(part) {
  if (part.startsWith('internal:role='))
    return 'role=' + part.slice('internal:role='.length);

  const text = /^internal:text=(.*)$/s.exec(part);
  if (text) {
    const body = text[1];
    const quoted = /^"((?:[^"\\]|\\.)*)"([is])$/s.exec(body);
    if (!quoted)
      return 'text=' + body; // regular expression form: /.../flags
    const [, inner, flag] = quoted;
    if (flag === 's')
      return `text="${inner}"`;
    const plain = JSON.parse(`"${inner}"`);
    // Unquoted `text=` is case-insensitive and whitespace-normalized, which
    // matches `"..."i`; fall back to the quoted body when it would be ambiguous.
    if (plain === plain.trim() && plain !== '' && !/^["'/]/.test(plain) && !plain.includes(' >> '))
      return 'text=' + plain;
    return `text=${body}`;
  }

  const testId = /^internal:testid=\[data-testid="([^"\\]*)"s\]$/.exec(part);
  if (testId)
    return `[data-testid="${testId[1]}"]`;

  return part;
}

/**
 * Converts a selector produced by the Playwright recorder into a Browser
 * library selector. Frame boundaries become Browser's `>>>` piercing operator.
 * @param {string} selector
 */
function toBrowserSelector(selector) {
  const frames = [];
  let current = [];
  for (const part of splitChain(selector)) {
    if (part === ENTER_FRAME) {
      frames.push(current);
      current = [];
    } else {
      current.push(convertPart(part));
    }
  }
  frames.push(current);
  return frames.map((parts) => parts.join(' >> ')).join(' >>> ');
}

module.exports = { toBrowserSelector, splitChain };
