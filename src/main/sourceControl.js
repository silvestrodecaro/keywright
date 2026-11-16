'use strict';

const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { realpath } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { resolveInside } = require('./pathBoundary');

const exec = promisify(execFile);
const canonical = promisify(realpath.native);
const repoEnvironment = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_IMPLICIT_WORK_TREE',
];

function parseStatus(output) {
  const status = {
    kind: 'repository', branch: '', upstream: '', ahead: 0, behind: 0,
    unborn: false, detached: false, staged: [], changes: [],
  };
  const records = output.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.startsWith('# branch.head ')) {
      status.branch = record.slice('# branch.head '.length);
    } else if (record.startsWith('# branch.upstream ')) {
      status.upstream = record.slice('# branch.upstream '.length);
    } else if (record.startsWith('# branch.ab ')) {
      [status.ahead, status.behind] = record.slice('# branch.ab '.length).split(' ').map((count) => Math.abs(Number(count)));
    } else if (record.startsWith('# branch.oid ')) {
      const oid = record.slice('# branch.oid '.length);
      status.unborn = oid === '(initial)';
      if (oid !== '(initial)')
        status.oid = oid;
    } else if (record.startsWith('? ')) {
      status.changes.push({ code: '?', path: record.slice(2) });
    } else if (/^[12u] /.test(record)) {
      const type = record[0];
      const fields = record.split(' ', { '1': 8, '2': 9, u: 10 }[type]);
      const file = record.slice(fields.join(' ').length + 1);
      const [index, worktree] = fields[1];
      const entry = { path: file };
      if (type === '2')
        entry.originalPath = records[++i];
      if (type === 'u') {
        status.changes.push({ ...entry, code: 'U' });
        continue;
      }
      if (index !== '.')
        status.staged.push({ ...entry, code: index });
      if (worktree !== '.')
        status.changes.push({ ...entry, code: worktree });
    }
  }
  status.detached = status.branch === '(detached)';
  if (status.detached)
    status.branch = status.oid.slice(0, 8);
  return status;
}

function scopeStatus(status, projectPrefix) {
  const inProject = (file) => file.startsWith(projectPrefix);
  const stagedOutsideProject = status.staged.some(({ path, originalPath, code }) =>
    !inProject(path) || (code === 'R' && originalPath && !inProject(originalPath)));
  const scopeEntries = (entries) => entries.flatMap(({ path, originalPath, code }) => {
    if (!inProject(path)) {
      return code === 'R' && originalPath && inProject(originalPath)
        ? [{ path: originalPath.slice(projectPrefix.length), code: 'D' }] : [];
    }
    const entry = { path: path.slice(projectPrefix.length), code };
    if (originalPath && inProject(originalPath))
      entry.originalPath = originalPath.slice(projectPrefix.length);
    else if (code === 'R' || code === 'C')
      entry.code = 'A';
    return [entry];
  });
  return {
    stagedOutsideProject,
    staged: scopeEntries(status.staged),
    changes: scopeEntries(status.changes),
  };
}

function commitRecords(output) {
  const fields = output.replace(/\0$/, '').split('\0');
  const records = [];
  for (let i = 0; i + 5 < fields.length; i += 6) {
    const [oid, parents, author, date, refs, subject] = fields.slice(i, i + 6);
    records.push({ oid, parents: parents ? parents.split(' ') : [], author, date, refs, subject });
  }
  return records;
}

const commitFormat = '%H%x00%P%x00%an%x00%aI%x00%D%x00%s';

function branchName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().startsWith('-') || name.trim().startsWith('@{'))
    throw new Error('Enter a valid branch name.');
  return name.trim();
}

class SourceControl {
  constructor(root) {
    this.root = root;
    this.mutations = Promise.resolve();
  }

  async git(args, acceptedCode = 0, { cwd = this.root, input } = {}) {
    const env = { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' };
    for (const name of repoEnvironment)
      delete env[name];
    try {
      const command = exec('git', [
        '--no-pager', '--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', ...args,
      ], { cwd, env, windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      if (input !== undefined) {
        command.child.stdin.on('error', () => {}); // Git reports a rejected patch on stderr.
        command.child.stdin.end(input);
      }
      const { stdout } = await command;
      return stdout;
    } catch (error) {
      if (acceptedCode && error.code === acceptedCode)
        return error.stdout;
      if (error.code === 'ENOENT')
        throw Object.assign(new Error('Git is unavailable. Install Git and restart Keywright.'), { code: 'GIT_MISSING' });
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
        throw new Error('Git output is too large to display in Keywright.');
      if (error.killed)
        throw new Error('Git did not finish within 60 seconds. Refresh Source Control to check the repository.');
      throw new Error(error.stderr?.trim() || error.stdout?.trim() || 'Git could not complete the operation.');
    }
  }

  async status() {
    let root;
    let gitDir;
    try {
      [root, gitDir] = (await this.git(['rev-parse', '--show-toplevel', '--absolute-git-dir'])).split(/\r?\n/);
    } catch (error) {
      if (error.code === 'GIT_MISSING')
        return { kind: 'missing', message: error.message };
      if (error.message.startsWith('fatal: not a git repository'))
        return { kind: 'none' };
      throw error;
    }
    const [projectRoot, repositoryRoot] = await Promise.all([canonical(this.root), canonical(root)]);
    const relative = path.relative(repositoryRoot, projectRoot);
    const projectPrefix = relative ? relative.split(path.sep).join('/') + '/' : '';
    const status = parseStatus(await this.git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--renames']));
    const merging = await fs.access(path.join(gitDir, 'MERGE_HEAD')).then(() => true, (error) => {
      if (error.code === 'ENOENT')
        return false;
      throw error;
    });
    return {
      ...status,
      ...scopeStatus(status, projectPrefix),
      repositoryRoot,
      projectPrefix,
      merging,
    };
  }

  async repository() {
    const status = await this.status();
    if (status.kind !== 'repository')
      throw new Error(status.message || 'Initialize a Git repository to use Source Control.');
    return status;
  }

  async entry(group, relative) {
    const status = await this.repository();
    const entry = status[group].find((item) => item.path === relative);
    if (!entry || entry.path.endsWith('/'))
      throw new Error('This file is no longer listed as a change. Refresh Source Control.');
    return { status, entry };
  }

  async diff(group, relative) {
    if (group !== 'staged' && group !== 'changes')
      throw new Error('Choose a staged or working tree change.');
    const { entry } = await this.entry(group, relative);
    const args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv'];
    if (entry.code === '?') {
      // A deleted or replaced untracked file must not turn into a directory comparison.
      const parent = resolveInside(this.root, path.posix.dirname(entry.path));
      const file = await fs.lstat(path.join(parent, path.posix.basename(entry.path)));
      if (!file.isFile() && !file.isSymbolicLink())
        throw new Error('Only regular files and symbolic links can be previewed.');
      return this.git([...args, '--no-index', '--', '/dev/null', entry.path], 1);
    }
    if (group === 'staged')
      args.push('--cached');
    return this.git([...args, '--no-relative', '--src-prefix=a/', '--dst-prefix=b/', '--', ...this.paths(entry, group)]);
  }

  async review(group, relative) {
    const patch = await this.diff(group, relative);
    const first = patch.indexOf('\n@@ ');
    const header = patch.slice(0, first + 1);
    const hunks = first < 0 ? [] : patch.slice(first + 1).split(/(?<=\n)(?=@@ )/);
    const revision = createHash('sha256').update(patch).digest('hex');
    const token = /^diff --git /u.test(header) && !patch.includes('\uFFFD')
      && !/\n(?:new file|deleted file|old mode|rename |copy )/u.test(header)
      ? revision : null;
    return { patch, header, hunks, token, revision };
  }

  async comparison(group, relative) {
    if (group !== 'staged' && group !== 'changes')
      throw new Error('Choose a staged or working tree change.');
    const { status, entry } = await this.entry(group, relative);
    if (entry.code === 'U')
      throw new Error('Open the file in the editor to resolve the conflict.');
    const file = status.projectPrefix + entry.path;
    const before = status.projectPrefix + (entry.originalPath || entry.path);
    const blob = (specifier) => this.git(['cat-file', 'blob', specifier]);
    const original = group === 'staged'
      ? (entry.code === 'A' || status.unborn ? '' : await blob(`HEAD:${before}`))
      : (entry.code === '?' ? '' : await blob(`:${file}`));
    let modified = '';
    if (entry.code !== 'D') {
      if (group === 'staged')
        modified = await blob(`:${file}`);
      else {
        const target = resolveInside(this.root, entry.path);
        const stat = await fs.lstat(path.join(this.root, entry.path));
        if (!stat.isFile() || stat.size > 1024 * 1024)
          throw new Error('Side-by-side view is available for text files up to 1 MB.');
        modified = await fs.readFile(target, 'utf8');
      }
    }
    if ([original, modified].some((text) => text.includes('\0') || text.length > 1024 * 1024))
      throw new Error('Side-by-side view is available for text files up to 1 MB.');
    return { original, modified };
  }

  async conflictVersions(relative) {
    const { entry, status } = await this.entry('changes', relative);
    if (entry.code !== 'U')
      throw new Error('This file no longer has a merge conflict.');
    const filename = status.projectPrefix + entry.path;
    const records = await this.git(['ls-files', '-u', '-z', '--', entry.path]);
    const versions = { base: null, current: null, incoming: null };
    for (const record of records.split('\0').filter(Boolean)) {
      const stage = record.split('\t', 1)[0].split(' ')[2];
      const key = { 1: 'base', 2: 'current', 3: 'incoming' }[stage];
      const text = await this.git(['cat-file', 'blob', `:${stage}:${filename}`]);
      if (text.includes('\0') || text.length > 1024 * 1024)
        throw new Error('Conflict previews are available for text files up to 1 MB.');
      versions[key] = text;
    }
    return versions;
  }

  discard(relative, revision) {
    return this.mutate(async () => {
      const { entry } = await this.entry('changes', relative);
      if (entry.code === '?' || entry.code === 'U' || entry.originalPath)
        throw new Error('Choose a tracked file without merge conflicts to discard its working changes.');
      const review = await this.review('changes', relative);
      if (review.revision !== revision)
        throw new Error('The diff changed. Review it again before discarding.');
      await this.git(['restore', '--worktree', '--', entry.path]);
    });
  }

  applyHunk(group, relative, token, number) {
    return this.mutate(async () => {
      const { repositoryRoot } = await this.repository();
      const review = await this.review(group, relative);
      if (!review.token || review.token !== token || !Number.isSafeInteger(number) || !review.hunks[number])
        throw new Error('The diff changed. Review it again before applying this hunk.');
      await this.git(['apply', '--cached', ...(group === 'staged' ? ['--reverse'] : []), '--whitespace=nowarn', '-'],
        0, { cwd: repositoryRoot, input: review.header + review.hunks[number] });
    });
  }

  paths(entry, group) {
    return entry.originalPath && (group === 'staged' || 'RC'.includes(entry.code))
      ? [entry.originalPath, entry.path] : [entry.path];
  }

  mutate(operation) {
    const next = this.mutations.then(operation);
    this.mutations = next.catch(() => {});
    return next;
  }

  initialize() {
    return this.mutate(async () => {
      const status = await this.status();
      if (status.kind !== 'none')
        throw new Error(status.message || 'This project is already inside a Git repository.');
      await this.git(['init']);
    });
  }

  stage(relative) {
    return this.mutate(async () => {
      const { entry } = await this.entry('changes', relative);
      await this.git(['add', '--', ...this.paths(entry, 'changes')]);
    });
  }

  unstage(relative) {
    return this.mutate(async () => {
      const { entry, status } = await this.entry('staged', relative);
      // Reset needs a commit to restore from. On an unborn branch the index was empty.
      const args = status.unborn ? ['rm', '--cached', '-f'] : ['reset', '-q', 'HEAD'];
      await this.git([...args, '--', ...this.paths(entry, 'staged')]);
    });
  }

  stageAll() {
    return this.mutate(async () => {
      await this.repository();
      await this.git(['add', '-A', '--', '.']);
    });
  }

  unstageAll() {
    return this.mutate(async () => {
      const status = await this.repository();
      if (!status.staged.length)
        return;
      const args = status.unborn ? ['rm', '--cached', '-rf'] : ['reset', '-q', 'HEAD'];
      await this.git([...args, '--', '.']);
    });
  }

  async history(relative) {
    const status = await this.repository();
    if (status.unborn)
      return [];
    if (relative !== undefined)
      resolveInside(this.root, relative);
    return commitRecords(await this.git(['log', '-50', '--topo-order', '-z', `--format=${commitFormat}`, 'HEAD',
      ...(relative === undefined ? [] : ['--follow']), '--', ...(relative === undefined ? [] : [relative])]));
  }

  async blame(relative) {
    await this.repository();
    resolveInside(this.root, relative);
    return this.git(['blame', '--date=short', 'HEAD', '--', relative]);
  }

  async commitDiff(oid) {
    const status = await this.repository();
    if (typeof oid !== 'string' || !/^(?:[\da-f]{40}|[\da-f]{64})$/u.test(oid))
      throw new Error('Choose a commit from Git history.');
    return this.git(['show', '--format=fuller', '--diff-merges=first-parent', '--no-color', '--no-ext-diff', '--no-textconv',
      oid, '--', ...(status.projectPrefix ? ['.'] : [])]);
  }

  async branches() {
    await this.repository();
    const refs = await this.git(['for-each-ref', '--format=%(refname:strip=2)%00%(HEAD)', 'refs/heads/']);
    return refs.trimEnd().split('\n').filter(Boolean).map((row) => {
      const [name, current] = row.split('\0');
      return { name, current: current?.trim() === '*' };
    });
  }

  createBranch(name) {
    return this.mutate(async () => {
      await this.repository();
      await this.git(['switch', '-c', branchName(name)]);
    });
  }

  renameBranch(name, replacement) {
    return this.mutate(async () => {
      if (!(await this.branches()).some((branch) => branch.name === name))
        throw new Error('This branch is no longer available.');
      await this.git(['branch', '-m', '--', name, branchName(replacement)]);
    });
  }

  deleteBranch(name) {
    return this.mutate(async () => {
      if (!(await this.branches()).some((branch) => branch.name === name && !branch.current))
        throw new Error('Choose another local branch to delete.');
      await this.git(['branch', '-d', '--', name]);
    });
  }

  switchBranch(name) {
    return this.mutate(async () => {
      if (!(await this.branches()).some((branch) => branch.name === name))
        throw new Error('This branch is no longer available.');
      await this.git(['switch', '--no-guess', '--', name]);
    });
  }

  mergeBranch(name) {
    return this.mutate(async () => {
      if (!(await this.branches()).some((branch) => branch.name === name && !branch.current))
        throw new Error('Choose another local branch to merge.');
      await this.git(['merge', '--no-edit', '--', `refs/heads/${name}`]);
    });
  }

  abortMerge() {
    return this.mutate(async () => {
      if (!(await this.repository()).merging)
        throw new Error('There is no merge in progress.');
      await this.git(['merge', '--abort']);
    });
  }

  async stashes() {
    await this.repository();
    const output = await this.git(['stash', 'list', '-z', '--format=%H%x00%gd%x00%gs']);
    const fields = output.replace(/\0$/, '').split('\0');
    const stashes = [];
    for (let i = 0; i + 2 < fields.length; i += 3)
      stashes.push({ oid: fields[i], ref: fields[i + 1], subject: fields[i + 2] });
    return stashes;
  }

  saveStash(message) {
    return this.mutate(async () => {
      const { repositoryRoot } = await this.repository();
      // Stash calls clean internally with a wildcard; there are no user pathspecs here.
      await this.git(['--no-literal-pathspecs', 'stash', 'push', '--include-untracked',
        ...(typeof message === 'string' && message.trim() ? ['-m', message.trim()] : [])],
        0, { cwd: repositoryRoot });
    });
  }

  applyStash(oid) {
    return this.mutate(async () => {
      if (!(await this.stashes()).some((stash) => stash.oid === oid))
        throw new Error('This stash is no longer available.');
      await this.git(['stash', 'apply', oid]);
    });
  }

  dropStash(oid) {
    return this.mutate(async () => {
      const stash = (await this.stashes()).find((item) => item.oid === oid);
      if (!stash)
        throw new Error('This stash is no longer available.');
      await this.git(['stash', 'drop', stash.ref]);
    });
  }

  async remotes() {
    await this.repository();
    return (await this.git(['remote'])).trim().split(/\r?\n/).filter(Boolean);
  }

  addRemote(name, url) {
    return this.mutate(async () => {
      await this.repository();
      if (typeof name !== 'string' || typeof url !== 'string' || !name.trim() || !url.trim())
        throw new Error('Enter a remote name and URL.');
      // Git accepts external remote helpers through the transport prefix.
      if (/^[a-z][a-z\d+.-]*::/iu.test(url.trim()))
        throw new Error('Use an HTTPS, SSH or local repository URL.');
      await this.git(['remote', 'add', '--', name.trim(), url.trim()]);
    });
  }

  fetch() {
    return this.mutate(async () => {
      await this.repository();
      await this.git(['fetch', '--all']);
    });
  }

  async trackingBranch() {
    const status = await this.repository();
    if (!status.upstream || status.detached || status.unborn)
      throw new Error('Publish the current branch or configure an upstream branch first.');
    return status;
  }

  pull() {
    return this.mutate(async () => {
      await this.trackingBranch();
      await this.git(['pull', '--ff-only']);
    });
  }

  push() {
    return this.mutate(async () => {
      await this.pushUpstream(await this.trackingBranch());
    });
  }

  async pushUpstream(status) {
    const local = `refs/heads/${status.branch}`;
    const [remote, target] = (await this.git(['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)', local]))
      .trimEnd().split('\0');
    if (!remote || !target)
      throw new Error('The configured upstream is unavailable. Refresh Source Control.');
    await this.git(['push', '--', remote, `${local}:${target}`]);
  }

  sync() {
    return this.mutate(async () => {
      const status = await this.trackingBranch();
      await this.git(['pull', '--ff-only']);
      await this.pushUpstream(status);
    });
  }

  publish(remote) {
    return this.mutate(async () => {
      const status = await this.repository();
      if (status.detached || status.unborn)
        throw new Error('Switch to a branch with a commit before publishing.');
      if (!(await this.remotes()).includes(remote))
        throw new Error('Choose a configured remote.');
      await this.git(['push', '--set-upstream', '--', remote, `refs/heads/${status.branch}`]);
    });
  }

  commit(message, amend = false) {
    return this.mutate(async () => {
      if (typeof message !== 'string' || !message.trim() || message.includes('\0'))
        throw new Error('Enter a commit message.');
      const status = await this.repository();
      if (amend && (status.unborn || status.merging || status.projectPrefix))
        throw new Error('Open the repository root on an existing commit, outside a merge, to amend it.');
      if (status.stagedOutsideProject)
        throw new Error('There are staged changes outside this project. Open the repository root to review and commit them.');
      if (status.changes.some(({ code }) => code === 'U'))
        throw new Error('Resolve and stage all merge conflicts before committing.');
      if (!status.staged.length && !status.merging && !amend)
        throw new Error('Stage at least one change before committing.');
      await this.git(['-c', 'user.useConfigOnly=true', 'commit', ...(amend ? ['--amend'] : []), '-m', message.trim()]);
    });
  }
}

module.exports = { SourceControl };
