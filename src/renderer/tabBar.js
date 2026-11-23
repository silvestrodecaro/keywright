'use strict';

// The tab bar of the project view and the pane it shows: fixed tabs, the Git Diff tab, file
// tabs, and the active file in the editor. app.js owns the tab state and passes accessors.
(function (factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory();
  else
    window.RFTabBar = factory();
})(function () {
  /** The fixed tabs, followed by the Git Diff tab while a diff is shown. */
  function fixedTabList(fixedTabs, hasGitDiff, gitDiffTab) {
    return [...fixedTabs, ...(hasGitDiff ? [
      { id: gitDiffTab, label: 'Git Diff', pane: '#pane-git-diff' },
    ] : [])];
  }

  /** Name, classes, tooltip, accessible label and element id of a file tab. */
  function fileTabView(tab, activeTab, dirty) {
    const name = tab.path.split('/').pop();
    return {
      name,
      className: 'tab' + (activeTab === tab.path ? ' is-active' : '') + (dirty ? ' is-dirty' : ''),
      title: tab.path + (dirty ? ' (unsaved)' : ''),
      label: name + (dirty ? ', unsaved changes' : ''),
      id: `tab-file-${encodeURIComponent(tab.path)}`,
    };
  }

  /**
   * @param {object} deps tab state accessors (tabs, activeTab, hasGitDiff, shownInEditor,
   *   setShownInEditor), the fixed tabs, the editor, and the actions of the tabs and panes.
   */
  function create({ el, editor, fixedTabs, gitDiffTab, tabs, activeTab, hasGitDiff, shownInEditor, setShownInEditor,
    activate, closeTab, ensureEditor, renderProblems, renderRecordBar }) {
    const $ = (selector) => document.querySelector(selector);

    function render() {
      const focus = $('#tabs').contains(document.activeElement) ? document.activeElement.id : null;
      function semantics(button, id, pane) {
        button.id = id;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', String(button.classList.contains('is-active')));
        button.setAttribute('aria-controls', pane.slice(1));
        button.tabIndex = button.classList.contains('is-active') ? 0 : -1;
        if (button.tabIndex === 0) $(pane).setAttribute('aria-labelledby', id);
        return button;
      }
      const fixed = fixedTabList(fixedTabs, hasGitDiff(), gitDiffTab).map((tab) => {
        const button = el('button', {
          type: 'button',
          className: 'tab' + (activeTab() === tab.id ? ' is-active' : ''),
          textContent: tab.label,
        });
        button.addEventListener('click', () => activate(tab.id));
        return semantics(button, `tab-${tab.id}`, tab.pane);
      });

      const fileTabs = tabs().map((tab) => {
        const view = fileTabView(tab, activeTab(), editor.isDirty(tab.path));
        const button = el('button', {
          type: 'button',
          className: view.className,
          title: view.title,
        }, el('span', { textContent: view.name }));
        button.setAttribute('aria-label', view.label);
        const close = el('span', { className: 'tab-close', title: 'Close (Delete when tab is focused)' });
        close.setAttribute('aria-hidden', 'true');
        close.addEventListener('click', (event) => {
          event.stopPropagation();
          closeTab(tab.path);
        });
        button.append(close);
        button.addEventListener('click', () => activate(tab.path));
        button.addEventListener('auxclick', (event) => {
          if (event.button === 1)
            closeTab(tab.path);
        });
        return semantics(button, view.id, '#pane-file');
      });
      $('#tabs').replaceChildren(...fixed, ...fileTabs);
      if (focus) {
        const target = document.getElementById(focus) || $('#tabs [aria-selected="true"]');
        target?.focus();
      }

      const active = activeTab();
      const file = tabs().find((t) => t.path === active);
      for (const tab of fixedTabs)
        $(tab.pane).hidden = active !== tab.id;
      $('#pane-git-diff').hidden = active !== gitDiffTab;
      $('#pane-file').hidden = !file;
      if (!file)
        return;
      $('#file-path').textContent = file.path;
      const message = $('#file-message');
      message.hidden = file.content !== null;
      $('#editor').hidden = file.content === null;
      $('#pane-file .file-header-right').hidden = file.content === null;
      if (file.content === null) {
        message.textContent = file.reason;
        return;
      }
      if (shownInEditor() !== file.path) {
        ensureEditor();
        editor.open(file.path, file.content, file.line, file.column, file.selectLength);
        file.line = null;
        setShownInEditor(file.path);
      }
      renderProblems(editor.problems(file.path));
      renderRecordBar();
    }

    return { render };
  }

  return { create, fileTabView, fixedTabList };
});
