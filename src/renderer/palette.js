'use strict';

// Command palette: Ctrl+P lists project files, Ctrl+Shift+P (or a leading ">")
// lists commands. The commands and files come from app.js; this module owns
// the overlay, the keyboard handling and the rendering of matches.
window.RFCommandPalette = (() => {
  const $ = (selector) => document.querySelector(selector);
  const LIMIT = 200;
  const PAGE = 8;

  /**
   * @typedef {{ id: string, category: string, label: string, keys?: string, run: () => unknown }} Command
   * @param {{ commands: () => Command[], files: () => Promise<string[] | null>, openFile: (path: string) => unknown }} sources
   *   files resolves to null when no project is open
   */
  function create({ commands, files, openFile }) {
    const overlay = $('#palette');
    const input = $('#palette-input');
    const list = $('#palette-list');
    const empty = $('#palette-empty');
    let results = [];
    let selected = 0;
    let fileList; // undefined while loading, null without a project
    let returnFocus = null;
    let generation = 0;

    const commandText = (command) => `${command.category}: ${command.label}`;
    const isCommandMode = () => fileList === null || input.value.startsWith('>');

    async function open(mode) {
      const reopening = !overlay.hidden;
      input.value = mode === 'commands' ? '>' : '';
      if (!reopening) {
        returnFocus = document.activeElement;
        overlay.hidden = false;
        fileList = undefined;
      }
      update();
      input.focus();
      if (reopening)
        return;
      const current = ++generation;
      let loaded = null;
      try {
        loaded = await files();
      } catch (error) {
        console.error('Command palette: could not list project files', error);
        loaded = [];
      }
      if (current !== generation || overlay.hidden)
        return;
      fileList = loaded;
      update();
    }

    function close() {
      if (overlay.hidden)
        return;
      generation++;
      overlay.hidden = true;
      results = [];
      list.replaceChildren();
      input.removeAttribute('aria-activedescendant');
      if (returnFocus && returnFocus.isConnected)
        returnFocus.focus();
      returnFocus = null;
    }

    function update() {
      const commandMode = isCommandMode();
      input.placeholder = fileList === null ? 'Type a command' : 'Search files by name, or type > for commands';
      if (commandMode) {
        results = window.RFPalette.rank(input.value.replace(/^>/, ''), commands(), commandText)
          .map((result) => ({ ...result, kind: 'command' }));
        empty.textContent = 'No matching commands';
      } else if (fileList === undefined) {
        results = [];
        empty.textContent = 'Loading files…';
      } else {
        results = window.RFPalette.rank(input.value, fileList, (path) => path)
          .map((result) => ({ ...result, kind: 'file' }));
        empty.textContent = 'No matching files';
      }
      results = results.slice(0, LIMIT);
      selected = 0;
      render();
    }

    /** The part [start, end) of text, with matched characters in <mark>. */
    function highlighted(text, positions, start, end) {
      const nodes = [];
      let plain = '';
      for (let index = start; index < end; index++) {
        if (positions.includes(index)) {
          if (plain)
            nodes.push(document.createTextNode(plain));
          plain = '';
          const mark = document.createElement('mark');
          mark.textContent = text[index];
          nodes.push(mark);
        } else {
          plain += text[index];
        }
      }
      if (plain)
        nodes.push(document.createTextNode(plain));
      return nodes;
    }

    function span(className, nodes) {
      const element = document.createElement('span');
      element.className = className;
      element.append(...nodes);
      return element;
    }

    function row(result, index) {
      const option = document.createElement('li');
      option.id = `palette-option-${index}`;
      option.setAttribute('role', 'option');
      option.className = 'palette-option';
      if (result.kind === 'command') {
        const text = commandText(result.item);
        const split = result.item.category.length + 2;
        option.append(span('palette-label', [
          span('palette-category', highlighted(text, result.positions, 0, split)),
          ...highlighted(text, result.positions, split, text.length),
        ]));
        if (result.item.keys)
          option.append(span('palette-keys', [document.createTextNode(result.item.keys)]));
      } else {
        const path = result.item;
        const nameStart = path.lastIndexOf('/') + 1;
        option.append(span('palette-label', highlighted(path, result.positions, nameStart, path.length)));
        if (nameStart > 0)
          option.append(span('palette-detail', highlighted(path, result.positions, 0, nameStart - 1)));
        option.title = path;
      }
      // Keep the focus in the input; choose on click.
      option.addEventListener('mousedown', (event) => event.preventDefault());
      option.addEventListener('click', () => choose(index));
      option.addEventListener('mousemove', () => {
        if (selected !== index)
          select(index, false);
      });
      return option;
    }

    function render() {
      list.replaceChildren(...results.map(row));
      empty.hidden = results.length > 0;
      select(selected, true);
    }

    function select(index, scroll) {
      const options = list.children;
      if (!options.length) {
        input.removeAttribute('aria-activedescendant');
        return;
      }
      selected = Math.max(0, Math.min(index, options.length - 1));
      for (let i = 0; i < options.length; i++) {
        options[i].classList.toggle('is-selected', i === selected);
        options[i].setAttribute('aria-selected', String(i === selected));
      }
      input.setAttribute('aria-activedescendant', options[selected].id);
      if (scroll)
        options[selected].scrollIntoView({ block: 'nearest' });
    }

    function choose(index) {
      const result = results[index];
      if (!result)
        return;
      close();
      Promise.resolve()
        .then(() => (result.kind === 'file' ? openFile(result.item) : result.item.run()))
        .catch((error) => console.error(`Command palette: ${result.kind === 'file' ? result.item : result.item.id} failed`, error));
    }

    input.addEventListener('input', update);
    input.addEventListener('keydown', (event) => {
      const count = results.length;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (count)
          select((selected + (event.key === 'ArrowDown' ? 1 : -1) + count) % count, true);
      } else if (event.key === 'PageDown' || event.key === 'PageUp') {
        event.preventDefault();
        select(selected + (event.key === 'PageDown' ? PAGE : -PAGE), true);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        choose(selected);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === 'Tab') {
        event.preventDefault(); // the palette is modal
      }
    });
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay)
        close();
    });
    return { open, close, isOpen: () => !overlay.hidden };
  }

  return { create };
})();
