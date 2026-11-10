'use strict';

// A page-drawn context menu: arrow keys move, Enter runs, Escape or a click
// elsewhere closes and returns focus to where the menu was opened.
(function () {
  let current = null;

  function close({ restoreFocus = true } = {}) {
    if (!current)
      return;
    const { menu, returnFocus, cleanup } = current;
    current = null;
    cleanup();
    menu.remove();
    if (restoreFocus && returnFocus?.isConnected)
      returnFocus.focus({ preventScroll: true });
  }

  /**
   * @param {{ x: number, y: number, items: ({ label: string, keys?: string, run: Function, disabled?: boolean } | { separator: true })[], label?: string }} options
   */
  function open({ x, y, items, label = 'Context menu' }) {
    const returnFocus = document.activeElement;
    close({ restoreFocus: false });
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', label);
    for (const item of items) {
      if (item.separator) {
        const line = document.createElement('div');
        line.className = 'context-menu-separator';
        line.setAttribute('role', 'separator');
        menu.append(line);
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'context-menu-item';
      button.setAttribute('role', 'menuitem');
      button.tabIndex = -1;
      button.disabled = Boolean(item.disabled);
      const text = document.createElement('span');
      text.textContent = item.label;
      button.append(text);
      if (item.keys) {
        const keys = document.createElement('span');
        keys.className = 'context-menu-keys';
        keys.textContent = item.keys;
        button.append(keys);
      }
      button.addEventListener('click', () => {
        close();
        item.run();
      });
      menu.append(button);
    }
    document.body.append(menu);

    const left = Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    const enabled = () => [...menu.querySelectorAll('.context-menu-item:not(:disabled)')];
    menu.addEventListener('keydown', (event) => {
      const list = enabled();
      const index = list.indexOf(document.activeElement);
      let next;
      if (event.key === 'ArrowDown') next = (index + 1) % list.length;
      else if (event.key === 'ArrowUp') next = (index - 1 + list.length) % list.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = list.length - 1;
      else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      } else if (event.key === 'Tab') {
        event.preventDefault();
        close();
        return;
      }
      if (next === undefined || !list.length)
        return;
      event.preventDefault();
      list[next].focus();
    });
    menu.addEventListener('contextmenu', (event) => event.preventDefault());

    const outside = (event) => {
      if (!menu.contains(event.target))
        close({ restoreFocus: false });
    };
    const dismiss = () => close({ restoreFocus: false });
    document.addEventListener('mousedown', outside, true);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    current = {
      menu,
      returnFocus,
      cleanup() {
        document.removeEventListener('mousedown', outside, true);
        window.removeEventListener('blur', dismiss);
        window.removeEventListener('resize', dismiss);
      },
    };
    enabled()[0]?.focus();
  }

  window.RFContextMenu = { open, close, isOpen: () => Boolean(current) };
})();
