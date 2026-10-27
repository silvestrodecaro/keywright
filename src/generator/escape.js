'use strict';

const IDENTIFIER_BEFORE_EQUALS = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Escapes a value so it can be used as a single Robot Framework argument cell.
 *
 * @param {string} value
 * @param {{ escapeNamedArg?: boolean }} [options]
 *   escapeNamedArg: escape the first `=` when the value would otherwise be
 *   parsed as a named argument (e.g. `txt=hello`).
 */
function escapeArg(value, options = {}) {
  const { escapeNamedArg = true } = options;
  let text = String(value ?? '');
  if (text === '')
    return '${EMPTY}';

  text = text
    .replace(/\\/g, '\\\\')
    .replace(/([$@&%])\{/g, '\\$1{')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');

  if (escapeNamedArg && IDENTIFIER_BEFORE_EQUALS.test(text))
    text = text.replace('=', '\\=');

  // Robot uses two or more spaces as a separator: keep only single spaces
  // literal and turn leading, trailing and repeated spaces into ${SPACE}.
  text = text.replace(/ {2,}/g, (run) => ' ' + '${SPACE}'.repeat(run.length - 1));
  text = text.replace(/^ /, '${SPACE}').replace(/ $/, '${SPACE}');

  if (text.startsWith('#'))
    text = '\\' + text;
  return text;
}

module.exports = { escapeArg };
