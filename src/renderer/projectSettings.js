'use strict';

// Project Settings dialog: edits keywright.json through the main process, which
// validates and saves it. app.js reopens the project after a save.
window.RFProjectSettings = (() => {
  const $ = (selector) => document.querySelector(selector);
  // Setting -> element id suffix.
  const FIELDS = { testsDir: 'tests', resourcesDir: 'resources', outputDir: 'output', python: 'python' };
  const isAbsolute = (value) => /^([a-zA-Z]:)?[\\/]/.test(value);
  const slashes = (value) => value.replace(/\\/g, '/').replace(/\/+$/, '');

  /**
   * @param {{ api: object, root: () => string, reopen: () => Promise<unknown> }} options
   */
  function create({ api, root, reopen }) {
    const dialog = $('#settings');
    const form = $('#settings-form');
    const input = (key) => $(`#settings-${FIELDS[key]}`);
    let saving = false;

    function showFormError(message) {
      $('#settings-form-error').textContent = message || '';
      $('#settings-form-error').hidden = !message;
    }

    function showErrors(errors) {
      for (const [key, id] of Object.entries(FIELDS)) {
        const message = errors[key] || '';
        $(`#settings-${id}-error`).textContent = message;
        $(`#settings-${id}-error`).hidden = !message;
        input(key).setAttribute('aria-invalid', String(!!message));
      }
      const first = Object.keys(FIELDS).find((key) => errors[key]);
      if (first)
        input(first).focus();
    }

    function setEnabled(enabled) {
      for (const element of form.querySelectorAll('input, button:not(#settings-cancel)'))
        element.disabled = !enabled;
    }

    async function open() {
      if (dialog.open)
        return;
      showErrors({});
      showFormError('');
      let settings = null;
      try {
        settings = await api.projectSettings();
      } catch (error) {
        showFormError(error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      }
      for (const key of Object.keys(FIELDS))
        input(key).value = settings?.[key] ?? '';
      setEnabled(!!settings);
      dialog.showModal();
      (settings ? input('testsDir') : $('#settings-cancel')).focus();
    }

    /** A chosen path, relative to the project when it is inside it. */
    function projectPath(chosen) {
      const base = slashes(root());
      const value = slashes(chosen);
      if (value.toLowerCase() === base.toLowerCase())
        return '.';
      if (value.toLowerCase().startsWith(`${base.toLowerCase()}/`))
        return value.slice(base.length + 1);
      return chosen;
    }

    function startPath(key) {
      const value = input(key).value.trim();
      if (!value)
        return root();
      return isAbsolute(value) ? value : `${slashes(root())}/${value}`;
    }

    const titles = {
      testsDir: 'Choose the tests folder',
      resourcesDir: 'Choose the resources folder',
      outputDir: 'Choose the results folder',
    };
    for (const key of Object.keys(titles)) {
      $(`#settings-${FIELDS[key]}-browse`).addEventListener('click', async () => {
        const chosen = await api.pickFolder(titles[key], startPath(key));
        if (chosen)
          input(key).value = projectPath(chosen);
        input(key).focus();
      });
    }
    $('#settings-python-browse').addEventListener('click', async () => {
      const chosen = await api.pickPython(startPath('python'));
      if (chosen)
        input('python').value = projectPath(chosen);
      input('python').focus();
    });

    $('#settings-cancel').addEventListener('click', () => dialog.close());

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (saving)
        return;
      saving = true;
      $('#settings-save').disabled = true;
      showFormError('');
      try {
        const values = Object.fromEntries(Object.keys(FIELDS).map((key) => [key, input(key).value]));
        const result = await api.saveProjectSettings(values);
        if (!result.ok) {
          showErrors(result.errors || {});
          showFormError(result.error);
          return;
        }
        dialog.close();
        await reopen();
      } catch (error) {
        showFormError(error.message);
      } finally {
        saving = false;
        $('#settings-save').disabled = false;
      }
    });

    return { open };
  }

  return { create };
})();
