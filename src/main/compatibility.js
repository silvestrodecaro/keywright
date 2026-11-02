'use strict';

// Read-only aliases for projects and environments created before the Keywright rename.
const LEGACY_CONFIG_FILE = 'rfide.json';
const LEGACY_HISTORY_FILE = '.rfide-history.json';
const ENVIRONMENT_NAMES = ['PYTHON', 'TEST', 'UPDATE_URL', 'PORT', 'SELECT', 'DEBUG', 'BREAKPOINTS', 'PAUSE_ON_FAILURE'];

function environmentValue(env, name) {
  return env[`KEYWRIGHT_${name}`] ?? env[`RFIDE_${name}`];
}

function normalizeEnvironment(source) {
  const env = { ...source };
  for (const name of ENVIRONMENT_NAMES) {
    const legacy = 'RFIDE_' + name;
    const modern = 'KEYWRIGHT_' + name;
    if (env[modern] === undefined && env[legacy] !== undefined) env[modern] = env[legacy];
    delete env[legacy];
  }
  return env;
}

module.exports = { LEGACY_CONFIG_FILE, LEGACY_HISTORY_FILE, environmentValue, normalizeEnvironment };
