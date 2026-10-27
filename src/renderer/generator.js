'use strict';

// Test Generator tab: recorder controls, recorded steps and generated code.
(function () {
  const $ = (selector) => document.querySelector(selector);

  const STEP_ICONS = {
    openPage: '⧉', closePage: '✕', navigate: '↗', click: '◉', hover: '◌', check: '☑', uncheck: '☐',
    fill: '✎', press: '⌨', select: '☰', setInputFiles: '⇪',
    assertText: '✓', assertVisible: '✓', assertValue: '✓', assertChecked: '✓', assertSnapshot: '✓',
  };

  let currentCode = '';
  let recording = false;
  let busy = false;

  function parseViewport(value) {
    const match = /^(\d+)x(\d+)$/.exec(value);
    return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
  }

  function showError(message, install = null) {
    const el = $('#error');
    el.replaceChildren(document.createTextNode(message || ''));
    el.hidden = !message;
    if (install) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-sm btn-primary error-action';
      button.textContent = `Install ${install}`;
      button.addEventListener('click', () => installBrowser(install));
      el.append(button);
    }
  }

  async function installBrowser(name) {
    const el = $('#error');
    const log = document.createElement('pre');
    log.className = 'install-log';
    el.replaceChildren(document.createTextNode(`Installing ${name}…`), log);
    el.classList.add('is-info');
    busy = true;
    renderState();
    const unsubscribe = window.rfide.onInstallLog((text) => {
      // The CLI prints a new progress line every 10%: show the latest one.
      const lines = (log.textContent + '\n' + text).split(/[\r\n]+/).filter((line) => line.trim());
      log.textContent = lines.slice(-1).join('').replace(/\s{2,}/g, ' ');
    });
    const result = await window.rfide.installBrowser(name);
    unsubscribe();
    el.classList.remove('is-info');
    busy = false;
    renderState();
    if (!result.ok) {
      showError(result.error, name);
      return;
    }
    showError('');
    $('#record-form').requestSubmit(); // start the recording that failed
  }

  function flash(button, text) {
    const original = button.dataset.label || button.textContent;
    button.dataset.label = original;
    button.textContent = text;
    setTimeout(() => { button.textContent = original; }, 1200);
  }

  function renderState() {
    const button = $('#record');
    button.classList.toggle('is-recording', recording);
    button.querySelector('.label').textContent = recording ? 'Stop' : 'Record';
    button.disabled = busy;
    for (const el of ['#url', '#browser', '#viewport'])
      $(el).disabled = recording || busy;
    $('#status').classList.toggle('is-recording', recording);
    $('#status .status-text').textContent = busy ? 'Launching browser…' : recording ? 'Recording' : 'Idle';
  }

  function renderCode(code) {
    currentCode = code;
    const target = $('#code');
    const atBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 4;
    target.replaceChildren(...window.highlightRobot(code));
    if (atBottom)
      target.scrollTop = target.scrollHeight;
  }

  function renderSteps(steps) {
    const list = $('#steps');
    list.replaceChildren(...steps.map((step, index) => {
      const item = document.createElement('li');
      item.className = 'step' + (step.name.startsWith('assert') ? ' is-assert' : '');

      const icon = document.createElement('span');
      icon.className = 'step-icon';
      icon.textContent = STEP_ICONS[step.name] || '•';

      const text = document.createElement('div');
      text.className = 'step-text';
      const name = document.createElement('span');
      name.className = 'step-name';
      name.textContent = step.name + (step.signals.length ? ` · ${step.signals.join(', ')}` : '');
      const detail = document.createElement('span');
      detail.className = 'step-detail';
      detail.textContent = step.detail;
      detail.title = step.detail;
      text.append(name, detail);

      const remove = document.createElement('button');
      remove.className = 'step-remove';
      remove.type = 'button';
      remove.title = 'Remove step';
      remove.textContent = '✕';
      remove.addEventListener('click', () => window.rfide.removeStep(index));

      item.append(icon, text, remove);
      return item;
    }));
    $('#step-count').textContent = String(steps.length);
    $('#steps-empty').hidden = steps.length > 0;
    list.scrollTop = list.scrollHeight;
  }

  $('#record-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy)
      return;
    showError('');
    if (recording) {
      await window.rfide.stopRecording();
      return;
    }
    busy = true;
    renderState();
    const result = await window.rfide.startRecording({
      url: $('#url').value.trim(),
      browser: $('#browser').value,
      viewport: parseViewport($('#viewport').value),
    });
    busy = false;
    renderState();
    if (!result.ok)
      showError(result.error, result.install);
  });

  $('#test-name').addEventListener('input', (event) => {
    window.rfide.setGeneratorOptions({ testName: event.target.value.trim() || 'Recorded Test' });
  });

  $('#copy').addEventListener('click', async (event) => {
    await window.rfide.copyToClipboard(currentCode);
    flash(event.currentTarget, 'Copied');
  });

  $('#save').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const filePath = await window.rfide.saveFile(currentCode);
    if (filePath) {
      flash(button, 'Saved');
      window.dispatchEvent(new CustomEvent('rfide:file-saved', { detail: { filePath } }));
    }
  });

  $('#clear').addEventListener('click', () => window.rfide.clearRecording());

  window.rfide.onCode(({ code, steps }) => {
    renderCode(code);
    renderSteps(steps);
  });

  window.rfide.onState((state) => {
    recording = state.recording;
    renderState();
  });

  renderState();
})();
