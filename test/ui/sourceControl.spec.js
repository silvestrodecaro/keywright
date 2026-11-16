'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('./desktop');

test.use({ projectOnLaunch: true });

test('reviews, stages, unstages and commits saved changes from Source Control', async ({ desktop }, testInfo) => {
  test.skip(spawnSync('git', ['--version'], { windowsHide: true }).status !== 0, 'Git is unavailable');
  const { page, project } = desktop;
  const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8', windowsHide: true }).trim();

  await expect(page.locator('#view-project')).toBeVisible();
  await page.keyboard.press('Control+Shift+G');
  await expect(page.getByRole('tab', { name: 'Source Control', exact: true })).toBeFocused();
  const panel = page.getByRole('tabpanel', { name: 'Source Control', exact: true });
  await expect(panel.getByRole('heading', { name: 'Source Control', exact: true })).toBeVisible();
  await expect(panel.getByText('This project has no Git repository.')).toBeVisible();
  await panel.getByRole('button', { name: 'Initialize Repository' }).click();
  await expect(panel.getByText('No commits yet', { exact: true })).toBeVisible();
  git('config', 'user.name', 'Keywright Test');
  git('config', 'user.email', 'keywright@example.test');
  git('config', 'commit.gpgsign', 'false');

  const file = path.join(project, 'review.txt');
  fs.writeFileSync(file, 'first version\n');
  const changes = panel.getByRole('region', { name: 'Changes', exact: true });
  const staged = panel.getByRole('region', { name: 'Staged Changes', exact: true });
  const message = panel.getByRole('textbox', { name: 'Commit message' });
  const commit = panel.getByRole('button', { name: 'Commit', exact: true });
  await message.fill('Add review notes');
  await expect(commit).toBeDisabled();

  await changes.getByRole('button', { name: 'View diff for review.txt' }).click();
  const diff = page.getByRole('tabpanel', { name: 'Git Diff' });
  await expect(diff.locator('.monaco-diff-editor')).toBeVisible();
  await diff.getByRole('button', { name: 'Show Patch' }).click();
  await expect(diff.getByText('+first version', { exact: true })).toBeVisible();
  await changes.getByRole('button', { name: 'Stage review.txt' }).click();
  await expect(commit).toBeEnabled();
  await staged.getByRole('button', { name: 'Unstage review.txt' }).click();
  await expect(commit).toBeDisabled();
  await changes.getByRole('button', { name: 'Stage review.txt' }).click();
  await expect(staged.getByRole('button', { name: 'Unstage review.txt' })).toBeEnabled();

  fs.writeFileSync(file, 'second version\n');
  await changes.getByRole('button', { name: 'View diff for review.txt' }).click();
  await diff.getByRole('button', { name: 'Show Patch' }).click();
  await expect(diff.getByText('+second version', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('source-control.png') });
  await page.setViewportSize({ width: 900, height: 560 });
  await page.evaluate(() => document.documentElement.style.setProperty('--sidebar-width', '250px'));
  await expect(panel.getByRole('button', { name: 'Commit', exact: true })).toBeVisible();
  expect(await page.getByRole('tablist', { name: 'Project tools' }).getByRole('tab').evaluateAll((tabs) =>
    tabs.filter((tab) => tab.scrollWidth > tab.clientWidth).map((tab) => tab.textContent.trim()))).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('source-control-minimum.png') });
  const lock = path.join(project, '.git', 'index.lock');
  fs.writeFileSync(lock, '', { flag: 'wx' });
  try {
    await commit.click();
    await expect(panel.getByRole('alert')).toContainText('index.lock');
    await expect(message).toHaveValue('Add review notes');
  } finally {
    fs.unlinkSync(lock);
  }
  await commit.click();
  await expect(message).toHaveValue('');
  await expect(staged).toBeHidden();
  expect(git('log', '-1', '--format=%s')).toBe('Add review notes');
  expect(git('show', 'HEAD:review.txt')).toBe('first version');
  expect(fs.readFileSync(file, 'utf8')).toBe('second version\n');
  await diff.getByRole('button', { name: 'Close Diff' }).click();
  await expect(diff).toBeHidden();
});

test('uses the parent Git repository while keeping Source Control scoped to the open project', async ({ desktop }) => {
  test.skip(spawnSync('git', ['--version'], { windowsHide: true }).status !== 0, 'Git is unavailable');
  const { page, project } = desktop;
  const root = path.dirname(project);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-b', 'walkthrough');
  git('config', 'user.name', 'Keywright Test');
  git('config', 'user.email', 'keywright@example.test');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(root, '.git', 'info', 'exclude'), '/profile/\n');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'outside\n');
  fs.writeFileSync(path.join(project, 'inside.txt'), 'inside\n');
  git('add', '--', 'outside.txt');

  await page.getByRole('tab', { name: 'Source Control', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: 'Source Control', exact: true });
  await expect(panel.getByText('walkthrough', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Initialize Repository' })).toBeHidden();
  await expect(panel.getByText('outside.txt', { exact: true })).toBeHidden();
  await panel.getByRole('button', { name: 'View diff for inside.txt' }).click();
  await page.getByRole('button', { name: 'Show Patch' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Git Diff' }).getByText('+inside', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Stage inside.txt' }).click();
  await expect(panel.getByRole('button', { name: 'Unstage inside.txt' })).toBeEnabled();
  await panel.getByRole('textbox', { name: 'Commit message' }).fill('Commit the project');
  const commit = panel.getByRole('button', { name: 'Commit', exact: true });
  await expect(panel.getByRole('status')).toContainText('Staged changes outside this project');
  await expect(commit).toBeDisabled();

  git('rm', '--cached', '--', 'outside.txt');
  await panel.getByRole('button', { name: 'Refresh Source Control' }).click();
  await expect(commit).toBeEnabled();
  await commit.click();
  await expect(panel.getByRole('textbox', { name: 'Commit message' })).toHaveValue('');
  expect(git('ls-tree', '-r', '--name-only', 'HEAD')).toBe('project/inside.txt');
});

test('reviews history, switches branches and stages an individual hunk', async ({ desktop }, testInfo) => {
  test.skip(spawnSync('git', ['--version'], { windowsHide: true }).status !== 0, 'Git is unavailable');
  const { page, project } = desktop;
  const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Keywright Test');
  git('config', 'user.email', 'keywright@example.test');
  const file = path.join(project, 'lines.txt');
  const original = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n';
  fs.writeFileSync(file, original);
  git('add', 'lines.txt');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Add original lines');
  git('switch', '-c', 'documentation');
  fs.writeFileSync(path.join(project, 'notes.txt'), 'Review notes\n');
  git('add', 'notes.txt');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Add review notes');
  git('switch', 'main');
  fs.writeFileSync(path.join(project, 'config.txt'), 'suite settings\n');
  git('add', 'config.txt');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Record suite settings');
  git('-c', 'commit.gpgsign=false', 'merge', '--no-edit', 'documentation');

  const activity = page.getByRole('tab', { name: 'Source Control', exact: true });
  await page.getByRole('tab', { name: 'Search', exact: true }).click();
  await page.keyboard.press('ArrowDown');
  await expect(activity).toBeFocused();
  const panel = page.getByRole('tabpanel', { name: 'Source Control', exact: true });
  await panel.getByRole('button', { name: 'main', exact: true }).click();
  const branches = page.getByRole('dialog', { name: 'Branches' });
  await branches.getByRole('textbox', { name: 'Branch name' }).fill('feature/lines');
  await branches.getByRole('button', { name: 'Create and Switch' }).click();
  await expect(panel.getByText('feature/lines', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'feature/lines', exact: true }).last()).toBeVisible();

  const graph = panel.getByRole('region', { name: 'Graph', exact: true });
  const graphToggle = graph.getByRole('button', { name: 'Graph', exact: true });
  const initialCommit = graph.getByRole('button', { name: /Add original lines/ });
  await expect(graph.getByRole('button', { name: /Merge branch 'documentation'/ })).toBeVisible();
  await graphToggle.click();
  await expect(initialCommit).toBeHidden();
  await graphToggle.click();
  await initialCommit.click();
  const diff = page.getByRole('tabpanel', { name: 'Git Diff' });
  await expect(diff.getByText('+line 0', { exact: true })).toBeVisible();

  fs.writeFileSync(file, original.replace('line 1\n', 'first\n').replace('line 25\n', 'last\n'));
  const changes = panel.getByRole('region', { name: 'Changes', exact: true });
  await changes.getByRole('button', { name: 'View diff for lines.txt' }).click();
  await expect(diff.locator('.monaco-diff-editor')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('source-control-comparison.png') });
  await diff.getByRole('button', { name: 'Show Patch' }).click();
  const hunks = diff.getByRole('button', { name: 'Stage Hunk', exact: true });
  await expect(hunks).toHaveCount(2);
  await diff.getByRole('button', { name: 'Side by Side' }).click();
  await expect(diff.locator('.monaco-diff-editor')).toBeVisible();
  await diff.getByRole('button', { name: 'Show Patch' }).click();
  await hunks.first().click();
  await expect(hunks).toHaveCount(1);
  expect(git('show', ':lines.txt')).toContain('first\n');
  expect(git('show', ':lines.txt')).toContain('line 25\n');
  const more = panel.getByRole('button', { name: 'Repository Actions', exact: true });
  await more.click();
  await panel.getByRole('button', { name: 'Remotes', exact: true }).click();
  const remotes = page.getByRole('dialog', { name: 'Remotes', exact: true });
  await remotes.getByRole('textbox', { name: 'Remote name' }).fill('origin');
  await remotes.getByRole('button', { name: 'Continue', exact: true }).click();
  const remoteForm = page.getByRole('dialog', { name: 'Add remote origin', exact: true });
  await remoteForm.getByRole('textbox', { name: 'Remote URL' }).fill('https://example.test/team/robot.git');
  await remoteForm.getByRole('button', { name: 'Add Remote', exact: true }).click();
  await expect(more).toBeEnabled();
  expect(git('remote', 'get-url', 'origin')).toBe('https://example.test/team/robot.git');
  await more.click();
  await expect(panel.getByRole('button', { name: 'Publish Branch', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.screenshot({ path: testInfo.outputPath('source-control-actions.png') });
});
