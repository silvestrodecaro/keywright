'use strict';

// MCP server dialog and title bar button: switches Keywright's MCP server on and
// off, shows each client's configuration and what the client's own configuration
// file says, and tests a configuration the way its client will run it.
window.RFMcpDialog = (() => {
  const $ = (selector) => document.querySelector(selector);
  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const shortPath = (file) => (file ? file.replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~') : null);

  function statusText(status) {
    if (!status.enabled)
      return 'Off. AI clients cannot connect.';
    if (!status.running)
      return 'Not running.';
    const parts = [`On, listening on 127.0.0.1:${status.port}.`];
    parts.push(status.clients.length ? `Connected: ${status.clients.join(', ')}.` : 'No client has connected yet.');
    if (status.lastCall)
      parts.push(`Last action: ${status.lastCall.tool} at ${new Date(status.lastCall.at).toLocaleTimeString()}.`);
    if (status.browserOpen)
      parts.push('The AI has a browser open.');
    return parts.join(' ');
  }

  /** The short state shown under a client's name. */
  function badge(setup) {
    if (setup.seen)
      return { text: `Connected at ${time(setup.seen)}`, kind: 'seen' };
    return {
      configured: { text: 'Configured', kind: 'configured' },
      outdated: { text: 'Needs updating', kind: 'outdated' },
      unreadable: { text: 'Config unreadable', kind: 'unreadable' },
      missing: { text: 'Not configured', kind: 'missing' },
      manual: { text: 'URL and token', kind: 'manual' },
    }[setup.state] || { text: '', kind: 'missing' };
  }

  /** The sentence above the configuration: what was found, and where. */
  function stateText(setup) {
    const file = shortPath(setup.file);
    const found = {
      configured: `Keywright is configured in ${file}.`,
      outdated: `The Keywright entry in ${file} needs updating.`,
      unreadable: `${file} could not be read.`,
      missing: file ? `No Keywright entry in ${file} yet.` : '',
      manual: 'Keywright cannot check HTTP clients’ configuration; use Test connection.',
    }[setup.state] || '';
    const seen = setup.seen ? ` It connected at ${time(setup.seen)}.` : '';
    return [found + seen, setup.detail].filter(Boolean).join(' ');
  }

  /**
   * The result of Test connection. Only a test of the client's own entry earns a
   * check mark: the configuration offered works for every client alike.
   * @returns {{ ok: boolean|null, text: string }} ok null: neither passed nor failed
   */
  function testText(outcome, setup) {
    const file = shortPath(outcome.file);
    const tools = outcome.ok ? `${outcome.server} answered with ${outcome.tools.length} tools` : '';
    switch (outcome.scope) {
      case 'client':
        return outcome.ok
          ? { ok: true, text: `✓ ${setup.label}'s configuration in ${file} works: ${tools}. "Connected at" appears when ${setup.label} itself connects.` }
          : { ok: false, text: `${setup.label}'s configuration in ${file} does not work: ${outcome.error}` };
      case 'generated':
        return outcome.ok
          ? { ok: null, text: `${setup.label} is not configured yet: add the configuration above${file ? ` to ${file}` : ''}, then test again. The configuration itself works on this computer (${outcome.tools.length} tools).` }
          : { ok: false, text: `The configuration above does not work on this computer: ${outcome.error}` };
      case 'http':
        return outcome.ok
          ? { ok: true, text: `✓ The HTTP address and token work: ${tools}. Keywright cannot read HTTP clients' settings; "Connected" in the status line confirms the client.` }
          : { ok: false, text: `The HTTP address or token does not work: ${outcome.error}` };
      default:
        return { ok: false, text: `The test failed: ${outcome.error}` };
    }
  }

  const CHANGE_KINDS = { create: 'Created', update: 'Edited', delete: 'Deleted', rename: 'Renamed' };

  /** What a change did, as one line: "tests/a.robot → tests/b.robot" for a rename. */
  function changeText(change) {
    return change.kind === 'rename' ? `${change.path} → ${change.to}` : change.path;
  }

  const describeChange = (change) => `${(CHANGE_KINDS[change.kind] || change.kind).toLowerCase()} ${changeText(change)}`;

  /** Where the changed file is now, so it can be opened; null when it is gone. */
  function existingPath(change) {
    if (change.undone)
      return change.kind === 'create' ? null : change.path;
    return change.kind === 'delete' ? null : change.to || change.path;
  }

  /** @param {{ api: object, openFile?: (relative: string) => void }} options */
  function create({ api, openFile = null }) {
    const dialog = $('#mcp');
    const button = $('#mcp-open');
    let status = null;
    let busy = false;
    let selected = 'claude-code';
    let result = null; // { client, ok, text }
    let changeResult = null; // { ok, text }

    function renderButton() {
      const on = !!status?.running;
      button.classList.toggle('mcp-on', on);
      button.classList.toggle('mcp-failed', !!status?.enabled && !on);
      const title = !status?.enabled ? 'MCP server: off'
        : on ? `MCP server: on${status.clients.length ? ` (${status.clients[0]})` : ''}` : 'MCP server: not running';
      const changed = (status?.changes || []).filter((change) => !change.undone).length;
      button.title = changed ? `${title}. ${changed} file change${changed === 1 ? '' : 's'} by AI clients.` : title;
    }

    function renderChanges() {
      const changes = status.changes || [];
      $('#mcp-changes-empty').hidden = changes.length > 0;
      const list = $('#mcp-changes');
      list.hidden = !changes.length;
      const focused = list.contains(document.activeElement) ? document.activeElement.dataset.undo : null;
      list.replaceChildren(...changes.map((change) => {
        const item = document.createElement('li');
        item.className = `mcp-change${change.undone ? ' is-undone' : ''}`;
        const at = document.createElement('span');
        at.className = 'mcp-change-time';
        at.textContent = time(change.at);
        const kind = document.createElement('span');
        kind.className = 'mcp-change-kind';
        kind.textContent = CHANGE_KINDS[change.kind] || change.kind;
        const target = existingPath(change);
        const file = document.createElement(openFile && target ? 'button' : 'span');
        file.className = 'mcp-change-path';
        file.textContent = changeText(change);
        file.title = `${changeText(change)} (${change.tool})`;
        if (file.tagName === 'BUTTON') {
          file.type = 'button';
          file.addEventListener('click', () => {
            dialog.close();
            openFile(target);
          });
        }
        let action;
        if (change.undone) {
          action = document.createElement('span');
          action.className = 'mcp-change-note';
          action.textContent = 'Undone';
        } else {
          action = document.createElement('button');
          action.type = 'button';
          action.className = 'btn';
          action.textContent = 'Undo';
          action.dataset.undo = String(change.id);
          action.disabled = !change.undoable || busy;
          action.setAttribute('aria-label', `Undo: ${describeChange(change)}`);
        }
        item.append(at, kind, file, action);
        if (!change.undone && !change.undoable) {
          const reason = document.createElement('span');
          reason.className = 'mcp-change-reason';
          reason.textContent = change.reason;
          item.append(reason);
        }
        return item;
      }));
      if (focused)
        list.querySelector(`[data-undo="${focused}"]`)?.focus();
      $('#mcp-changes-result').textContent = changeResult?.text || '';
      $('#mcp-changes-result').className = `settings-help mcp-result${changeResult?.ok === false ? ' is-error' : ''}`;
    }

    function renderClients() {
      const list = $('#mcp-clients');
      const focused = list.contains(document.activeElement) ? document.activeElement.dataset.client : null;
      list.replaceChildren(...status.setups.map((setup) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'mcp-client';
        item.dataset.client = setup.id;
        item.setAttribute('role', 'radio');
        item.setAttribute('aria-checked', String(setup.id === selected));
        item.tabIndex = setup.id === selected ? 0 : -1;
        const name = document.createElement('span');
        name.className = 'mcp-client-name';
        name.textContent = setup.label;
        const state = badge(setup);
        const note = document.createElement('span');
        note.className = `mcp-client-badge is-${state.kind}`;
        note.textContent = state.text;
        item.append(name, note);
        return item;
      }));
      if (focused)
        list.querySelector(`[data-client="${focused}"]`)?.focus();
    }

    function render() {
      renderButton();
      if (!status || !dialog.open)
        return;
      if (!busy) // keep the user's choice while it is being applied
        $('#mcp-enabled').checked = status.enabled;
      $('#mcp-enabled').disabled = busy;
      $('#mcp-status').textContent = statusText(status);
      $('#mcp-error').textContent = status.error || '';
      $('#mcp-error').hidden = !status.error;
      renderClients();
      const setup = status.setups.find((item) => item.id === selected) || status.setups[0];
      $('#mcp-client-state').textContent = stateText(setup);
      $('#mcp-client-help').textContent = setup.help;
      $('#mcp-config').textContent = setup.config;
      $('#mcp-setup').classList.toggle('mcp-setup-off', !status.enabled);
      $('#mcp-token').hidden = setup.id !== 'http';
      $('#mcp-test').disabled = !status.running || busy;
      const shown = result && result.client === setup.id ? result : null;
      $('#mcp-result').textContent = shown ? shown.text : '';
      $('#mcp-result').className = `settings-help mcp-result${shown?.ok === true ? ' is-ok' : shown?.ok === false ? ' is-error' : ''}`;
      $('#mcp-close-browser').hidden = !status.browserOpen;
      renderChanges();
    }

    async function refresh() {
      status = await api.mcpStatus();
      render();
    }

    async function open() {
      result = null;
      changeResult = null;
      if (!dialog.open)
        dialog.showModal();
      await refresh();
      $('#mcp-enabled').focus();
    }

    function select(id, focus = false) {
      selected = id;
      render();
      if (focus)
        $(`#mcp-clients [data-client="${id}"]`)?.focus();
    }

    $('#mcp-clients').addEventListener('click', (event) => {
      const item = event.target.closest('[data-client]');
      if (item)
        select(item.dataset.client);
    });
    // Radio group keys: arrows move the selection.
    $('#mcp-clients').addEventListener('keydown', (event) => {
      const ids = status.setups.map((setup) => setup.id);
      const current = event.target.closest('[data-client]')?.dataset.client || selected;
      const index = ids.indexOf(current);
      const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
      if (step === undefined && event.key !== 'Home' && event.key !== 'End')
        return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : (index + step + ids.length) % ids.length;
      select(ids[next], true);
    });
    $('#mcp-enabled').addEventListener('change', async (event) => {
      busy = true;
      render();
      try {
        status = await api.setMcpEnabled(event.target.checked);
      } finally {
        busy = false;
        render();
      }
    });
    $('#mcp-copy').addEventListener('click', async () => {
      await api.copyToClipboard($('#mcp-config').textContent);
      result = { client: selected, ok: null, text: 'Copied.' };
      render();
    });
    $('#mcp-test').addEventListener('click', async () => {
      const client = selected;
      result = { client, ok: null, text: 'Testing…' };
      render();
      const outcome = await api.testMcpConnection(client);
      result = { client, ...testText(outcome, status.setups.find((setup) => setup.id === client)) };
      render();
    });
    $('#mcp-token').addEventListener('click', async () => {
      status = await api.regenerateMcpToken();
      result = { client: 'http', ok: true, text: 'New token created. Update the clients that use the HTTP address.' };
      render();
    });
    $('#mcp-close-browser').addEventListener('click', () => api.closeAiBrowser());
    $('#mcp-changes').addEventListener('click', async (event) => {
      const undo = event.target.closest('[data-undo]');
      if (!undo || undo.disabled)
        return;
      const change = status.changes.find((item) => String(item.id) === undo.dataset.undo);
      busy = true;
      render();
      try {
        const outcome = await api.undoMcpChange(Number(undo.dataset.undo));
        changeResult = outcome.ok
          ? { ok: true, text: `Undone: ${describeChange(change)}.` }
          : { ok: false, text: `Could not undo: ${outcome.error}` };
        status = await api.mcpStatus();
      } finally {
        busy = false;
        render();
      }
    });
    // Whether a change can be undone depends on the files: check again when they change.
    api.onFilesChanged(() => { if (dialog.open && !busy) refresh(); });
    button.addEventListener('click', open);
    // Coming back from editing a client's configuration elsewhere: read it again.
    window.addEventListener('focus', () => { if (dialog.open) refresh(); });

    api.onMcpState((next) => {
      status = next;
      render();
    });
    refresh();

    return { open };
  }

  return { create, statusText, badge, stateText, testText, changeText };
})();
