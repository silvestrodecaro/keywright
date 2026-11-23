'use strict';

// Explorer: the project tree, its context menu, renaming in place, the New File form and
// the expanded folders. app.js owns the tabs and the editor: it creates the Explorer with
// accessors for them, and renames and deletes on disk through renamePath and deletePath.
(function (factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory(require('./fileNames'));
  else
    window.RFExplorer = factory(window.RFFileNames);
})(function (names) {
  function fileIcon(name) {
    if (/\.robot$/i.test(name)) return '◆';
    if (/\.resource$/i.test(name)) return '◇';
    return '·';
  }

  function absolutePath(root, relative) {
    const separator = root.includes('\\') ? '\\' : '/';
    return root.replace(/[\\/]+$/, '') + separator + relative.split('/').join(separator);
  }

  /** Expanded folders inside a renamed path follow it. */
  function moveExpanded(expanded, from, to) {
    for (const path of [...expanded]) {
      if (names.isWithin(path, from)) {
        expanded.delete(path);
        expanded.add(names.moved(path, from, to));
      }
    }
  }

  /** Expanded folders inside a deleted path are forgotten. */
  function removeExpanded(expanded, relative) {
    for (const path of [...expanded]) {
      if (names.isWithin(path, relative))
        expanded.delete(path);
    }
  }

  /**
   * Creates the Explorer of the project view. app.js passes the shell helpers, accessors for
   * the project and its tabs, and the disk operations that also update tabs and the editor.
   */
  function create({ api, el, showError, status, root, config, activeTab, hasTab, openFile, showSidebar, showHistory, renamePath, deletePath }) {
    const $ = (selector) => document.querySelector(selector);
    const expanded = new Set();

    window.RFTree.bind($('#tree'));

    const treeNodes = new Map(); // path -> node of the rendered tree
    let renaming = null; // the path whose row shows the rename field

    async function refreshTree() {
      // Re-rendering would remove the rename field: refresh when renaming ends.
      if (renaming)
        return;
      const tree = await api.projectTree();
      if (renaming)
        return;
      // A save changes no entry: the Explorer is rebuilt only when what it shows changed.
      const shown = JSON.stringify([tree, [...expanded].sort(), activeTab()]);
      if (shown === lastTreeShown && $('#tree').childElementCount)
        return;
      lastTreeShown = shown;
      treeNodes.clear();
      window.RFTree.replace($('#tree'), tree.map((node) => renderNode(node, 0)), activeTab());
    }
    let lastTreeShown = null;

    function renderNode(node, depth) {
      const row = el('div', {
        className: `tree-row ${node.type === 'dir' ? 'is-dir' : 'is-file'}`,
        title: node.path,
      });
      row.style.paddingLeft = `${8 + depth * 14}px`;
      const isOpen = expanded.has(node.path);
      const icon = node.type === 'dir' ? (isOpen ? '▾' : '▸') : fileIcon(node.name);
      row.append(el('span', { className: 'tree-icon', textContent: icon }), el('span', { className: 'tree-label', textContent: node.name }));
      if (node.type === 'file' && hasTab(node.path) && activeTab() === node.path)
        row.classList.add('is-active');

      const item = el('li', { role: 'treeitem' }, row);
      item.dataset.treeId = node.path;
      item.tabIndex = -1;
      treeNodes.set(node.path, node);
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        window.RFTree.focusItem($('#tree'), item);
        openExplorerMenu(node, event.clientX, event.clientY);
      });
      if (node.type === 'dir') {
        item.setAttribute('aria-expanded', String(isOpen));
        row.addEventListener('click', () => {
          if (expanded.has(node.path))
            expanded.delete(node.path);
          else
            expanded.add(node.path);
          refreshTree();
        });
        if (isOpen)
          item.append(el('ul', { role: 'group' }, ...node.children.map((child) => renderNode(child, depth + 1))));
      } else {
        row.addEventListener('click', () => openFile(node.path));
      }
      return item;
    }


    let newFileKindChosen = false; // the type was picked by hand, not suggested by the folder

    function showNewFileInput(folder = config().testsDir) {
      $('#new-file').hidden = false;
      const input = $('#new-file-name');
      input.value = folder ? `${folder}/` : '';
      newFileKindChosen = false;
      showError($('#new-file-error'), '');
      updateNewFileHint();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }

    function hideNewFileInput() {
      const returnFocus = $('#new-file').contains(document.activeElement);
      $('#new-file').hidden = true;
      if (returnFocus)
        $('#tree [role="treeitem"][tabindex="0"]')?.focus();
    }

    /** A typed extension selects the type; without one the folder suggests it until the user picks. */
    function updateNewFileHint() {
      const name = $('#new-file-name').value.trim().replace(/\\/g, '/');
      const select = $('#new-file-type');
      const typed = names.kindOf(name);
      if (typed)
        select.value = typed;
      else if (!newFileKindChosen)
        select.value = names.defaultKind(names.parentOf(name), config());
      const target = names.withExtension(name, select.value);
      $('#new-file-hint').textContent = names.baseName(target) ? `Creates ${target}` : '';
    }

    $('#tree-new-file').addEventListener('click', () => showNewFileInput());
    $('#new-file-name').addEventListener('input', updateNewFileHint);
    $('#new-file-type').addEventListener('change', () => {
      newFileKindChosen = true;
      // Choosing another type replaces a .robot or .resource extension already typed.
      const input = $('#new-file-name');
      const kind = $('#new-file-type').value;
      const typed = names.kindOf(input.value.trim());
      if (typed && typed !== 'other' && typed !== kind)
        input.value = input.value.trim().replace(/\.[^./]+$/, names.EXTENSIONS[kind] || '');
      updateNewFileHint();
    });
    $('#new-file').addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = names.withExtension($('#new-file-name').value, $('#new-file-type').value);
      const result = await api.createProjectFile(name);
      if (!result.ok) {
        showError($('#new-file-error'), result.error);
        return;
      }
      $('#new-file').hidden = true;
      expandTo(names.parentOf(result.path));
      await refreshTree();
      openFile(result.path);
    });
    $('#new-file').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        hideNewFileInput();
      }
    });

    function expandTo(folder) {
      const parts = folder ? folder.split('/') : [];
      parts.forEach((_, i) => expanded.add(parts.slice(0, i + 1).join('/')));
    }

    async function copyText(text) {
      await api.copyToClipboard(text);
      status(`Copied ${text}`);
    }

    function explorerMenu(node) {
      if (!node) {
        return [
          { label: 'New File…', run: () => showNewFileInput() },
          { separator: true },
          { label: 'Open Project Folder in File Manager', run: () => api.revealInExplorer(null) },
          { label: 'Refresh Explorer', run: refreshTree },
        ];
      }
      const folder = node.type === 'dir' ? node.path : names.parentOf(node.path);
      return [
        ...(node.type === 'file' ? [
          { label: 'Open', run: () => openFile(node.path) },
          { label: 'Git File History', run: () => { showSidebar('source-control'); showHistory(node.path); } },
        ] : []),
        { label: 'New File…', run: () => { expandTo(folder); refreshTree(); showNewFileInput(folder); } },
        { separator: true },
        { label: 'Rename…', keys: 'F2', run: () => startRename(node.path) },
        { label: 'Delete', keys: 'Del', run: () => deletePath(node.path) },
        { separator: true },
        { label: 'Copy Path', run: () => copyText(absolutePath(root(), node.path)) },
        { label: 'Copy Relative Path', run: () => copyText(node.path) },
        { label: 'Reveal in File Manager', run: () => api.revealInExplorer(node.path) },
      ];
    }

    function openExplorerMenu(node, x, y) {
      if (renaming)
        return;
      const tree = $('#tree');
      const focusPath = document.activeElement?.closest('#tree [role="treeitem"]')?.dataset.treeId;
      window.RFContextMenu.open({
        x, y, items: explorerMenu(node), label: node ? node.name : 'Explorer',
        // The file watcher can replace the opener while the menu has focus.
        fallbackFocus: focusPath ? () => {
          const item = tree.querySelector(`[data-tree-id="${CSS.escape(focusPath)}"]`)
            || tree.querySelector('[role="treeitem"][tabindex="0"]');
          if (item)
            window.RFTree.focusItem(tree, item);
          else
            $('#tree-new-file').focus({ preventScroll: true });
        } : undefined,
      });
    }

    // Right-click below the files: project-level actions.
    $('#tree').addEventListener('contextmenu', (event) => {
      if (event.defaultPrevented || event.target.closest('input'))
        return;
      event.preventDefault();
      openExplorerMenu(null, event.clientX, event.clientY);
    });

    $('#tree').addEventListener('keydown', (event) => {
      if (event.target.closest('input') || event.altKey || event.ctrlKey || event.metaKey)
        return;
      const item = event.target.closest('[role="treeitem"]');
      const node = item && treeNodes.get(item.dataset.treeId);
      if (!node)
        return;
      if (event.key === 'F2')
        startRename(node.path);
      else if (event.key === 'Delete')
        deletePath(node.path);
      else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        const box = item.firstElementChild.getBoundingClientRect();
        openExplorerMenu(node, box.left + 24, box.bottom);
      } else {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    });

    /** Replaces a row's label with a name field: Enter renames, Escape cancels. */
    function startRename(relative) {
      if (renaming)
        return;
      const item = [...$('#tree').querySelectorAll('[role="treeitem"]')].find((node) => node.dataset.treeId === relative);
      if (!item)
        return;
      const row = item.firstElementChild;
      const label = row.querySelector('.tree-label');
      const original = names.baseName(relative);
      const input = el('input', { className: 'tree-rename', type: 'text', value: original, spellcheck: false, autocomplete: 'off' });
      input.setAttribute('aria-label', `New name for ${original}`);
      const error = el('div', { className: 'error tree-rename-error', hidden: true });
      renaming = relative;
      lastTreeShown = null; // the row is changed in place: the next refresh rebuilds it
      row.classList.add('is-renaming');
      label.hidden = true;
      label.after(input);
      row.after(error);
      let busy = false;

      // Focus returns to the row unless the user moved it elsewhere (a blur).
      const finish = async (focusPath, keepFocus) => {
        const tree = $('#tree');
        renaming = null;
        tree.dataset.focusId = focusPath;
        await refreshTree();
        const next = [...tree.querySelectorAll('[role="treeitem"]')].find((node) => node.dataset.treeId === focusPath);
        if (keepFocus && next)
          window.RFTree.focusItem(tree, next);
      };
      const commit = async ({ fromBlur = false } = {}) => {
        if (busy || renaming !== relative)
          return;
        const name = input.value.trim();
        if (!name || name === original) {
          finish(relative, !fromBlur);
          return;
        }
        busy = true;
        const result = await renamePath(relative, name);
        busy = false;
        if (result.ok) {
          finish(result.path, !fromBlur);
        } else if (result.error && !fromBlur) {
          showError(error, result.error);
          input.focus();
        } else {
          if (result.error)
            status(`Could not rename ${original}: ${result.error}`, true);
          finish(relative, !fromBlur);
        }
      };
      input.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(relative, true);
        }
      });
      input.addEventListener('input', () => showError(error, ''));
      input.addEventListener('click', (event) => event.stopPropagation());
      input.addEventListener('blur', () => {
        if (!busy && renaming === relative)
          commit({ fromBlur: true });
      });
      input.focus();
      const dot = original.lastIndexOf('.');
      input.setSelectionRange(0, treeNodes.get(relative)?.type === 'file' && dot > 0 ? dot : original.length);
    }

    $('#tree-refresh').addEventListener('click', refreshTree);
    $('#tree-reveal').addEventListener('click', () => api.revealInExplorer(null));

    return {
      refresh: refreshTree,
      /** A newly opened project: its tests and resources folders start expanded. */
      reset(projectConfig) {
        expanded.clear();
        expanded.add(projectConfig.testsDir);
        expanded.add(projectConfig.resourcesDir);
        $('#new-file').hidden = true;
      },
      showNewFileInput,
      isRenaming: () => Boolean(renaming),
      pathMoved: (from, to) => moveExpanded(expanded, from, to),
      pathRemoved: (relative) => removeExpanded(expanded, relative),
    };
  }

  return { create, fileIcon, absolutePath, moveExpanded, removeExpanded };
});
