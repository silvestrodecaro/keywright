'use strict';

// The commit message is the only field checked for spelling. Electron checks the
// system language, so an English message on an Italian system is underlined
// throughout. English is added next to the system languages: a word passes when
// it is correct in any of them.

const ENGLISH = 'en-US';

/**
 * @param {string[]} current the languages Electron checks by default (the system's)
 * @param {string[]} available the languages the system can check
 * @returns {string[]}
 */
function spellCheckerLanguages(current, available) {
  if (current.some((language) => /^en(-|$)/i.test(language)))
    return current;
  if (!available.includes(ENGLISH))
    return current;
  return [...current, ENGLISH];
}

module.exports = { spellCheckerLanguages };
