'use strict';

// Search and replace in the project's files on disk. Open files are searched
// by the renderer (their unsaved edits count), which excludes them here.

const fs = require('fs');
const path = require('path');
const { buildRegex, findInText, applyReplacements, includeFilter } = require('../renderer/searchCore');

const SKIP_DIRS = new Set(['.git', '.venv', 'venv', 'node_modules', '__pycache__', '.pytest_cache', '.idea', '.vscode']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_RESULTS = 5000;

/** Project-relative paths of the files to search, skipping tool folders and the results folder. */
function projectFiles(root, outputDir, relative = '', depth = 0) {
  if (depth > 12)
    return [];
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      return SKIP_DIRS.has(entry.name) || entryPath === outputDir ? [] : projectFiles(root, outputDir, entryPath, depth + 1);
    return entry.isFile() ? [entryPath] : [];
  });
}

/** Text content, or null for binary and large files. */
function readText(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.length > MAX_FILE_BYTES || buffer.includes(0))
    return null;
  return buffer.toString('utf8');
}

function resolve(root, relative) {
  const target = path.resolve(root, relative);
  const fromRoot = path.relative(root, target);
  if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot))
    throw new Error(`Path is outside the project: ${relative}`);
  return target;
}

/**
 * @param {string} root
 * @param {{ query: string, regex?: boolean, caseSensitive?: boolean, wholeWord?: boolean,
 *           include?: string, replacement?: string }} options replacement: preview of each replacement
 * @param {{ exclude?: string[], outputDir?: string }} [scope] exclude: files searched by the renderer
 * @returns {{ files: { path: string, matches: object[] }[], total: number, truncated: boolean }}
 */
function searchProject(root, options, { exclude = [], outputDir = 'results' } = {}) {
  const re = buildRegex(options);
  const include = includeFilter(options.include);
  const excluded = new Set(exclude);
  const files = [];
  let total = 0;
  for (const relative of projectFiles(root, outputDir.replace(/\\/g, '/').replace(/\/$/, ''))) {
    if (excluded.has(relative) || !include(relative))
      continue;
    let text;
    try {
      text = readText(path.join(root, relative));
    } catch {
      continue;
    }
    if (text === null)
      continue;
    const matches = findInText(text, re, { replacement: options.replacement, regex: options.regex, limit: MAX_RESULTS - total });
    if (matches.length) {
      files.push({ path: relative, matches });
      total += matches.length;
    }
    if (total >= MAX_RESULTS)
      return { files, total, truncated: true };
  }
  return { files, total, truncated: false };
}

/**
 * Replaces matches in files on disk, found again with the same options.
 * @param {{ path: string, at?: { line: number, column: number }[] }[]} entries at: only these matches
 * @returns {{ count: number, files: string[] }}
 */
function replaceInProject(root, options, replacement, entries) {
  const re = buildRegex(options);
  let count = 0;
  const changed = [];
  for (const entry of entries) {
    const file = resolve(root, entry.path);
    const text = readText(file);
    if (text === null)
      continue;
    let matches = findInText(text, re, { replacement, regex: options.regex });
    if (entry.at)
      matches = matches.filter((m) => entry.at.some((at) => at.line === m.line && at.column === m.column));
    if (!matches.length)
      continue;
    fs.writeFileSync(file, applyReplacements(text, matches));
    count += matches.length;
    changed.push(entry.path);
  }
  return { count, files: changed };
}

module.exports = { searchProject, replaceInProject, projectFiles };
