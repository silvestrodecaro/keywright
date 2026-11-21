'use strict';

// Reading and writing the JSON files Keywright keeps for itself. A damaged file
// is moved aside rather than treated as empty and overwritten, and a write goes
// through a temporary sibling, so a reader or a crash never leaves half a file.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// Antivirus scanners and the search indexer briefly lock files on Windows.
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES']);
const ATTEMPTS = 6;

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Runs `operation`, trying again for a moment while the file is locked. */
function retrying(operation) {
  for (let attempt = 1; ; attempt++) {
    try {
      return operation();
    } catch (error) {
      if (!BUSY.has(error.code) || attempt >= ATTEMPTS)
        throw error;
      pause(20 * 2 ** attempt);
    }
  }
}

/** Text without the byte order mark that Notepad and PowerShell 5 write. */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Parses JSON text, with or without a byte order mark. */
function parseJson(text) {
  return JSON.parse(stripBom(text));
}

/**
 * @returns {{ status: 'missing' } | { status: 'ok', value: unknown }
 *   | { status: 'corrupt', movedTo: string | null, error: string }}
 * A file that is not valid JSON is renamed to `<name>.corrupt-<time>` and kept.
 * Other read errors (a file that stays locked, no permission) are thrown: the
 * caller must not overwrite what it could not read.
 */
function readJson(file) {
  let text;
  try {
    text = retrying(() => fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT')
      return { status: 'missing' };
    throw error;
  }
  try {
    return { status: 'ok', value: parseJson(text) };
  } catch (error) {
    const movedTo = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      retrying(() => fs.renameSync(file, movedTo));
      console.error(`${file} is not valid JSON (${error.message}); it was kept as ${movedTo}`);
      return { status: 'corrupt', movedTo, error: error.message };
    } catch (moveError) {
      console.error(`${file} is not valid JSON (${error.message}) and could not be moved aside: ${moveError.message}`);
      return { status: 'corrupt', movedTo: null, error: error.message };
    }
  }
}

/** Writes `value` as JSON through a temporary sibling, replaced in one rename. */
function writeJsonAtomic(file, value, { space = 0, mode } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, space), { encoding: 'utf8', flush: true, ...(mode ? { mode } : {}) });
    retrying(() => fs.renameSync(temporary, file));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { readJson, writeJsonAtomic, parseJson, stripBom, retrying };
