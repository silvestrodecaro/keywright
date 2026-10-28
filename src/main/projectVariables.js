'use strict';

// Variables known across the project, for the editor's undefined-variable check:
//  - runtime: set for other files at run time (Set Test/Suite/Global Variable, VAR scope=) in any file;
//  - suite: defined in Variables sections and variable files of any file. Keywords of resource
//    files run in the scope of the suites importing them, so they may use these.
// `dynamicSuite` is true when some variable file cannot be read statically (get_variables(),
// module names, missing files): resource files are not checked then.

const fs = require('fs');
const path = require('path');
const nav = require('../renderer/editor/navigation');

const SKIP_DIRS = new Set(['.git', '.venv', 'venv', 'node_modules', '__pycache__', 'results']);

function robotFiles(root, relative = '', depth = 0) {
  if (depth > 8)
    return [];
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      return SKIP_DIRS.has(entry.name) || entry.name.startsWith('.') ? [] : robotFiles(root, entryPath, depth + 1);
    return /\.(robot|resource)$/i.test(entry.name) ? [entryPath] : [];
  });
}

function readLines(root, relative) {
  try {
    return fs.readFileSync(path.join(root, relative), 'utf8').split(/\r?\n/);
  } catch {
    return null;
  }
}

/** @returns {{ runtime: string[], suite: string[], dynamicSuite: boolean }} normalized variable names */
function projectVariables(root) {
  const runtime = new Set();
  const suite = new Set();
  let dynamicSuite = false;
  for (const file of robotFiles(root)) {
    const lines = readLines(root, file);
    if (!lines)
      continue;
    const parsed = nav.parseFile(lines);
    parsed.locals.filter((d) => d.fileWide).forEach((d) => runtime.add(d.key));
    parsed.variables.forEach((d) => suite.add(d.key));
    for (const item of parsed.imports.filter((i) => i.type === 'variables')) {
      const target = nav.importCandidates(file, item.path).find((candidate) => fs.existsSync(path.join(root, candidate)));
      const variableLines = target && readLines(root, target);
      if (!variableLines || nav.isDynamicVariableFile(target, variableLines)) {
        dynamicSuite = true;
        continue;
      }
      nav.variableFileDefinitions(target, variableLines).forEach((d) => suite.add(d.key));
    }
  }
  return { runtime: [...runtime], suite: [...suite], dynamicSuite };
}

module.exports = { projectVariables };
