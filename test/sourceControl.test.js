'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./helpers/tempDir');

const gitAvailable = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const gitTest = (name, run) => test(name, { skip: !gitAvailable && 'Git is unavailable' }, run);

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
}

function readCheckedOutText(file) {
  // Git can write CRLF when applying a stash, pulling or restoring from the index.
  return fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
}

function fixture({ committed = true } = {}) {
  const root = tempDir('git');
  git(root, 'init', '-b', 'robot-tests');
  git(root, 'config', 'user.name', 'Keywright Test');
  git(root, 'config', 'user.email', 'keywright@example.test');
  git(root, 'config', 'commit.gpgsign', 'false');
  if (committed) {
    fs.writeFileSync(path.join(root, 'suite.robot'), 'original\n');
    git(root, 'add', 'suite.robot');
    git(root, 'commit', '-m', 'Initial');
  }
  const { SourceControl } = require('../src/main/sourceControl');
  return { root, source: new SourceControl(root) };
}

gitTest('reviews both layers of a change and commits only the staged version', async () => {
  const { root, source } = fixture();
  const file = path.join(root, 'suite.robot');
  fs.writeFileSync(file, 'staged line\n');
  await source.stage('suite.robot');
  fs.writeFileSync(file, 'working line\n');
  const status = await source.status();
  assert.equal(status.branch, 'robot-tests');
  assert.deepEqual(status.staged.map(({ path, code }) => [path, code]), [['suite.robot', 'M']]);
  assert.deepEqual(status.changes.map(({ path, code }) => [path, code]), [['suite.robot', 'M']]);
  assert.match(await source.diff('staged', 'suite.robot'), /\+staged line/);
  assert.match(await source.diff('changes', 'suite.robot'), /-staged line[\s\S]*\+working line/);
  await source.commit('Save staged test');
  assert.equal(git(root, 'show', 'HEAD:suite.robot'), 'staged line');
  assert.equal(fs.readFileSync(file, 'utf8'), 'working line\n');
  assert.equal((await source.status()).staged.length, 0);
});

gitTest('previews untracked files and unstages them before the first commit', async () => {
  const { root, source } = fixture({ committed: false });
  const relative = 'suite space è.robot';
  const file = path.join(root, relative);
  fs.writeFileSync(file, 'first line\n');
  fs.writeFileSync(path.join(root, 'other.robot'), 'other\n');
  const status = await source.status();
  assert.equal(status.unborn, true);
  assert.deepEqual(status.changes.map((entry) => entry.path).sort(), ['other.robot', relative]);
  assert.match(await source.diff('changes', relative), /\+first line/);
  await source.stage(relative);
  assert.match(await source.diff('staged', relative), /\+first line/);
  await source.unstage(relative);
  assert.deepEqual((await source.status()).staged, []);
  assert.equal(fs.readFileSync(file, 'utf8'), 'first line\n');
  await assert.rejects(source.commit('Empty commit'), /stage/i);
});

gitTest('unstages both sides of a rename and rejects arbitrary paths', async () => {
  const { root, source } = fixture();
  git(root, 'mv', 'suite.robot', 'renamed.robot');
  const status = await source.status();
  assert.deepEqual(status.staged.map(({ code, path, originalPath }) => [code, path, originalPath]),
    [['R', 'renamed.robot', 'suite.robot']]);
  assert.match(await source.diff('staged', 'renamed.robot'), /rename from suite\.robot/);
  await assert.rejects(source.stage('../outside'), /change/i);
  await assert.rejects(source.stage('.'), /change/i);
  await source.unstage('renamed.robot');
  assert.deepEqual((await source.status()).staged, []);
  assert.ok(fs.existsSync(path.join(root, 'renamed.robot')));
});

gitTest('initializes a standalone project and finds the repository from a subfolder', async () => {
  const { SourceControl } = require('../src/main/sourceControl');
  const root = tempDir('git-init');
  const source = new SourceControl(root);
  assert.equal((await source.status()).kind, 'none');
  await source.initialize();
  assert.equal((await source.status()).kind, 'repository');
  const child = path.join(root, 'nested');
  fs.mkdirSync(child);
  const nested = new SourceControl(child);
  const status = await nested.status();
  assert.equal(status.kind, 'repository');
  assert.equal(fs.realpathSync.native(status.repositoryRoot), fs.realpathSync.native(root));
  assert.equal(status.projectPrefix, 'nested/');
  await assert.rejects(nested.initialize(), /repository/i);
  assert.equal(fs.existsSync(path.join(child, '.git')), false);
});

gitTest('scopes a nested project to its files and blocks commits with other staged changes', async () => {
  const { root } = fixture();
  const { SourceControl } = require('../src/main/sourceControl');
  const nested = path.join(root, 'examples', 'walkthrough');
  fs.mkdirSync(nested, { recursive: true });
  const source = new SourceControl(nested);
  fs.writeFileSync(path.join(root, 'suite.robot'), 'outside project\n');
  git(root, 'add', '--', 'suite.robot');
  fs.writeFileSync(path.join(nested, 'review.robot'), 'inside project\n');
  assert.deepEqual((await source.status()).changes, [{ path: 'review.robot', code: '?' }]);
  assert.match(await source.diff('changes', 'review.robot'), /\+inside project/);
  await assert.rejects(source.unstage('../../suite.robot'), /change/i);
  await source.stage('review.robot');
  assert.equal((await source.status()).stagedOutsideProject, true);
  await assert.rejects(source.commit('Scoped commit'), /staged changes outside/i);
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'Initial');
  git(root, 'reset', '--', 'suite.robot');
  await source.commit('Scoped commit');
  assert.equal(git(root, 'show', 'HEAD:examples/walkthrough/review.robot'), 'inside project');
  assert.equal(git(root, 'show', 'HEAD:suite.robot'), 'original');
});

gitTest('unstages only the project side of a rename crossing the project boundary', async () => {
  const { root } = fixture();
  const { SourceControl } = require('../src/main/sourceControl');
  const nested = path.join(root, 'examples');
  fs.mkdirSync(nested);
  git(root, 'mv', 'suite.robot', 'examples/renamed.robot');
  const source = new SourceControl(nested);
  const status = await source.status();
  assert.equal(status.stagedOutsideProject, true);
  assert.deepEqual(status.staged, [{ path: 'renamed.robot', code: 'A' }]);
  assert.match(await source.diff('staged', 'renamed.robot'), /new file mode/);
  await source.unstage('renamed.robot');
  assert.equal(git(root, 'diff', '--cached', '--name-status'), 'D\tsuite.robot');
});

gitTest('stages and unstages all project changes and reviews commit history', async () => {
  const { root, source } = fixture();
  fs.writeFileSync(path.join(root, 'new.robot'), 'new\n');
  fs.writeFileSync(path.join(root, 'suite.robot'), 'updated\n');
  await source.stageAll();
  assert.equal((await source.status()).staged.length, 2);
  await source.unstageAll();
  assert.equal((await source.status()).changes.length, 2);
  await source.stageAll();
  await source.commit('Update suites');
  const [commit] = await source.history();
  assert.equal(commit.subject, 'Update suites');
  assert.equal(commit.parents.length, 1);
  assert.match(await source.commitDiff(commit.oid), /\+updated/);
});

gitTest('creates and switches branches and saves and reapplies a stash', async () => {
  const { root, source } = fixture();
  await source.createBranch('feature/scm');
  assert.equal((await source.status()).branch, 'feature/scm');
  assert.deepEqual((await source.branches()).map(({ name }) => name), ['feature/scm', 'robot-tests']);
  fs.writeFileSync(path.join(root, 'suite.robot'), 'in progress\n');
  fs.writeFileSync(path.join(root, 'draft.robot'), 'draft\n');
  await source.saveStash('Draft suite');
  assert.equal((await source.status()).changes.length, 0);
  const [stash] = await source.stashes();
  assert.match(stash.subject, /Draft suite/);
  await source.switchBranch('robot-tests');
  await source.applyStash(stash.oid);
  assert.equal(readCheckedOutText(path.join(root, 'suite.robot')), 'in progress\n');
  assert.equal(readCheckedOutText(path.join(root, 'draft.robot')), 'draft\n');
  assert.equal((await source.stashes()).length, 1);
  await source.dropStash(stash.oid);
  assert.equal((await source.stashes()).length, 0);
  await source.renameBranch('feature/scm', 'feature/renamed');
  await source.deleteBranch('feature/renamed');
  assert.deepEqual((await source.branches()).map(({ name }) => name), ['robot-tests']);
});

gitTest('publishes, fetches, pulls and pushes through a local bare remote', async () => {
  const { root, source } = fixture();
  const remote = tempDir('git-remote');
  git(remote, 'init', '--bare', '-b', 'robot-tests');
  await source.addRemote('origin', remote);
  assert.deepEqual(await source.remotes(), ['origin']);
  await source.publish('origin');
  assert.equal((await source.status()).upstream, 'origin/robot-tests');
  const other = tempDir('git-clone');
  git(other, 'clone', remote, '.');
  git(other, 'config', 'user.name', 'Keywright Test');
  git(other, 'config', 'user.email', 'keywright@example.test');
  fs.writeFileSync(path.join(other, 'incoming.robot'), 'incoming\n');
  git(other, 'add', 'incoming.robot');
  git(other, '-c', 'commit.gpgsign=false', 'commit', '-m', 'Incoming');
  git(other, 'push');
  await source.fetch();
  assert.equal((await source.status()).behind, 1);
  await source.pull();
  assert.equal(readCheckedOutText(path.join(root, 'incoming.robot')), 'incoming\n');
  fs.writeFileSync(path.join(root, 'outgoing.robot'), 'outgoing\n');
  await source.stageAll();
  await source.commit('Outgoing');
  assert.equal((await source.status()).ahead, 1);
  await source.sync();
  assert.equal(git(remote, 'log', '-1', '--format=%s'), 'Outgoing');
});

gitTest('stages a single hunk and rejects a stale patch selection', async () => {
  const { root, source } = fixture({ committed: false });
  const file = path.join(root, 'many.robot');
  const original = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n';
  fs.writeFileSync(file, original);
  git(root, 'add', 'many.robot');
  git(root, 'commit', '-m', 'Initial');
  fs.writeFileSync(file, original.replace('line 1\n', 'first\n').replace('line 25\n', 'last\n'));
  const patch = await source.diff('changes', 'many.robot');
  const token = require('node:crypto').createHash('sha256').update(patch).digest('hex');
  await source.applyHunk('changes', 'many.robot', token, 0);
  assert.match(await source.diff('staged', 'many.robot'), /\+first/);
  assert.match(await source.diff('changes', 'many.robot'), /\+last/);
  await assert.rejects(source.applyHunk('changes', 'many.robot', token, 0), /changed/i);
  const staged = await source.review('staged', 'many.robot');
  await source.applyHunk('staged', 'many.robot', staged.token, 0);
  assert.equal((await source.status()).staged.length, 0);
  assert.equal(fs.readFileSync(file, 'utf8').includes('first'), true);
});

gitTest('discards working changes back to the index while preserving staged changes', async () => {
  const { root, source } = fixture();
  const file = path.join(root, 'suite.robot');
  fs.writeFileSync(file, 'staged\n');
  await source.stage('suite.robot');
  fs.writeFileSync(file, 'discard me\n');
  const token = (await source.review('changes', 'suite.robot')).revision;
  fs.writeFileSync(file, 'newer edit\n');
  await assert.rejects(source.discard('suite.robot', token), /changed/i);
  await source.discard('suite.robot', (await source.review('changes', 'suite.robot')).revision);
  assert.equal(readCheckedOutText(file), 'staged\n');
  assert.match(await source.diff('staged', 'suite.robot'), /\+staged/);
});

gitTest('lists conflicts and completes a branch merge after the resolution is staged', async () => {
  const { root, source } = fixture();
  const file = path.join(root, 'suite.robot');
  await source.createBranch('incoming');
  fs.writeFileSync(file, 'incoming\n');
  await source.stage('suite.robot');
  await source.commit('Incoming');
  await source.switchBranch('robot-tests');
  fs.writeFileSync(file, 'current\n');
  await source.stage('suite.robot');
  await source.commit('Current');
  await assert.rejects(source.mergeBranch('incoming'), /conflict/i);
  const status = await source.status();
  assert.equal(status.merging, true);
  assert.equal(status.changes[0].code, 'U');
  assert.deepEqual(await source.conflictVersions('suite.robot'), {
    base: 'original\n', current: 'current\n', incoming: 'incoming\n',
  });
  fs.writeFileSync(file, 'resolved\n');
  await source.stage('suite.robot');
  await source.commit('Merge incoming');
  assert.equal((await source.status()).merging, false);
  assert.equal((await source.history())[0].parents.length, 2);
});

gitTest('amends the last commit and shows the history and blame of a file', async () => {
  const { root, source } = fixture();
  fs.writeFileSync(path.join(root, 'suite.robot'), 'revised\n');
  await source.stageAll();
  await source.commit('Before amend');
  await source.commit('After amend', true);
  assert.deepEqual((await source.history('suite.robot')).map(({ subject }) => subject), ['After amend', 'Initial']);
  assert.match(await source.blame('suite.robot'), /Keywright Test.*revised/u);
});
