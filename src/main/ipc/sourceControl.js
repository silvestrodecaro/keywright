'use strict';

// The Source Control panel's channels (source-control:*). They act on the open project's
// repository only, run a fixed list of Git actions, and refuse those that change files
// while the editor has unsaved files.

// Git actions the panel may run; writesFiles: refused while editor files are unsaved.
const GIT_ACTIONS = new Map([
  ['stageAll', {}], ['unstageAll', {}], ['applyHunk', {}], ['history', {}], ['commitDiff', {}],
  ['comparison', {}], ['conflictVersions', {}], ['blame', {}], ['discard', { writesFiles: true }],
  ['branches', {}], ['createBranch', { writesFiles: true }], ['switchBranch', { writesFiles: true }],
  ['renameBranch', {}], ['deleteBranch', {}],
  ['mergeBranch', { writesFiles: true }], ['abortMerge', { writesFiles: true }],
  ['stashes', {}], ['saveStash', { writesFiles: true }], ['applyStash', { writesFiles: true }],
  ['dropStash', {}], ['remotes', {}], ['addRemote', {}], ['fetch', {}], ['pull', { writesFiles: true }], ['push', {}],
  ['sync', { writesFiles: true }], ['publish', {}],
]);

/**
 * @param {object} context
 * @param {{ handle: Function }} context.ipcMain
 * @param {() => { root: string } | null} context.project the open project
 * @param {() => import('../sourceControl').SourceControl | null} context.sourceControl its Git service
 * @param {() => string[]} context.dirtyPaths files with unsaved editor changes
 */
function createSourceControlIpc({ ipcMain, project, sourceControl, dirtyPaths }) {
  async function request(root, operation) {
    const source = sourceControl();
    if (project()?.root !== root || !source)
      return { ok: false, error: 'The project is no longer open.' };
    try {
      return { ok: true, value: await operation(source) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  ipcMain.handle('source-control:status', (_event, root) => request(root, (source) => source.status()));
  ipcMain.handle('source-control:diff', (_event, root, group, file) => request(root, async (source) => {
    const { patch, token, revision } = await source.review(group, file);
    return { patch, token, revision };
  }));
  ipcMain.handle('source-control:init', (_event, root) => request(root, (source) => source.initialize()));
  ipcMain.handle('source-control:stage', (_event, root, file) => request(root, (source) => source.stage(file)));
  ipcMain.handle('source-control:unstage', (_event, root, file) => request(root, (source) => source.unstage(file)));
  ipcMain.handle('source-control:commit', (_event, root, message) => request(root, (source) => source.commit(message)));
  ipcMain.handle('source-control:action', (_event, root, action, args) => request(root, async (source) => {
    const options = GIT_ACTIONS.get(action);
    if (!options || !Array.isArray(args) || args.length > 4)
      throw new Error('Unknown Git action.');
    if (options.writesFiles && dirtyPaths().length)
      throw new Error('Save or close unsaved editor files before running this Git action.');
    return source[action](...args);
  }));
  ipcMain.handle('source-control:amend', (_event, root, message) => request(root, (source) => source.commit(message, true)));
}

module.exports = { createSourceControlIpc };
