'use strict';

// Updates from the GitHub Releases of the project (electron-updater, "publish"
// in package.json). Only the installed app updates itself; nothing is
// downloaded without the user's consent.

const { app } = require('electron');

function plainNotes(notes) {
  if (!notes)
    return '';
  const text = Array.isArray(notes) ? notes.map((n) => n.note || '').join('\n') : String(notes);
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

class Updater {
  /** @param {(state: object) => void} onState receives { status, version?, percent?, notes?, error? } */
  constructor(onState) {
    this._onState = onState;
    this._state = { status: 'idle', current: app.getVersion() };
    this._updater = null;
  }

  get state() {
    return this._state;
  }

  init() {
    if (!app.isPackaged) {
      this._set({ status: 'disabled', reason: 'Updates are checked by the installed app only.' });
      return;
    }
    const { autoUpdater } = require('electron-updater');
    this._updater = autoUpdater;
    // Another update server (e.g. an internal mirror, or a local one in tests): a folder served
    // over http(s) with latest.yml and the installer.
    if (process.env.RFIDE_UPDATE_URL)
      autoUpdater.setFeedURL({ provider: 'generic', url: process.env.RFIDE_UPDATE_URL });
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true; // a downloaded update is installed on the next quit anyway
    autoUpdater.on('checking-for-update', () => this._set({ status: 'checking' }));
    autoUpdater.on('update-available', (info) => this._set({ status: 'available', version: info.version, notes: plainNotes(info.releaseNotes) }));
    autoUpdater.on('update-not-available', () => this._set({ status: 'latest' }));
    autoUpdater.on('download-progress', (progress) => this._set({ status: 'downloading', version: this._state.version, percent: Math.round(progress.percent) }));
    autoUpdater.on('update-downloaded', (info) => this._set({ status: 'downloaded', version: info.version }));
    autoUpdater.on('error', (error) => {
      const message = String(error && error.message || error);
      this._set({ status: 'error', error: /\b404\b/.test(message) ? 'no release has been published yet.'
        : /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::ERR_/.test(message) ? 'no connection to GitHub.' : message.split('\n')[0] });
    });
    setTimeout(() => this.check(), 5000); // not during start-up
  }

  check() {
    if (this._updater && !['checking', 'downloading', 'downloaded'].includes(this._state.status))
      this._updater.checkForUpdates().catch(() => {}); // reported by the 'error' event
  }

  download() {
    if (this._updater && this._state.status === 'available')
      this._updater.downloadUpdate().catch(() => {});
  }

  /** Quits, installs the downloaded update (silently, per user) and starts the new version. */
  install() {
    if (this._updater && this._state.status === 'downloaded')
      this._updater.quitAndInstall(true, true);
  }

  _set(state) {
    this._state = { current: app.getVersion(), ...state };
    this._onState(this._state);
  }
}

module.exports = { Updater };
