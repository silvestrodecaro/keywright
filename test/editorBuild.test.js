'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');

test('the shipped editor uses the maintained sanitizer package instead of Monaco\'s vendored copy', async () => {
  const { options } = await import('../scripts/build.mjs');
  const result = await esbuild.build({ ...options, write: false, metafile: true, logLevel: 'silent' });
  const editor = Object.entries(result.metafile.outputs).find(([file]) => /[/\\]editor\.js$/.test(file));
  assert.ok(editor, 'the renderer bundle was emitted');
  const inputs = Object.keys(editor[1].inputs).map((file) => file.replace(/\\/g, '/'));
  assert.ok(inputs.some((file) => /node_modules\/dompurify\/dist\//.test(file)),
    'the patched npm package must contribute to the shipped renderer');
  assert.ok(!inputs.some((file) => /monaco-editor\/.*\/dompurify\//.test(file)),
    'the bundled Monaco sanitizer must not bypass dependency updates');
});
