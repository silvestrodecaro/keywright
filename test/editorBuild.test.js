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

test('the editor has no language service whose worker is not shipped', async () => {
  const { options } = await import('../scripts/build.mjs');
  const result = await esbuild.build({ ...options, write: false, metafile: true, logLevel: 'silent' });
  const outputs = Object.entries(result.metafile.outputs);
  const inputs = Object.keys(outputs.find(([file]) => file.endsWith('dist/editor.js'))[1].inputs).map((file) => file.replace(/\\/g, '/'));
  const services = new Set(inputs.map((file) => /^node_modules\/.*\/languages\/features\/(\w+)\/register\.js$/.exec(file)?.[1]).filter(Boolean));
  for (const name of services)
    assert.ok(outputs.some(([file]) => file.endsWith(`${name}.worker.js`)), `${name} needs a worker`);
  assert.ok(services.has('json'));
  // Their syntax colors do not need one.
  for (const name of ['css', 'html', 'javascript', 'python', 'typescript'])
    assert.ok(inputs.some((file) => file.endsWith(`/languages/definitions/${name}/register.js`)), name);
});
