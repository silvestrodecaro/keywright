// Brings latest.yml and the .blockmap in line with the signed installer. Signing changes the file, so
// the sha512 and size electron-builder wrote for the unsigned one would make installed copies reject
// the update.
//   node scripts/update-info.mjs <installer.exe> <latest.yml>
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
// Not part of electron-builder's public API: electron-builder is pinned by package-lock.json.
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');

const [installer, latestYml] = process.argv.slice(2);
if (!installer || !latestYml) {
  console.error('usage: node scripts/update-info.mjs <installer.exe> <latest.yml>');
  process.exit(1);
}

const text = await fs.readFile(latestYml, 'utf8');
if (!text.includes(`url: ${path.basename(installer)}\n`))
  throw new Error(`${latestYml} does not describe ${path.basename(installer)}`);

const { sha512, size } = await buildBlockMap(installer, 'gzip', `${installer}.blockmap`);
await fs.writeFile(latestYml, text
  .replace(/^(\s*sha512: ).*$/gm, `$1${sha512}`)
  .replace(/^(\s*size: ).*$/gm, `$1${size}`));
console.log(`${latestYml}: sha512 ${sha512}, size ${size}`);
