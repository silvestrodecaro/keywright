'use strict';

// Record at cursor: browser steps recorded straight into the open file, and Pick locator:
// the selector of the clicked element inserted at the cursor. Both use the Test Generator's
// browser and viewport settings. app.js owns the tabs and passes accessors for the active one.
(function (factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory();
  else
    window.RFRecordAtCursor = factory();
})(function () {
  /** The Test Generator's viewport setting ("1280x720"), or null for the default. */
  function parseViewport(value) {
    const match = /^(\d+)x(\d+)$/.exec(value);
    return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
  }

  /** Steps can be recorded into a readable .robot or .resource file. */
  function isRecordable(file) {
    return !!file && file.content !== null && /\.(robot|resource)$/i.test(file.path);
  }

  function create({ api, editor, showError, status, activeTab, activeFile }) {
    const $ = (selector) => document.querySelector(selector);

    let recorderBusy = false; // a recording (here or in the Test Generator) is running
    let recordingHere = false;
    let picking = false; // a locator is being picked (here or in the Test Generator)

    function viewportSetting() {
      return parseViewport($('#viewport').value);
    }

    function renderRecordBar() {
      const recordable = isRecordable(activeFile());
      $('#record-at-cursor').hidden = !recordable;
      $('#record-at-cursor').disabled = recorderBusy || picking;
      $('#pick-at-cursor').hidden = !recordable;
      $('#pick-at-cursor').disabled = recordingHere; // the editor is read-only while recording into it
      const bar = $('#record-bar');
      if (recordingHere) {
        bar.hidden = false;
        $('#record-url').hidden = true;
        $('#record-start').hidden = true;
        $('#record-cancel').hidden = true;
        $('#record-stop').hidden = false;
      } else {
        $('#record-url').hidden = false;
        $('#record-start').hidden = false;
        $('#record-start').disabled = recorderBusy;
        $('#record-cancel').hidden = false;
        $('#record-stop').hidden = true;
        if (!recordable)
          bar.hidden = true;
      }
    }

    $('#record-at-cursor').addEventListener('click', () => {
      showError($('#record-error'), '');
      $('#record-label').textContent = `Record into line ${editor.cursorLine() || 1}`;
      if (!$('#record-url').value)
        $('#record-url').value = $('#url').value;
      $('#record-bar').hidden = false;
      renderRecordBar();
      $('#record-url').focus();
    });

    $('#record-cancel').addEventListener('click', () => {
      $('#record-bar').hidden = true;
      editor.focus();
    });

    $('#record-bar').addEventListener('submit', async (event) => {
      event.preventDefault();
      const path = activeTab();
      if (recorderBusy || !editor.startRecording(path))
        return;
      showError($('#record-error'), '');
      recordingHere = true;
      $('#record-label').textContent = 'Launching browser…';
      renderRecordBar();
      const result = await api.startRecording({
        url: $('#record-url').value.trim(),
        browser: $('#browser').value,
        viewport: viewportSetting(),
      });
      if (result.ok)
        $('#record-label').textContent = `Recording into ${path.split('/').pop()}: interact with the browser, steps appear below`;
      else {
        editor.stopRecording();
        recordingHere = false;
        const hint = result.install ? ' Install it from the Test Generator tab.' : '';
        showError($('#record-error'), result.error + hint);
        $('#record-label').textContent = 'Record at cursor';
        renderRecordBar();
      }
    });

    $('#record-stop').addEventListener('click', () => api.stopRecording());

    // Pick locator: the selector of the clicked element is inserted at the cursor.
    // Uses the Test Generator's browser while it records, otherwise its settings.

    $('#pick-at-cursor').addEventListener('click', async () => {
      if (picking) {
        api.cancelPickLocator();
        return;
      }
      const path = activeTab();
      showError($('#record-error'), '');
      status('Click an element in the browser to insert its locator');
      const result = await api.pickLocator({
        url: $('#record-url').value.trim() || $('#url').value.trim(),
        browser: $('#browser').value,
        viewport: viewportSetting(),
      });
      if (!result.ok) {
        const hint = result.install ? ' Install it from the Test Generator tab.' : '';
        showError($('#record-error'), result.error + hint);
        status('Could not pick a locator', true);
      } else if (result.cancelled) {
        status('Pick cancelled');
      } else if (editor.currentPath() === path && editor.insertCell(result.cell)) {
        status(`Inserted ${result.selector}`);
      } else {
        await api.copyToClipboard(result.cell);
        status(`Copied ${result.selector} to the clipboard`);
      }
    });

    api.onPickState((state) => {
      picking = state.picking;
      const button = $('#pick-at-cursor');
      button.classList.toggle('is-picking', picking);
      button.textContent = picking ? '✕ Cancel pick' : '◎ Pick locator';
      renderRecordBar();
    });

    api.onCode(({ lines }) => {
      if (recordingHere)
        editor.updateRecording(lines);
    });

    api.onState((state) => {
      recorderBusy = state.recording;
      if (!state.recording && recordingHere) {
        recordingHere = false;
        const count = editor.stopRecording();
        $('#record-bar').hidden = true;
        status(count ? `Inserted ${count} recorded step${count === 1 ? '' : 's'}` : 'Nothing was recorded');
        editor.focus();
      }
      renderRecordBar();
    });

    return { render: renderRecordBar };
  }

  return { create, parseViewport, isRecordable };
});
