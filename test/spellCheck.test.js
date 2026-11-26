'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spellCheckerLanguages } = require('../src/main/spellCheck');

test('English is checked alongside the system language', () => {
  assert.deepStrictEqual(spellCheckerLanguages(['it'], ['en-US', 'it']), ['it', 'en-US']);
  assert.deepStrictEqual(spellCheckerLanguages(['de-DE', 'fr-FR'], ['de-DE', 'en-US', 'fr-FR']), ['de-DE', 'fr-FR', 'en-US']);
});

test('the languages stay as they are when English is already checked', () => {
  assert.deepStrictEqual(spellCheckerLanguages(['en-US'], ['en-US']), ['en-US']);
  assert.deepStrictEqual(spellCheckerLanguages(['en-GB', 'it'], ['en-GB', 'en-US', 'it']), ['en-GB', 'it']);
  assert.deepStrictEqual(spellCheckerLanguages(['EN-us'], ['en-US']), ['EN-us']);
});

test('English is not added when the system does not offer it', () => {
  assert.deepStrictEqual(spellCheckerLanguages(['it'], ['it']), ['it']);
  assert.deepStrictEqual(spellCheckerLanguages(['it'], []), ['it']);
});

test('English is used alone when no system language is set', () => {
  assert.deepStrictEqual(spellCheckerLanguages([], ['en-US', 'it']), ['en-US']);
});
