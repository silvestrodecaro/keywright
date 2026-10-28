'use strict';

// Search and replace across files: the matching rules shared by the renderer
// (open files, unsaved edits included) and the main process (files on disk).
// Loaded as a classic script in the renderer (window.RFSearch) and as a module
// by the main process and the tests.
(function (factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory();
  else
    window.RFSearch = factory();
})(function () {
  const MAX_PREVIEW = 160;

  /**
   * @param {{ query: string, regex?: boolean, caseSensitive?: boolean, wholeWord?: boolean }} options
   * @returns {RegExp} global; throws SyntaxError for an invalid regular expression
   */
  function buildRegex({ query, regex = false, caseSensitive = false, wholeWord = false }) {
    let source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (wholeWord)
      source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
    return new RegExp(source, `gu${caseSensitive ? '' : 'i'}`);
  }

  /** Expands $&, $1..$99, $<name> and $$ in a regex replacement, like String.prototype.replace. */
  function expandReplacement(template, match) {
    return template.replace(/\$(\$|&|\d{1,2}|<([^>]+)>)/g, (token, what, name) => {
      if (what === '$')
        return '$';
      if (what === '&')
        return match[0];
      if (name !== undefined)
        return match.groups && match.groups[name] !== undefined ? match.groups[name] : '';
      const index = Number(what);
      return index > 0 && index < match.length ? (match[index] ?? '') : token;
    });
  }

  /**
   * Matches in a text, line by line (a match never spans lines).
   * @param {string} text
   * @param {RegExp} re from buildRegex
   * @param {{ replacement?: string, regex?: boolean, limit?: number }} [options]
   *   replacement: also compute each match's replacement ($1... only with regex)
   * @returns {{ line: number, column: number, length: number, text: string, preview: string,
   *             previewStart: number, replacement?: string }[]} 1-based line and column
   */
  function findInText(text, re, { replacement, regex = false, limit = Infinity } = {}) {
    const matches = [];
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length && matches.length < limit; index++) {
      const line = lines[index];
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(line)) !== null) {
        if (match[0] === '') { // zero-length (e.g. ^): skip to avoid an endless loop
          re.lastIndex++;
          continue;
        }
        const start = Math.max(0, match.index - 40);
        const preview = line.slice(start, start + MAX_PREVIEW);
        const found = { line: index + 1, column: match.index + 1, length: match[0].length, text: match[0],
          preview, previewStart: match.index - start };
        if (replacement !== undefined)
          found.replacement = regex ? expandReplacement(replacement, match) : replacement;
        matches.push(found);
        if (matches.length >= limit)
          break;
      }
    }
    return matches;
  }

  /** Applies replacements (matches from findInText with `replacement`) to a text, keeping its line endings. */
  function applyReplacements(text, matches) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const sorted = [...matches].sort((a, b) => b.line - a.line || b.column - a.column);
    for (const m of sorted) {
      const line = lines[m.line - 1];
      lines[m.line - 1] = line.slice(0, m.column - 1) + m.replacement + line.slice(m.column - 1 + m.length);
    }
    return lines.join(eol);
  }

  /**
   * Filter for "files to include": comma-separated globs (`*.robot, tests/**`). A glob without `/`
   * matches the file name; `**` matches any folders. Empty: every file.
   * @returns {(path: string) => boolean} for project-relative paths with `/`
   */
  function includeFilter(patterns) {
    const globs = String(patterns || '').split(',').map((p) => p.trim()).filter(Boolean);
    if (!globs.length)
      return () => true;
    const tests = globs.map((raw) => {
      const glob = raw.endsWith('/') ? `${raw}**` : raw; // `tests/`: everything in the folder
      const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '\u0000') // any folders, none included
        .replace(/\*\*/g, '\u0001') // anything
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\u0000/g, '(?:.*/)?')
        .replace(/\u0001/g, '.*');
      const re = new RegExp(`^${body}$`, 'i');
      return glob.includes('/') ? (path) => re.test(path) : (path) => re.test(path.split('/').pop());
    });
    return (path) => tests.some((test) => test(path));
  }

  return { buildRegex, expandReplacement, findInText, applyReplacements, includeFilter };
});
