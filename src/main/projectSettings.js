'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CONFIG_FILE, DEFAULT_CONFIG } = require('./projectTemplate');

/** The project's keywright.json as an object; {} when there is none. */
function readConfigFile(root) {
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file))
    return {};
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${error.message}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error(`${CONFIG_FILE} is not valid JSON: it must contain an object.`);
  return config;
}

/**
 * The settings shown in the Project Settings dialog.
 * @returns {{ testsDir: string, resourcesDir: string, outputDir: string, python: string | null }}
 */
function readSettings(root) {
  const config = { ...DEFAULT_CONFIG, ...readConfigFile(root) };
  return {
    testsDir: String(config.testsDir),
    resourcesDir: String(config.resourcesDir),
    outputDir: String(config.outputDir),
    python: config.python ? String(config.python) : null,
  };
}

/**
 * A path typed or chosen in the dialog: relative to the project with forward
 * slashes when it is inside the project ("." for the project itself), absolute
 * otherwise.
 */
function normalizePath(root, value) {
  const text = String(value ?? '').trim();
  if (!text)
    return null;
  const absolute = path.resolve(root, text.replace(/\\/g, '/'));
  const relative = path.relative(root, absolute);
  const inside = !path.isAbsolute(relative) && relative.split(/[\\/]/)[0] !== '..';
  return {
    absolute,
    inside,
    value: inside ? (relative ? relative.replace(/\\/g, '/') : '.') : absolute.replace(/\\/g, '/'),
  };
}

const isDirectory = (target) => fs.existsSync(target) && fs.statSync(target).isDirectory();
const isFile = (target) => fs.existsSync(target) && fs.statSync(target).isFile();

/**
 * @param {string} root
 * @param {{ testsDir?: string, resourcesDir?: string, outputDir?: string, python?: string | null }} values
 * @returns {{ settings: { testsDir: string, resourcesDir: string, outputDir: string, python: string | null },
 *   errors: Record<string, string> }}
 */
function validateSettings(root, values) {
  const errors = {};
  const settings = {};

  const tests = normalizePath(root, values.testsDir);
  if (!tests)
    errors.testsDir = 'Enter a folder.';
  else if (!tests.inside)
    errors.testsDir = 'Choose a folder inside the project.';
  else if (!isDirectory(tests.absolute))
    errors.testsDir = `Folder not found in the project: ${tests.value}`;
  settings.testsDir = tests?.value ?? '';

  const resources = normalizePath(root, values.resourcesDir);
  if (!resources)
    errors.resourcesDir = 'Enter a folder.';
  else if (!resources.inside)
    errors.resourcesDir = 'Choose a folder inside the project.';
  settings.resourcesDir = resources?.value ?? '';

  const output = normalizePath(root, values.outputDir);
  if (!output)
    errors.outputDir = 'Enter a folder.';
  else if (output.value === '.')
    errors.outputDir = 'Use a separate folder for results, not the project folder.';
  else if (tests && output.absolute === tests.absolute)
    errors.outputDir = 'Use a folder separate from the tests folder.';
  settings.outputDir = output?.value ?? '';

  const python = normalizePath(root, values.python);
  if (python && !isFile(python.absolute))
    errors.python = `File not found: ${python.value}`;
  settings.python = python ? python.value : null;

  return { settings, errors };
}

/**
 * Validates and saves the settings in keywright.json. Other properties are kept.
 * @returns {{ ok: boolean, errors: Record<string, string> }}
 */
function writeSettings(root, values) {
  const existing = readConfigFile(root);
  const { settings, errors } = validateSettings(root, values);
  if (Object.keys(errors).length)
    return { ok: false, errors };
  const config = { ...DEFAULT_CONFIG, ...existing, ...settings };
  const file = path.join(root, CONFIG_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(temporary, file);
  return { ok: true, errors: {} };
}

module.exports = { readSettings, validateSettings, writeSettings };
