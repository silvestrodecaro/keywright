'use strict';

// Keyword loader: the project's and libraries' keywords for completion and hover, loaded
// into the editor when a project opens, after file changes and from Reload libraries.
// The index itself is built in the main process (src/main/keywordIndex.js); app.js passes
// the editor status line.
(function (factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory();
  else
    window.RFKeywordLoader = factory();
})(function () {
  /** The editor status for a projectKeywords() result. */
  function keywordStatus(result) {
    if (!result.ok)
      return { text: result.error, isError: true };
    const problems = result.errors.map((e) => `${e.import || e.source}: ${e.error}`);
    return {
      text: `${result.keywords.length} keywords` + (problems.length ? ` · ${problems.length} import problem(s)` : ''),
      isError: problems.length > 0,
      title: problems.join('\n'),
    };
  }

  function create({ api, editor, status, statusTitle, doc = document }) {
    let keywordTimer = null;

    async function loadKeywords() {
      const result = await api.projectKeywords();
      // Unknown keywords are only reported when every imported library could be documented.
      const failedImports = (result.errors || []).filter((e) => e.import);
      editor.setKeywords(result.keywords || [], { complete: result.ok && failedImports.length === 0 });
      window.dispatchEvent(new CustomEvent('keywright:keywords-loaded'));
      editor.revalidate();
      const shown = keywordStatus(result);
      status(shown.text, shown.isError);
      if (result.ok)
        statusTitle(shown.title);
    }

    doc.querySelector('#reload-libraries').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      clearTimeout(keywordTimer);
      status('Reloading libraries…');
      try {
        await api.reloadLibraries();
        await loadKeywords();
      } finally {
        button.disabled = false;
      }
    });

    function scheduleKeywords() {
      clearTimeout(keywordTimer);
      keywordTimer = setTimeout(loadKeywords, 500);
    }

    return { load: loadKeywords, schedule: scheduleKeywords };
  }

  return { create, keywordStatus };
});
