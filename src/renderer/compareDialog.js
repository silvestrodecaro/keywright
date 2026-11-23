'use strict';

// The comparison shown when a file being saved changed on disk: the disk version and the
// editor version side by side until the user saves theirs, reloads, or cancels.
(function (factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory();
  else
    window.RFCompareDialog = factory();
})(function () {
  function create({ editor, doc = document }) {
    const $ = (selector) => doc.querySelector(selector);

    /** Shows a conflicting file's disk and editor versions side by side until the user decides. */
    function compareVersions({ path, disk, mine }) {
      const view = $('#compare-view');
      const returnFocus = doc.activeElement;
      $('#compare-title').textContent = `${path} changed on disk`;
      view.hidden = false;
      const comparison = editor.createComparison($('#compare-editor'), { path, disk, mine });
      return new Promise((resolve) => {
        const buttons = { '#compare-save': 'save', '#compare-reload': 'reload', '#compare-cancel': 'cancel' };
        const finish = (choice) => {
          const content = comparison.content();
          for (const selector of Object.keys(buttons))
            $(selector).onclick = null;
          view.onkeydown = null;
          comparison.dispose();
          view.hidden = true;
          returnFocus?.focus?.();
          resolve(choice === 'save' ? { choice, content } : { choice });
        };
        for (const [selector, choice] of Object.entries(buttons))
          $(selector).onclick = () => finish(choice);
        view.onkeydown = (event) => {
          if (event.key === 'Escape' && !event.defaultPrevented) {
            event.preventDefault();
            finish('cancel');
          }
        };
      });
    }

    return { compareVersions };
  }

  return { create };
});
