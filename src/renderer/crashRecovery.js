'use strict';

// Crash recovery: unsaved buffers are copied to the IDE's data folder while editing.
// Nothing is written until a pending recovery has been restored or discarded, so opening
// a project cannot overwrite it. app.js owns the tabs and passes accessors for them.
(function (factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory();
  else
    window.RFCrashRecovery = factory();
})(function () {
  const files = (count) => (count === 1 ? '1 file' : `${count} files`);

  /** The copies to store: the unsaved buffers of open tabs, with the revision they started from. */
  function recoveryEntries(dirtyPaths, tabs, getContent) {
    return dirtyPaths
      .map((path) => ({ path, tab: tabs.find((t) => t.path === path) }))
      .filter(({ tab }) => tab)
      .map(({ path, tab }) => ({ path, content: getContent(path), revision: tab.revision ?? null }));
  }

  /** The tab for a restored file that is not open, or null when the file cannot be read as text. */
  function restoredTab(entry, disk) {
    if (disk && disk.content === null)
      return null;
    // A file changed on disk keeps the revision the edits started from, so
    // saving it raises the usual conflict instead of overwriting silently.
    const revision = disk && disk.revision === entry.revision ? disk.revision : (entry.revision ?? null);
    return { path: entry.path, content: disk ? disk.content : '', revision: disk ? revision : null };
  }

  function noticeText(entries) {
    return `Keywright closed with unsaved changes in ${files(entries.length)}: ${entries.map((e) => e.path).join(', ')}`;
  }

  function restoredStatus(entries, failed) {
    return failed.length
      ? { text: `Could not restore ${failed.join(', ')}`, isError: true }
      : { text: `Restored unsaved changes in ${files(entries.length)}. Save to keep them.`, isError: false };
  }

  function create({ api, editor, tabs, addTab, showRestored, renderTabs, status, doc = document }) {
    const $ = (selector) => doc.querySelector(selector);
    let recoveryTimer = null;
    let recoveryReady = false;

    /** The main process refuses AI changes to files with unsaved editor changes. */
    let reportedDirty = '';
    function reportDirtyFiles() {
      const paths = editor.dirtyPaths().filter((path) => tabs().some((tab) => tab.path === path));
      const key = JSON.stringify(paths);
      if (key !== reportedDirty) {
        reportedDirty = key;
        api.reportDirtyFiles(paths);
      }
    }

    function storeRecovery() {
      reportDirtyFiles();
      clearTimeout(recoveryTimer);
      recoveryTimer = null;
      return recoveryReady ? api.storeRecovery(recoveryEntries(editor.dirtyPaths(), tabs(), (path) => editor.getContent(path))) : Promise.resolve();
    }

    /** Stores at most once per second while typing. */
    function scheduleRecovery() {
      reportDirtyFiles();
      if (recoveryReady && !recoveryTimer)
        recoveryTimer = setTimeout(storeRecovery, 1000);
    }

    // A new offer or suspend() ends the earlier offer and restore: they must not store, show or
    // open the previous project's copies, or allow storing before the new offer is answered.
    let recoveryRequest = 0;

    async function offerRecovery() {
      const request = ++recoveryRequest;
      recoveryReady = false;
      // The last copy may predate a save made just before closing: skip what is already on disk.
      const entries = [];
      for (const entry of await api.readRecovery()) {
        const disk = await api.readProjectFile(entry.path).catch(() => null);
        if (!disk || disk.content !== entry.content)
          entries.push(entry);
      }
      if (request !== recoveryRequest)
        return;
      if (!entries.length) {
        recoveryReady = true;
        await storeRecovery();
        return;
      }
      const notice = $('#recovery-notice');
      $('#recovery-notice-text').textContent = noticeText(entries);
      notice.dataset.entries = JSON.stringify(entries);
      notice.hidden = false;
    }

    async function restoreRecovery(entries, request) {
      const failed = [];
      for (const entry of entries) {
        if (!tabs().some((t) => t.path === entry.path)) {
          let disk = null;
          try {
            disk = await api.readProjectFile(entry.path);
          } catch {
            // Deleted since the crash: saving recreates it.
          }
          if (request !== recoveryRequest)
            return;
          const tab = restoredTab(entry, disk);
          if (!tab) {
            failed.push(entry.path);
            continue;
          }
          addTab(tab);
        }
        showRestored(entry.path);
        editor.restoreContent(entry.path, entry.content);
      }
      renderTabs();
      const shown = restoredStatus(entries, failed);
      status(shown.text, shown.isError);
    }

    async function finishRecovery(restore) {
      const request = recoveryRequest;
      const notice = $('#recovery-notice');
      const entries = JSON.parse(notice.dataset.entries || '[]');
      notice.hidden = true;
      delete notice.dataset.entries;
      if (restore)
        await restoreRecovery(entries, request);
      if (request !== recoveryRequest)
        return;
      recoveryReady = true;
      await storeRecovery();
    }

    /** Closing or reopening the project: stop storing and drop a pending offer or restore. */
    function suspend() {
      recoveryRequest++;
      recoveryReady = false;
      $('#recovery-notice').hidden = true;
    }

    $('#recovery-restore').addEventListener('click', () => finishRecovery(true));
    $('#recovery-discard').addEventListener('click', () => finishRecovery(false));
    editor.onDirtyChange(scheduleRecovery);

    return { offer: offerRecovery, store: storeRecovery, schedule: scheduleRecovery, suspend };
  }

  return { create, recoveryEntries, restoredTab, noticeText, restoredStatus };
});
