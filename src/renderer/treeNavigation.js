'use strict';

(function (factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory();
  else
    window.RFTree = factory();
})(function () {
  function treeAction(rows, id, key) {
    if (!rows.length)
      return null;
    const index = Math.max(0, rows.findIndex((row) => row.id === id));
    const row = rows[index];
    if (key === 'ArrowDown') return { focus: rows[Math.min(index + 1, rows.length - 1)].id };
    if (key === 'ArrowUp') return { focus: rows[Math.max(index - 1, 0)].id };
    if (key === 'Home') return { focus: rows[0].id };
    if (key === 'End') return { focus: rows[rows.length - 1].id };
    if (key === 'Enter' || key === ' ') return { activate: row.id };
    if (key === 'ArrowRight') {
      if (row.expanded === false) return { toggle: row.id };
      if (row.expanded && rows[index + 1]?.parent === row.id) return { focus: rows[index + 1].id };
    }
    if (key === 'ArrowLeft') {
      if (row.expanded) return { toggle: row.id };
      if (row.parent) return { focus: row.parent };
    }
    return null;
  }

  const items = (tree) => [...tree.querySelectorAll('[role="treeitem"]')];

  function focusItem(tree, item, focus = true) {
    for (const node of items(tree)) node.tabIndex = node === item ? 0 : -1;
    tree.dataset.focusId = item.dataset.treeId;
    if (focus) item.focus({ preventScroll: true });
    if (focus) item.firstElementChild?.scrollIntoView({ block: 'nearest' });
  }

  function bind(tree) {
    tree.addEventListener('click', (event) => {
      const item = event.target.closest('[role="treeitem"]');
      if (item && !event.target.closest('button')) focusItem(tree, item);
    }, true);
    tree.addEventListener('keydown', (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.target.closest('button, input, select')) return;
      const nodes = items(tree);
      const rows = nodes.map((item) => ({
        id: item.dataset.treeId,
        parent: item.parentElement.closest('[role="treeitem"]')?.dataset.treeId,
        expanded: item.hasAttribute('aria-expanded') ? item.getAttribute('aria-expanded') === 'true' : undefined,
      }));
      const action = treeAction(rows, event.target.closest('[role="treeitem"]')?.dataset.treeId, event.key);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      const item = nodes.find((node) => node.dataset.treeId === (action.focus || action.toggle || action.activate));
      if (action.focus) focusItem(tree, item);
      else item.firstElementChild.click();
    });
  }

  function replace(tree, children, selected) {
    const focused = tree.contains(document.activeElement);
    const previous = document.activeElement?.closest('[role="treeitem"]');
    const fallback = previous?.parentElement.closest('[role="treeitem"]')?.dataset.treeId;
    const id = tree.dataset.focusId;
    tree.replaceChildren(...children);
    const nodes = items(tree);
    for (const item of nodes) item.setAttribute('aria-selected', String(item.dataset.treeId === selected));
    const item = nodes.find((node) => node.dataset.treeId === id)
      || nodes.find((node) => node.dataset.treeId === fallback)
      || nodes.find((node) => node.dataset.treeId === selected) || nodes[0];
    if (item) focusItem(tree, item, focused);
  }

  function bindTabs(list) {
    list.addEventListener('keydown', (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const tabs = [...list.querySelectorAll('[role="tab"]')];
      const index = tabs.indexOf(event.target);
      if (index < 0) return;
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      const id = tabs[next].id;
      tabs[next].focus();
      tabs[next].click();
      // Activating an editor can replace these buttons and move focus into Monaco.
      [...list.querySelectorAll('[role="tab"]')].find((tab) => tab.id === id)?.focus();
    });
  }
  return { treeAction, bind, replace, bindTabs };
});
