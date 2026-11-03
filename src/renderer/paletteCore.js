'use strict';

// Fuzzy matching for the command palette: commands and project files.
// Loaded as a classic script in the renderer (window.RFPalette) and as a module
// by the tests.
(function (factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory();
  else
    window.RFPalette = factory();
})(function () {
  const BASE = 1;
  const WORD_START = 8;
  const CONSECUTIVE = 6;
  const IN_FILE_NAME = 10;
  const SEPARATORS = ' /\\_-.:';

  function isWordStart(text, index) {
    if (index === 0)
      return true;
    const previous = text[index - 1];
    if (SEPARATORS.includes(previous))
      return true;
    const current = text[index];
    return previous === previous.toLowerCase() && current !== current.toLowerCase();
  }

  /**
   * Matches the query's characters, in order, anywhere in the text. Case and the
   * query's spaces are ignored. Of all the ways the characters can line up, the
   * one with the most word starts and consecutive characters wins.
   * @param {string} query
   * @param {string} text
   * @returns {{ score: number, positions: number[] } | null} null when it does not match
   */
  function match(query, text) {
    const needle = query.replace(/\s+/g, '').toLowerCase();
    if (!needle)
      return { score: 0, positions: [] };
    const haystack = text.toLowerCase();
    const m = needle.length;
    const n = haystack.length;
    if (m > n)
      return null;

    // best[i][j]: best score with needle[i] at text position j (-Infinity if impossible).
    const best = [];
    const from = [];
    for (let i = 0; i < m; i++) {
      const row = new Array(n).fill(-Infinity);
      const back = new Array(n).fill(-1);
      // Running best of the previous row up to j - 2 (a gap before j).
      let gapBest = -Infinity;
      let gapAt = -1;
      for (let j = i; j < n; j++) {
        if (i > 0 && j >= 2 && best[i - 1][j - 2] > gapBest) {
          gapBest = best[i - 1][j - 2];
          gapAt = j - 2;
        }
        if (haystack[j] !== needle[i])
          continue;
        const own = BASE + (isWordStart(text, j) ? WORD_START : 0);
        if (i === 0) {
          row[j] = own;
          continue;
        }
        const adjacent = best[i - 1][j - 1] + CONSECUTIVE;
        if (adjacent >= gapBest && adjacent > -Infinity) {
          row[j] = adjacent + own;
          back[j] = j - 1;
        } else if (gapBest > -Infinity) {
          row[j] = gapBest + own;
          back[j] = gapAt;
        }
      }
      best.push(row);
      from.push(back);
    }

    let end = -1;
    for (let j = 0; j < n; j++)
      if (best[m - 1][j] > -Infinity && (end < 0 || best[m - 1][j] > best[m - 1][end]))
        end = j;
    if (end < 0)
      return null;

    const positions = new Array(m);
    for (let i = m - 1, j = end; i >= 0; i--) {
      positions[i] = j;
      j = from[i][j];
    }
    let score = best[m - 1][end];
    // A path whose file name matches beats one that matches through its folders.
    const nameStart = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\')) + 1;
    if (nameStart > 0 && positions[0] >= nameStart)
      score += IN_FILE_NAME;
    return { score, positions };
  }

  /**
   * Items that match the query, best first; ties keep the original order.
   * @template T
   * @param {string} query
   * @param {T[]} items
   * @param {(item: T) => string} textOf
   * @returns {{ item: T, score: number, positions: number[] }[]}
   */
  function rank(query, items, textOf) {
    const results = [];
    items.forEach((item, index) => {
      const found = match(query, textOf(item));
      if (found)
        results.push({ item, index, ...found });
    });
    results.sort((a, b) => (b.score - a.score) || (a.index - b.index));
    return results.map(({ item, score, positions }) => ({ item, score, positions }));
  }

  return { match, rank };
});
