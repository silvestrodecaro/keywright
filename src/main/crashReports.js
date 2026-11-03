'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPORT = /^\d{4}-\d{2}-\d{2}T[\dZ-]+-[a-z0-9-]+\.txt$/;
const MAX_DETAILS = 300;

/**
 * Local crash reports: plain text files with the versions and the app's recent
 * diagnostic events (the same events as the launch log). Nothing is uploaded and
 * no project file content is recorded.
 */
class CrashReports {
  /**
   * @param {string} folder
   * @param {{ versions: { keywright: string, electron: string, chromium: string, node: string, os: string },
   *   events?: number, keep?: number, now?: () => Date }} options
   */
  constructor(folder, { versions, events = 100, keep = 20, now = () => new Date() }) {
    this.folder = folder;
    this.versions = versions;
    this.limit = events;
    this.keep = keep;
    this.now = now;
    /** @type {string[]} */
    this.events = [];
  }

  /** Remembers a diagnostic event for the next report. */
  note(event, details) {
    let text = details && Object.keys(details).length ? JSON.stringify(details) : '';
    if (text.length > MAX_DETAILS)
      text = `${text.slice(0, MAX_DETAILS)}…`;
    this.events.push(`${this.now().toISOString().slice(11)} ${event}${text ? ` ${text}` : ''}`);
    if (this.events.length > this.limit)
      this.events.splice(0, this.events.length - this.limit);
  }

  /**
   * Writes a report and removes the oldest beyond the limit.
   * @param {string} event what happened, e.g. "Window stopped"
   * @param {Record<string, unknown>} [facts]
   * @returns {string} the report's path
   */
  write(event, facts = {}) {
    const time = this.now().toISOString();
    const { keywright, electron, chromium, node, os } = this.versions;
    const lines = [
      'Keywright crash report',
      '',
      `Event: ${event}`,
      ...Object.entries(facts).map(([key, value]) => `${key}: ${value}`),
      `Time: ${time}`,
      `Keywright ${keywright}, Electron ${electron}, Chromium ${chromium}, Node.js ${node}`,
      `System: ${os}`,
      '',
      'This report lists versions and recent app events, not the content of your files.',
      'Review it before sharing: error messages can contain file paths and project names.',
      '',
      'Recent events (oldest first):',
      ...this.events,
      '',
    ];
    const slug = event.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report';
    const file = path.join(this.folder, `${time.replace(/[:.]/g, '-')}-${slug}.txt`);
    fs.mkdirSync(this.folder, { recursive: true });
    fs.writeFileSync(file, lines.join('\n'));
    this.prune();
    return file;
  }

  prune() {
    const reports = fs.readdirSync(this.folder).filter((name) => REPORT.test(name)).sort();
    for (const name of reports.slice(0, Math.max(0, reports.length - this.keep)))
      fs.rmSync(path.join(this.folder, name), { force: true });
  }
}

module.exports = { CrashReports };
