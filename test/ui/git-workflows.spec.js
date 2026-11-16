'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('./desktop');

test.use({ projectOnLaunch: true });

function gitAt(cwd) {
  return (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 15_000 }).trim();
}

function gitIdentity(git) {
  git('config', 'user.name', 'Keywright Test');
  git('config', 'user.email', 'keywright@example.test');
  git('config', 'commit.gpgsign', 'false');
}

function initialize(project) {
  const git = gitAt(project);
  git('init', '-b', 'main');
  gitIdentity(git);
  fs.writeFileSync(path.join(project, 'review.txt'), 'baseline\n');
  git('add', '--', 'review.txt');
  git('commit', '-m', 'Track review notes');
  return git;
}

async function openSourceControl(page) {
  await page.getByRole('tab', { name: 'Source Control', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: 'Source Control', exact: true });
  await expect(panel.getByRole('button', { name: 'main', exact: true })).toBeVisible();
  return panel;
}

async function repositoryAction(panel, name) {
  await panel.getByRole('button', { name: 'Repository Actions', exact: true }).click();
  await panel.getByRole('button', { name, exact: true }).click();
}

test('publishes, pushes, fetches and pulls using a temporary local remote', async ({ desktop }) => {
  const { page, project } = desktop;
  const git = initialize(project);
  const parent = path.dirname(project);
  const remote = path.join(parent, 'remote.git');
  const peer = path.join(parent, 'peer');
  gitAt(parent)('init', '--bare', '--initial-branch=main', remote);
  const remoteGit = gitAt(remote);
  git('remote', 'add', 'origin', remote);

  const panel = await openSourceControl(page);
  await repositoryAction(panel, 'Publish Branch');
  await page.getByRole('dialog', { name: 'Publish Branch' }).getByRole('button', { name: 'origin', exact: true }).click();
  await expect(panel.locator('#source-upstream')).toContainText('origin/main');
  expect(remoteGit('rev-parse', 'main')).toBe(git('rev-parse', 'HEAD'));

  fs.appendFileSync(path.join(project, 'review.txt'), 'desktop revision\n');
  git('commit', '-am', 'Update review notes');
  await repositoryAction(panel, 'Push');
  await expect.poll(() => remoteGit('show', 'main:review.txt')).toContain('desktop revision');

  gitAt(parent)('clone', remote, peer);
  const peerGit = gitAt(peer);
  gitIdentity(peerGit);
  fs.appendFileSync(path.join(peer, 'review.txt'), 'peer revision\n');
  peerGit('commit', '-am', 'Review from peer');
  peerGit('push');
  const localBefore = git('rev-parse', 'HEAD');
  const peerTip = peerGit('rev-parse', 'HEAD');
  await repositoryAction(panel, 'Fetch');
  await expect.poll(() => git('rev-parse', 'origin/main')).toBe(peerTip);
  expect(git('rev-parse', 'HEAD')).toBe(localBefore);
  await repositoryAction(panel, 'Pull');
  await expect.poll(() => git('rev-parse', 'HEAD')).toBe(peerTip);
  expect(fs.readFileSync(path.join(project, 'review.txt'), 'utf8')).toContain('peer revision');
  await expect(panel.getByRole('alert')).toBeHidden();
});

test('stashes and restores working changes, then discards them through Git Diff', async ({ desktop }) => {
  const { page, project } = desktop;
  const git = initialize(project);
  git('add', '.');
  git('commit', '-m', 'Track the example');
  const file = path.join(project, 'review.txt');
  fs.writeFileSync(file, 'working edit\n');
  const panel = await openSourceControl(page);
  const changes = panel.getByRole('region', { name: 'Changes', exact: true });
  await expect(changes.getByRole('button', { name: 'View diff for review.txt' })).toBeVisible();
  await repositoryAction(panel, 'Stashes');
  const stashes = page.getByRole('dialog', { name: 'Stashes' });
  await stashes.getByRole('textbox', { name: 'Stash message (optional)' }).fill('Desktop change');
  await stashes.getByRole('button', { name: 'Save Stash', exact: true }).click();
  await expect(changes).toBeHidden();
  expect(git('stash', 'list')).toContain('Desktop change');
  expect(fs.readFileSync(file, 'utf8').trim()).toBe('baseline');

  await repositoryAction(panel, 'Stashes');
  await stashes.getByRole('button', { name: /Desktop change Apply stash/ }).click();
  await changes.getByRole('button', { name: 'View diff for review.txt' }).click();
  const diff = page.getByRole('tabpanel', { name: 'Git Diff', exact: true });
  await diff.getByRole('button', { name: 'Discard Changes', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Discard Changes', exact: true });
  await confirmation.getByRole('button', { name: 'Discard Working Changes', exact: true }).click();
  await expect(changes).toBeHidden();
  expect(git('status', '--porcelain')).toBe('');
  expect(fs.readFileSync(file, 'utf8').trim()).toBe('baseline');

  await repositoryAction(panel, 'Stashes');
  await stashes.getByRole('button', { name: /^Drop stash/ }).click();
  await page.getByRole('dialog', { name: 'Drop Stash', exact: true }).getByRole('button', { name: 'Drop Stash', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Repository Actions', exact: true })).toBeEnabled();
  await expect(panel.getByRole('alert')).toBeHidden();
  expect(git('stash', 'list')).toBe('');
});
