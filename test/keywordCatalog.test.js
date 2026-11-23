'use strict';

const test = require('node:test');
const assert = require('node:assert');
const catalog = require('../src/renderer/editor/keywordCatalog');

const kw = (name, library, extra = {}) => ({ name, library, args: [], ...extra });
const names = (list) => list.map((k) => `${k.library}.${k.name}`);

test('finds keywords by normalized name and keeps every match', () => {
  catalog.setKeywords([kw('Click', 'Browser'), kw('Open App', 'common'), kw('Open App', 'other')]);
  assert.deepStrictEqual(names(catalog.findKeywords('click')), ['Browser.Click']);
  assert.deepStrictEqual(names(catalog.findKeywords('  open_app ')), ['common.Open App', 'other.Open App']);
  assert.deepStrictEqual(catalog.findKeywords('Missing'), []);
  assert.strictEqual(catalog.allKeywords().length, 3);
});

test('qualified names select the library or resource', () => {
  catalog.setKeywords([kw('Open App', 'common'), kw('Open App', 'other')]);
  assert.deepStrictEqual(names(catalog.findKeywords('Common.Open App')), ['common.Open App']);
  assert.deepStrictEqual(catalog.findKeywords('third.Open App'), []);
});

test('embedded arguments match the call text', () => {
  catalog.setKeywords([kw('Open ${page} Page', 'common'), kw('Price is ${amount}.', 'shop')]);
  assert.deepStrictEqual(names(catalog.findKeywords('Open Login Page')), ['common.Open ${page} Page']);
  assert.deepStrictEqual(names(catalog.findKeywords('price is 10.')), ['shop.Price is ${amount}.']);
  // Regular expression characters in the name stay literal.
  assert.deepStrictEqual(catalog.findKeywords('Price is 10!'), []);
});

test('BDD prefixes are accepted only when the full name is unknown', () => {
  catalog.setKeywords([kw('Login', 'common'), kw('Given Login', 'bdd')]);
  assert.deepStrictEqual(names(catalog.keywordsCalled('Given Login')), ['bdd.Given Login']);
  assert.deepStrictEqual(names(catalog.keywordsCalled('when login')), ['common.Login']);
  assert.deepStrictEqual(catalog.keywordsCalled('Whenever Login'), []);
});

test('the catalog is complete only for a non-empty list that was not marked incomplete', () => {
  catalog.setKeywords([kw('Click', 'Browser')]);
  assert.strictEqual(catalog.catalogComplete(), true);
  catalog.setKeywords([kw('Click', 'Browser')], { complete: false });
  assert.strictEqual(catalog.catalogComplete(), false);
  catalog.setKeywords([]);
  assert.strictEqual(catalog.catalogComplete(), false);
});

test('setKeywords replaces the previous catalog', () => {
  catalog.setKeywords([kw('Click', 'Browser'), kw('Open ${page} Page', 'common')]);
  catalog.setKeywords([kw('Fill Text', 'Browser')]);
  assert.deepStrictEqual(catalog.findKeywords('Click'), []);
  assert.deepStrictEqual(catalog.findKeywords('Open Login Page'), []);
  assert.deepStrictEqual(names(catalog.findKeywords('fill text')), ['Browser.Fill Text']);
});

test('signature joins the name and argument representations', () => {
  const click = kw('Click', 'Browser', { args: [{ repr: 'selector' }, { repr: 'button=left' }] });
  assert.strictEqual(catalog.signature(click), 'Click    selector    button=left');
});
