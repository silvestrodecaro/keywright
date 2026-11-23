// The project's keyword catalog (libraries and user keywords) and name lookup.
// Shared by completion, hover, definitions, rename and diagnostics; no Monaco dependency.
import { normalizeKeyword } from './robotSyntax.js';

const BDD_PREFIX = /^(given|when|then|and|but)\s+/i;

let keywords = [];
let byName = new Map();
let embedded = []; // [{ regex, keyword }] for keywords with embedded arguments
// False when some library could not be imported: unknown keywords are then not reported.
let complete = false;

export function setKeywords(list, { complete: listComplete = true } = {}) {
  keywords = list;
  complete = listComplete && list.length > 0;
  byName = new Map();
  embedded = [];
  for (const kw of list) {
    const key = normalizeKeyword(kw.name);
    if (!byName.has(key))
      byName.set(key, []);
    byName.get(key).push(kw);
    if (kw.name.includes('${')) {
      const pattern = kw.name.split(/\$\{[^}]+\}/).map((part) => normalizeKeyword(part).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+?');
      embedded.push({ regex: new RegExp(`^${pattern}$`), keyword: kw });
    }
  }
}

/** Every keyword of the catalog, in the order they were given. */
export function allKeywords() {
  return keywords;
}

/** Whether every library was imported, so an unknown keyword is really unknown. */
export function catalogComplete() {
  return complete;
}

export function findKeywords(name) {
  const text = name.trim();
  let found = byName.get(normalizeKeyword(text)) || [];
  // `Library.Keyword` and `resource.Keyword` qualified names.
  const dot = text.lastIndexOf('.');
  if (!found.length && dot > 0) {
    const library = text.slice(0, dot).toLowerCase();
    found = (byName.get(normalizeKeyword(text.slice(dot + 1))) || []).filter((kw) => kw.library.toLowerCase() === library);
  }
  if (!found.length)
    found = embedded.filter(({ regex }) => regex.test(normalizeKeyword(text))).map(({ keyword }) => keyword);
  return found;
}

/** Keywords called in a cell, accepting BDD prefixes (Given/When/Then/And/But). */
export function keywordsCalled(name) {
  const found = findKeywords(name);
  if (found.length || !BDD_PREFIX.test(name))
    return found;
  return findKeywords(name.replace(BDD_PREFIX, ''));
}

export function signature(kw) {
  return [kw.name, ...kw.args.map((arg) => arg.repr)].join('    ');
}
