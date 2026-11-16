'use strict';

(function () {
  const changeLabels = {
    '?': 'Untracked', A: 'Added', M: 'Modified', D: 'Deleted',
    R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Conflict',
  };
  const svgNamespace = 'http://www.w3.org/2000/svg';

  function svgNode(tag, attributes, ...children) {
    const node = document.createElementNS(svgNamespace, tag);
    for (const [name, value] of Object.entries(attributes))
      node.setAttribute(name, value);
    node.append(...children);
    return node;
  }

  function commitLanes(commits) {
    const active = [];
    return commits.map(({ oid, parents }) => {
      if (!active.includes(oid))
        active.push(oid);
      const before = [...active];
      const lane = active.indexOf(oid);
      active.splice(lane, 1, ...parents.filter((parent) => !active.includes(parent)));
      return { lane, before, after: [...active], parents };
    });
  }

  function graphIcon({ lane, before, after, parents }) {
    const x = (index) => 7 + index * 11;
    const width = Math.max(before.length, after.length) * 11 + 3;
    const icon = svgNode('svg', { width, height: 34, viewBox: `0 0 ${width} 34`, 'aria-hidden': 'true' });
    const colors = ['var(--accent)', 'var(--info)', 'var(--tok-section)', 'var(--warn)'];
    const path = (d, index) => svgNode('path', { d, stroke: colors[index % colors.length], fill: 'none', 'stroke-width': 1.3 });
    for (const [index, oid] of before.entries()) {
      if (index === lane) {
        icon.append(path(`M${x(index)} 0V17`, index));
        for (const parent of parents) {
          const next = after.indexOf(parent);
          if (next >= 0)
            icon.append(path(`M${x(index)} 17 C${x(index)} 25 ${x(next)} 23 ${x(next)} 34`, next));
        }
      } else {
        const next = after.indexOf(oid);
        icon.append(path(`M${x(index)} 0 C${x(index)} 16 ${x(next)} 18 ${x(next)} 34`, next));
      }
    }
    icon.append(svgNode('circle', { cx: x(lane), cy: 17, r: 3.2, fill: colors[lane % colors.length],
      stroke: 'var(--surface)', 'stroke-width': 1 }));
    return icon;
  }

  function create({ api, el, activateDiff, closeDiff, openFile, compare }) {
    const $ = (id) => document.getElementById(id);
    const panel = $('sidebar-source-control');
    const refreshButton = $('source-refresh');
    const message = $('source-message');
    const error = $('source-error');
    const diffText = $('source-diff-text');
    const diffStatus = $('source-diff-status');
    const picker = $('source-picker');
    const pickerBody = $('source-picker-body');
    const comparisonHost = $('source-comparison');
    const action = (name) => (root, ...args) => api.sourceControlAction(root, name, ...args);
    let project = null;
    let status = null;
    let busy = false;
    let refreshInFlight = false;
    let refreshQueued = false;
    let statusGeneration = 0;
    let selectedDiff = null;
    let comparison = null;
    let statusError = false;
    let pickerRequest = 0;
    let graphKey = null;

    function setProject(root) {
      project = root ? { root } : null;
      status = null;
      busy = false;
      refreshInFlight = false;
      refreshQueued = false;
      message.value = '';
      showError('');
      clearDiff();
      if (picker.open)
        picker.close();
      $('source-repository').hidePopover();
      $('source-commit-menu').hidePopover();
      graphKey = null;
      $('source-graph-list').replaceChildren();
      for (const toggle of panel.querySelectorAll('.source-group-toggle')) {
        toggle.setAttribute('aria-expanded', 'true');
        $(toggle.getAttribute('aria-controls')).hidden = false;
      }
      render();
      if (project)
        refresh();
    }

    function clearDiff() {
      selectedDiff = null;
      markSelection();
      closeComparison();
      diffStatus.textContent = '';
      diffText.replaceChildren();
      diffText.hidden = true;
    }

    function closeComparison() {
      comparison?.dispose();
      comparison = null;
      comparisonHost.hidden = true;
      $('source-comparison-labels').hidden = true;
      $('source-diff-compare').textContent = 'Side by Side';
    }

    async function request(call, ...args) {
      const result = await call(project.root, ...args);
      if (!result.ok)
        throw new Error(result.error);
      return result.value;
    }

    function showError(text, fromStatus = false) {
      statusError = fromStatus;
      error.textContent = text;
      error.hidden = !text;
    }

    function renderControls() {
      refreshButton.disabled = busy;
      $('source-init').disabled = busy;
      message.readOnly = busy;
      $('source-commit-button').disabled = busy || (!status?.staged?.length && !status?.merging)
        || status.stagedOutsideProject || status.changes.some(({ code }) => code === 'U') || !message.value.trim();
      $('source-amend').hidden = !status?.oid || !!status.projectPrefix || status.merging;
      $('source-amend').disabled = busy || !message.value.trim() || !!status?.changes?.some(({ code }) => code === 'U');
      $('source-commit-more').hidden = $('source-amend').hidden;
      $('source-commit-more').disabled = busy;
      $('source-branch').disabled = busy;
      $('source-more').disabled = busy;
      for (const button of panel.querySelectorAll('.source-action'))
        button.disabled = busy;
      $('source-stage-all').disabled = busy;
      $('source-unstage-all').disabled = busy;
      for (const button of document.querySelectorAll('.source-hunk-action'))
        button.disabled = busy;
      $('source-diff-discard').disabled = busy;
      for (const button of panel.querySelectorAll('[data-git]')) {
        const tracked = ['pull', 'push', 'sync'].includes(button.dataset.git);
        button.hidden = tracked ? !status?.upstream : button.dataset.git === 'publish' && !!status?.upstream;
        button.disabled = busy || (button.dataset.git === 'publish' && (status?.unborn || status?.detached));
      }
    }

    function renderGroup(group, entries) {
      const section = $(`source-${group}`);
      section.hidden = !entries.length;
      const list = section.querySelector('ul');
      section.querySelector('.source-count').textContent = entries.length;
      const previous = document.activeElement;
      const focusedFile = list.contains(previous) ? previous.dataset.file : null;
      const actionFocused = previous.classList.contains('source-action');
      list.replaceChildren();
      for (const entry of entries) {
        const { path, originalPath, code } = entry;
        const slash = path.lastIndexOf('/');
        const name = path.slice(slash + 1);
        const directory = slash < 0 ? '' : path.slice(0, slash);
        const label = changeLabels[code] || code;
        const icon = svgNode('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true',
          fill: 'none', stroke: 'currentColor', class: /\.(robot|resource)$/i.test(name) ? 'source-file-icon robot' : 'source-file-icon' },
        svgNode('path', { d: 'M4 2h5l3 3v9H4zM9 2v4h3M6 9h4m-4 2h4' }));
        const open = el('button', { className: 'source-file', type: 'button', title: originalPath ? `${originalPath} → ${path}` : path },
          icon,
          el('span', { className: 'source-file-label' },
            el('span', { className: 'source-filename', textContent: name }),
            ...(directory ? [el('span', { className: 'source-directory', textContent: directory })] : [])));
        open.dataset.file = path;
        open.setAttribute('aria-label', `View diff for ${path}`);
        open.setAttribute('aria-description', label);
        open.addEventListener('click', () => viewDiff(group, path));
        const staging = group === 'changes';
        const actionLabel = `${staging ? 'Stage' : 'Unstage'} ${path}`;
        const action = el('button', { className: 'icon-btn source-action', type: 'button', title: actionLabel });
        action.dataset.file = path;
        action.setAttribute('aria-label', actionLabel);
        action.append(svgNode('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' },
          svgNode('path', { d: staging ? 'M3 8h10M8 3v10' : 'M3 8h10' })));
        action.addEventListener('click', () => mutate(staging ? api.sourceControlStage : api.sourceControlUnstage, [path], {
          focusGroup: staging ? 'staged' : 'changes', focusPath: path,
        }));
        const codeLabel = el('span', { className: `source-code source-code-${code === '?' ? 'new' : code}`, textContent: code === '?' ? 'U' : code, title: label });
        codeLabel.setAttribute('aria-hidden', 'true');
        list.append(el('li', { className: 'source-row' }, open, action, codeLabel));
        if (path === focusedFile)
          (actionFocused ? action : open).focus();
      }
      if (focusedFile && document.activeElement === document.body)
        (list.querySelector('.source-file') || refreshButton).focus();
    }

    function render() {
      const repository = status?.kind === 'repository';
      const branch = $('source-branch');
      branch.querySelector('span').textContent = repository ? status.branch : '';
      branch.title = repository
        ? [status.detached ? 'Detached HEAD' : status.branch, status.repositoryRoot].join('\n') : '';
      const activity = $('source-activity-count');
      const count = new Set([...(status?.staged || []), ...(status?.changes || [])].map(({ path }) => path)).size;
      activity.textContent = count > 99 ? '99+' : count;
      activity.hidden = count === 0;
      const statusBranch = $('source-status-branch');
      statusBranch.hidden = !repository;
      statusBranch.querySelector('span').textContent = repository
        ? [status.branch, ...(status.upstream ? [`↓${status.behind} ↑${status.ahead}`] : [])].join('  ') : '';
      const info = $('source-status');
      let notice = '';
      if (!status && project && error.hidden)
        notice = 'Checking repository…';
      if (status?.kind === 'none')
        notice = 'This project has no Git repository.';
      if (status?.kind === 'missing')
        notice = status.message;
      if (repository) {
        if (status.stagedOutsideProject)
          notice = 'Staged changes outside this project. Open the repository root to review and commit them.';
        else if (status.changes.some(({ code }) => code === 'U'))
          notice = 'Open conflicting files, resolve and save them, then stage the resolutions.';
        else if (status.merging)
          notice = 'Merge in progress. Commit the staged resolution to finish.';
        else if (status.unborn)
          notice = 'No commits yet';
        else if (!status.staged.length && !status.changes.length)
          notice = status.projectPrefix ? 'No changes in this project.' : 'Working tree is clean.';
      }
      info.textContent = notice;
      info.hidden = !notice;
      $('source-init').hidden = status?.kind !== 'none';
      $('source-commit').hidden = !repository;
      $('source-repo-bar').hidden = !repository;
      $('source-more').hidden = !repository;
      $('source-graph').hidden = !repository;
      const upstream = $('source-upstream');
      upstream.hidden = !status?.upstream;
      upstream.textContent = status?.upstream ? `${status.upstream} · ↑ ${status.ahead} · ↓ ${status.behind}` : '';
      renderGroup('staged', status?.staged || []);
      renderGroup('changes', status?.changes || []);
      renderControls();
      markSelection();
      renderGraph();
    }

    function markSelection() {
      for (const button of panel.querySelectorAll('.source-file')) {
        const selected = button.dataset.file === selectedDiff?.path
          && button.closest('.source-group').id === `source-${selectedDiff.group}`;
        if (selected)
          button.setAttribute('aria-current', 'true');
        else
          button.removeAttribute('aria-current');
      }
    }

    async function renderGraph() {
      if (panel.hidden || !status || status.kind !== 'repository' || $('source-graph-content').hidden)
        return;
      const key = [status.oid, status.branch, status.upstream, status.ahead, status.behind].join('\0');
      if (key === graphKey)
        return;
      graphKey = key;
      const owner = project;
      const list = $('source-graph-list');
      const notice = $('source-graph-status');
      list.replaceChildren();
      notice.hidden = false;
      notice.textContent = 'Loading commits…';
      try {
        const commits = await request(action('history'));
        if (owner !== project || graphKey !== key)
          return;
        const lanes = commitLanes(commits);
        notice.hidden = commits.length > 0;
        notice.textContent = 'No commits yet.';
        for (const [index, commit] of commits.entries()) {
          const button = el('button', { className: 'source-graph-commit', type: 'button',
            title: [commit.subject, commit.author, commit.oid].join('\n') },
          graphIcon(lanes[index]),
          el('span', { className: 'source-graph-text' },
            el('span', { className: 'source-graph-subject', textContent: commit.subject || commit.oid.slice(0, 8) }),
            el('small', { textContent: commit.refs || commit.author })));
          button.addEventListener('click', () => showCommit(commit));
          list.append(el('li', {}, button));
        }
      } catch (failure) {
        if (owner === project && graphKey === key) {
          graphKey = null;
          notice.textContent = failure.message;
        }
      }
    }

    async function refresh({ clearError = false } = {}) {
      if (!project)
        return;
      if (clearError)
        showError('');
      if (busy || refreshInFlight) {
        refreshQueued = true;
        return;
      }
      const owner = project;
      const generation = statusGeneration;
      refreshInFlight = true;
      try {
        const next = await request(api.sourceControlStatus);
        if (owner !== project || generation !== statusGeneration)
          return;
        if (statusError)
          showError('');
        if (JSON.stringify(status) !== JSON.stringify(next)) {
          status = next;
          render();
        }
      } catch (failure) {
        if (owner === project && generation === statusGeneration) {
          status = null;
          showError(failure.message, true);
          render();
        }
      } finally {
        if (owner === project) {
          refreshInFlight = false;
          if (refreshQueued && !busy) {
            refreshQueued = false;
            refresh();
          }
        }
      }
    }

    async function mutate(call, args = [], { focusGroup, focusPath, success } = {}) {
      if (busy || !project)
        return;
      const owner = project;
      const previous = document.activeElement;
      busy = true;
      statusGeneration++;
      showError('');
      renderControls();
      try {
        await request(call, ...args);
        if (owner === project) {
          if (call === api.sourceControlCommit || call === api.sourceControlAmend)
            message.value = '';
          success?.();
        }
      } catch (failure) {
        if (owner === project)
          showError(failure.message);
      }
      if (owner !== project)
        return;
      refreshQueued = false;
      const next = await request(api.sourceControlStatus).catch((failure) => {
        if (owner === project && error.hidden)
          showError(failure.message, true);
        return null;
      });
      if (owner !== project)
        return;
      status = next;
      busy = false;
      render();
      if (!panel.hidden && [document.body, previous, refreshButton].includes(document.activeElement)) {
        const row = focusGroup && [...$(`source-${focusGroup}`).querySelectorAll('.source-file')]
          .find((button) => button.dataset.file === focusPath);
        (row || (call === api.sourceControlCommit && message) || refreshButton).focus();
      }
      if (refreshQueued) {
        refreshQueued = false;
        refresh();
      }
    }

    async function viewDiff(group, path) {
      const label = group === 'staged' ? 'Staged changes · HEAD to index' : 'Changes · saved working tree';
      await loadDiff(path, label, () => request(api.sourceControlDiff, group, path), group);
      const selection = selectedDiff;
      if (selection?.group === group && selection.path === path && selection.entry?.code !== 'U'
        && selection.revision && !comparison && selection.preferComparison !== false)
        await openComparison(selection, false);
    }

    async function loadDiff(path, label, read, group) {
      closeComparison();
      const owner = project;
      const entry = status?.[group]?.find((change) => change.path === path);
      const selection = { group, path, entry, label };
      selectedDiff = selection;
      markSelection();
      $('source-diff-edit').hidden = !entry || entry.code === 'D';
      $('source-diff-compare').hidden = !entry || entry.code === 'U';
      $('source-diff-conflict').hidden = entry?.code !== 'U';
      $('source-diff-history').hidden = !entry || status.unborn || entry.code === '?';
      $('source-diff-blame').hidden = !entry || status.unborn || ['?', 'A', 'U'].includes(entry.code);
      $('source-diff-discard').hidden = true;
      $('source-diff-path').textContent = path;
      $('source-diff-path').title = path;
      $('source-diff-label').textContent = label;
      diffText.replaceChildren();
      diffText.hidden = true;
      diffStatus.hidden = false;
      diffStatus.textContent = 'Loading diff…';
      activateDiff();
      try {
        const review = await read();
        const { patch, token, revision } = review;
        if (owner !== project || selectedDiff !== selection)
          return;
        selection.revision = revision;
        $('source-diff-discard').hidden = group !== 'changes' || !entry || entry.originalPath
          || !['M', 'D', 'T'].includes(entry.code);
        if (!patch) {
          diffStatus.textContent = 'No diff available for this change.';
          return;
        }
        const lines = patch.replace(/\r?\n$/, '').split(/\r?\n/);
        const fragment = document.createDocumentFragment();
        let hunk = 0;
        for (const line of lines.slice(0, 10000)) {
          const kind = line.startsWith('+++') || line.startsWith('---') ? 'meta'
            : line.startsWith('+') ? 'added'
              : line.startsWith('-') ? 'removed'
                : line.startsWith('@') ? 'hunk' : '';
          fragment.append(el('span', { className: kind, textContent: line }), '\n');
          if (token && line.startsWith('@@ ')) {
            const index = hunk++;
            const button = el('button', { className: 'btn btn-sm source-hunk-action', type: 'button',
              textContent: group === 'staged' ? 'Unstage Hunk' : 'Stage Hunk', disabled: busy });
            button.addEventListener('click', () => mutate(action('applyHunk'), [group, path, token, index], {
              success: () => loadDiff(path, label, () => request(api.sourceControlDiff, group, path), group),
            }));
            fragment.append(button, '\n');
          }
        }
        diffText.replaceChildren(fragment);
        diffText.hidden = false;
        diffText.scrollTop = 0;
        diffText.scrollLeft = 0;
        diffStatus.textContent = lines.length > 10000 ? 'Showing the first 10,000 lines.' : '';
        diffStatus.hidden = !diffStatus.textContent;
      } catch (failure) {
        if (owner === project && selectedDiff === selection)
          diffStatus.textContent = failure.message;
      }
    }

    $('source-diff-edit').addEventListener('click', () => openFile(selectedDiff.path));
    $('source-diff-history').addEventListener('click', () => showHistory(selectedDiff.path));
    $('source-diff-blame').addEventListener('click', () => {
      const { path } = selectedDiff;
      loadDiff(path, 'Blame · HEAD', async () => ({ patch: await request(action('blame'), path) }));
    });
    $('source-diff-conflict').addEventListener('click', () => {
      const selection = selectedDiff;
      showPicker('Compare Conflict', 'conflictVersions', ({ base, current, incoming }) => [
        pickerEntry('Current and Incoming', 'Compare the two sides of the conflict.', () => {
          showComparison(selection, { original: current ?? '', modified: incoming ?? '' }, 'Current → Incoming');
        }),
        ...(base === null ? [] : [
          pickerEntry('Base and Current', '', () => showComparison(selection,
            { original: base, modified: current ?? '' }, 'Base → Current')),
          pickerEntry('Base and Incoming', '', () => showComparison(selection,
            { original: base, modified: incoming ?? '' }, 'Base → Incoming')),
        ]),
      ], selection.path);
    });

    function showComparison(selection, versions, label) {
      if (selectedDiff !== selection)
        return;
      closeComparison();
      comparisonHost.hidden = false;
      comparison = compare(comparisonHost, selection.path, versions, false);
      diffText.hidden = true;
      diffStatus.hidden = true;
      $('source-diff-label').textContent = label;
      const labels = $('source-comparison-labels');
      for (const [index, value] of label.split(' → ').entries())
        labels.children[index].textContent = value;
      labels.hidden = false;
      $('source-diff-compare').hidden = false;
      $('source-diff-compare').textContent = 'Show Patch';
    }

    $('source-diff-compare').addEventListener('click', async () => {
      if (comparison) {
        selectedDiff.preferComparison = false;
        closeComparison();
        diffText.hidden = false;
        $('source-diff-label').textContent = selectedDiff.label;
        $('source-diff-compare').hidden = selectedDiff.entry?.code === 'U';
        return;
      }
      await openComparison(selectedDiff, true);
    });

    async function openComparison(selection, reportFailure) {
      try {
        const versions = await request(action('comparison'), selection.group, selection.path);
        if (selectedDiff !== selection || comparison)
          return;
        showComparison(selection, versions, selection.group === 'staged' ? 'HEAD → Index' : 'Index → Working Tree');
      } catch (failure) {
        if (selectedDiff === selection) {
          closeComparison();
          if (reportFailure) {
            diffStatus.textContent = failure.message;
            diffStatus.hidden = false;
          }
        }
      }
    }

    function confirm(title, text, label, run) {
      $('source-picker-title').textContent = title;
      pickerBody.replaceChildren(el('p', { textContent: text }), pickerEntry(label, '', run));
      picker.showModal();
    }

    $('source-diff-discard').addEventListener('click', () => {
      const { path, revision } = selectedDiff;
      confirm('Discard Changes', `Restore the saved file ${path} to its staged version?`, 'Discard Working Changes',
        () => mutate(action('discard'), [path, revision], { success: closeDiff }));
    });

    $('source-amend').addEventListener('click', () => {
      $('source-commit-menu').hidePopover();
      const value = message.value;
      confirm('Amend Last Commit', 'Replace the last commit with this message and the current staged changes?',
        'Amend Commit', () => mutate(api.sourceControlAmend, [value]));
    });

    function pickerEntry(label, detail, run, disabled = false) {
      const button = el('button', { className: 'source-picker-entry', type: 'button', disabled },
        label, ...(detail ? [el('small', { textContent: detail })] : []));
      button.addEventListener('click', () => {
        picker.close();
        run();
      });
      return button;
    }

    function pickerForm(label, placeholder, run, required = true) {
      const input = el('input', { type: 'text', placeholder, required, spellcheck: false });
      input.setAttribute('aria-label', placeholder);
      const form = el('form', { className: 'source-picker-form' }, input,
        el('button', { className: 'btn btn-sm', type: 'submit', textContent: label }));
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (required && !input.value.trim())
          return;
        picker.close();
        run(input.value.trim());
      });
      return form;
    }

    async function showPicker(title, read, renderItems, ...args) {
      const owner = project;
      const generation = ++pickerRequest;
      $('source-picker-title').textContent = title;
      pickerBody.replaceChildren(el('p', { className: 'muted', textContent: 'Loading…' }));
      picker.showModal();
      try {
        const items = await request(action(read), ...args);
        if (owner === project && picker.open && generation === pickerRequest)
          pickerBody.replaceChildren(...renderItems(items));
      } catch (failure) {
        if (owner === project && picker.open && generation === pickerRequest)
          pickerBody.replaceChildren(el('p', { className: 'error', textContent: failure.message }));
      }
    }

    const empty = (text) => el('p', { className: 'muted', textContent: text });
    function showCommit({ oid, subject }) {
      return loadDiff(subject, `Commit ${oid.slice(0, 8)}`, async () => ({ patch: await request(action('commitDiff'), oid) }));
    }
    function showHistory(relative) {
      return showPicker(relative ? 'File History' : 'Git History', 'history', (items) => items.length
        ? items.map((commit) => pickerEntry(commit.subject,
          [commit.oid.slice(0, 8), commit.author, commit.date.slice(0, 10), commit.refs].filter(Boolean).join(' · '),
          () => showCommit(commit)))
        : [empty('No commits yet.')], ...(relative ? [relative] : []));
    }
    const tools = {
      branches: () => showPicker('Branches', 'branches', (items) => [
        pickerForm('Create and Switch', 'Branch name', (name) => mutate(action('createBranch'), [name])),
        ...items.map(({ name, current }) => pickerEntry(name, current ? 'Current branch' : '', () => mutate(action('switchBranch'), [name]), current)),
        ...(status.merging ? [pickerEntry('Abort Merge', 'Restore the checkout to its state before the merge.',
          () => confirm('Abort Merge', 'Abort the current merge for this repository?', 'Abort Merge',
            () => mutate(action('abortMerge'))))]
          : items.filter(({ current }) => !current).map(({ name }) => pickerEntry(`Merge ${name}`, `Into ${status.branch}`,
            () => mutate(action('mergeBranch'), [name])))),
        ...items.map(({ name }) => pickerEntry(`Rename ${name}`, '', () => {
          $('source-picker-title').textContent = `Rename ${name}`;
          pickerBody.replaceChildren(pickerForm('Rename Branch', 'New branch name',
            (replacement) => mutate(action('renameBranch'), [name, replacement])));
          picker.showModal();
        })),
        ...items.filter(({ current }) => !current).map(({ name }) => pickerEntry(`Delete ${name}`, '',
          () => confirm('Delete Branch', `Delete the merged local branch ${name}?`, 'Delete Branch',
            () => mutate(action('deleteBranch'), [name])))),
      ]),
      history: () => showHistory(),
      stashes: () => showPicker('Stashes', 'stashes', (items) => [
        empty('Save tracked and untracked changes from the entire repository.'),
        pickerForm('Save Stash', 'Stash message (optional)', (value) => mutate(action('saveStash'), [value]), false),
        ...items.map(({ oid, ref, subject }) => pickerEntry(subject, `Apply ${ref}`, () => mutate(action('applyStash'), [oid]))),
        ...items.map(({ oid, ref, subject }) => pickerEntry(`Drop ${ref}`, subject,
          () => confirm('Drop Stash', `Permanently delete ${ref}?`, 'Drop Stash', () => mutate(action('dropStash'), [oid])))),
      ]),
      remotes: () => showPicker('Remotes', 'remotes', (items) => [
        ...items.map(empty),
        pickerForm('Continue', 'Remote name', (name) => {
          $('source-picker-title').textContent = `Add remote ${name}`;
          pickerBody.replaceChildren(pickerForm('Add Remote', 'Remote URL', (url) => mutate(action('addRemote'), [name, url])));
          picker.showModal();
        }),
      ]),
      publish: () => showPicker('Publish Branch', 'remotes', (items) => items.length
        ? items.map((remote) => pickerEntry(remote, '', () => mutate(action('publish'), [remote])))
        : [empty('Add a Git remote before publishing this branch.')]),
    };

    for (const button of panel.querySelectorAll('[data-git]')) {
      const name = button.dataset.git;
      button.addEventListener('click', () => {
        $('source-repository').hidePopover();
        (tools[name] || (() => mutate(action(name))))();
      });
    }
    $('source-branch').addEventListener('click', tools.branches);
    $('source-status-branch').addEventListener('click', () => {
      $('sidebar-tab-source-control').click();
      $('sidebar-tab-source-control').focus();
    });
    for (const toggle of panel.querySelectorAll('.source-group-toggle')) {
      toggle.addEventListener('click', () => {
        const content = $(toggle.getAttribute('aria-controls'));
        content.hidden = !content.hidden;
        toggle.setAttribute('aria-expanded', String(!content.hidden));
        renderGraph();
      });
    }
    $('source-stage-all').addEventListener('click', () => mutate(action('stageAll')));
    $('source-unstage-all').addEventListener('click', () => mutate(action('unstageAll')));
    refreshButton.addEventListener('click', () => {
      graphKey = null;
      refresh({ clearError: true }).then(renderGraph);
    });
    $('source-init').addEventListener('click', () => mutate(api.sourceControlInit));
    message.addEventListener('input', renderControls);
    message.addEventListener('keydown', (event) => {
      if (event.ctrlKey && event.key === 'Enter' && !$('source-commit-button').disabled) {
        event.preventDefault();
        $('source-commit').requestSubmit();
      }
    });
    $('source-commit').addEventListener('submit', (event) => {
      event.preventDefault();
      if (!$('source-commit-button').disabled)
        mutate(api.sourceControlCommit, [message.value]);
    });
    api.onWindowActive((active) => {
      if (active)
        refresh();
    });
    window.addEventListener('keywright:files-changed', () => refresh());
    window.addEventListener('keywright:project-closed', () => setProject(null));
    return { setProject, refresh: () => refresh().then(renderGraph), clearDiff, showHistory };
  }

  window.RFSourceControl = { create };
})();
