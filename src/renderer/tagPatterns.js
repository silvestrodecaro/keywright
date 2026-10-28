'use strict';

// Robot Framework tag patterns (--include / --exclude), as in robot/model/tags.py:
// OR has the lowest precedence, then NOT (`aNOTbNOTc`: a, but neither b nor c),
// then AND; `*` and `?` are wildcards; case, spaces and underscores are ignored.
// Loaded as a classic script in the renderer (window.RFTags) and as a module by the tests.
(function (factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory();
  else
    window.RFTags = factory();
})(function () {
  function normalize(text) {
    return String(text).toLowerCase().replace(/[\s_]/g, '');
  }

  function compile(pattern) {
    const text = pattern.trim();
    if (text.includes('OR')) {
      const parts = text.split('OR').map(compile);
      return (tags) => parts.some((part) => part(tags));
    }
    if (text.includes('NOT')) {
      const [must, ...mustNot] = text.split('NOT').map(compile);
      return (tags) => must(tags) && !mustNot.some((part) => part(tags));
    }
    if (text.includes('AND')) {
      const parts = text.split('AND').map(compile);
      return (tags) => parts.every((part) => part(tags));
    }
    const normalized = normalize(text);
    if (!normalized)
      return () => true; // `NOTslow`: nothing required
    const re = new RegExp(`^${normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    return (tags) => tags.some((tag) => re.test(normalize(tag)));
  }

  /** Comma-separated patterns, as typed in the Testing panel: ['smoke', 'fastANDui']. */
  function parseList(text) {
    return String(text || '').split(',').map((p) => p.trim()).filter(Boolean);
  }

  /**
   * Whether a test with `tags` runs with these --include and --exclude patterns.
   * @param {string[]} tags
   * @param {{ include?: string[], exclude?: string[] }} filter
   */
  function selected(tags, { include = [], exclude = [] }) {
    if (include.length && !include.some((pattern) => compile(pattern)(tags)))
      return false;
    return !exclude.some((pattern) => compile(pattern)(tags));
  }

  return { selected, parseList, compile };
});
