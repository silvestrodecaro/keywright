'use strict';

// Temporary folders for tests, removed when the test file has finished.

const { after } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const created = [];

// Registered when a test file requires this module, so it runs after all its tests.
after(() => {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // still in use (e.g. by a process that has not exited yet): left to the system
    }
  }
});

/** A new empty folder in the system temp folder: rfide-<prefix>-XXXXXX. */
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rfide-${prefix}-`));
  created.push(dir);
  return dir;
}

module.exports = { tempDir };
