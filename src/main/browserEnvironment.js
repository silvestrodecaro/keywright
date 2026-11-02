'use strict';

const os = require('node:os');
const path = require('node:path');

/** Keep browser executables out of project virtual environments. */
function browserEnvironment(source = process.env) {
  const env = { ...source };
  if (!env.PLAYWRIGHT_BROWSERS_PATH) {
    let cache;
    if (process.platform === 'win32')
      cache = source.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    else if (process.platform === 'darwin')
      cache = path.join(os.homedir(), 'Library', 'Caches');
    else
      cache = source.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
    env.PLAYWRIGHT_BROWSERS_PATH = path.join(cache, 'ms-playwright');
  }
  return env;
}

module.exports = { browserEnvironment };
