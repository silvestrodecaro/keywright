// Bundles the Monaco editor integration for the renderer:
//   src/renderer/editor/index.js -> src/renderer/dist/editor.js (+ editor.css, fonts)
//   Monaco web workers            -> src/renderer/dist/*.worker.js
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const monaco = path.join(root, 'node_modules', 'monaco-editor', 'esm', 'vs');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: {
    editor: path.join(root, 'src', 'renderer', 'editor', 'index.js'),
    'editor.worker': path.join(monaco, 'editor', 'editor.worker.js'),
    'json.worker': path.join(monaco, 'languages', 'features', 'json', 'json.worker.js'),
  },
  outdir: path.join(root, 'src', 'renderer', 'dist'),
  bundle: true,
  format: 'iife',
  target: 'chrome130',
  minify: !watch,
  sourcemap: watch,
  loader: { '.ttf': 'file', '.woff': 'file', '.woff2': 'file' },
  logLevel: 'info',
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}
