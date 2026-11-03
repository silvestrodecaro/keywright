'use strict';

// Coordinates editor snapshots, disk revisions and the preflight shared by every Run action.
(function (root, factory) {
  const exports = factory();
  if (typeof module === 'object' && module.exports)
    module.exports = exports;
  else
    root.RFWorkspaceFiles = exports;
})(typeof window === 'object' ? window : globalThis, function () {
  class WorkspaceFiles {
    /**
     * `compare({ path, disk, mine })` shows both versions of a conflicting file and
     * resolves to { choice: 'save', content } | { choice: 'reload' } | { choice: 'cancel' }.
     */
    constructor({ editor, api, getFile, onSaved = () => {}, status = () => {}, compare = async () => ({ choice: 'cancel' }) }) {
      Object.assign(this, { editor, api, getFile, onSaved, status, compare });
      this.pending = new Map();
    }

    async read(path) {
      try {
        return await this.api.readProjectFile(path);
      } catch (error) {
        const detail = String(error?.message || error)
          .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
        const reason = detail.startsWith('Path is outside the project:')
          ? 'This path leads outside the project. Open the destination folder to edit it.'
          : `Could not open this file: ${detail}\nCheck its location and read permissions, then close this tab and reopen the file.`;
        return { path, content: null, reason };
      }
    }

    save(path) {
      // A second Ctrl+S waits for the first revision before taking its own snapshot.
      const previous = this.pending.get(path) || Promise.resolve();
      const saving = previous.then(() => this.saveNow(path));
      this.pending.set(path, saving);
      saving.finally(() => {
        if (this.pending.get(path) === saving)
          this.pending.delete(path);
      });
      return saving;
    }

    async saveNow(path) {
      if (!this.editor.has(path))
        return true;
      const file = this.getFile(path);
      if (!file)
        return false;
      let snapshot = this.editor.snapshot(path);
      let revision = file.revision;
      const readDisk = async () => {
        const disk = await this.api.readProjectFile(path);
        if (disk.content === null)
          throw new Error(disk.reason);
        return disk;
      };
      const reloadFrom = (disk) => {
        this.editor.reload(path, disk.content, { discardChanges: true });
        Object.assign(file, { content: disk.content, revision: disk.revision });
        this.status(`Reloaded ${path} from disk.`);
        return false;
      };
      try {
        let result = await this.api.writeProjectFile(path, snapshot.content, revision);
        while (result.conflict) {
          const choice = await this.api.confirmFileConflict(path, result.revision === null);
          if (choice === 'reload')
            return reloadFrom(await readDisk());
          if (choice === 'compare') {
            const disk = await readDisk();
            const outcome = await this.compare({ path, disk: disk.content, mine: snapshot.content });
            if (outcome?.choice === 'reload')
              return reloadFrom(disk);
            if (outcome?.choice !== 'save') {
              this.status(`Save cancelled: ${path} changed on disk.`, true);
              return false;
            }
            // The merged text goes into the editor first, so a further conflict cannot lose it.
            if (outcome.content !== snapshot.content) {
              this.editor.restoreContent(path, outcome.content);
              snapshot = this.editor.snapshot(path);
            }
            revision = disk.revision;
            result = await this.api.writeProjectFile(path, snapshot.content, revision);
            continue;
          }
          if (choice !== 'overwrite') {
            this.status(`Save cancelled: ${path} changed on disk.`, true);
            return false;
          }
          // Recheck even after explicit overwrite: the file may have changed again in the dialog.
          revision = result.revision;
          result = await this.api.writeProjectFile(path, snapshot.content, revision);
        }
        if (!result.ok)
          throw new Error(result.error || 'The file could not be saved.');
        if (this.getFile(path) !== file || !this.editor.has(path))
          return !this.editor.isDirty(path);
        Object.assign(file, { content: snapshot.content, revision: result.revision });
        this.editor.markSaved(path, snapshot.version);
        this.onSaved(path);
        const clean = !this.editor.isDirty(path);
        this.status(clean ? `Saved ${path}` : `Saved ${path}; newer edits are still unsaved.`, !clean);
        return clean;
      } catch (error) {
        this.status(`Could not save ${path}: ${error.message}`, true);
        return false;
      }
    }

    async resolveUnsaved(paths) {
      await Promise.all([...this.pending.values()]);
      const dirty = paths.filter((path) => this.editor.isDirty(path));
      if (!dirty.length) return true;
      const choice = await this.api.confirmUnsaved(dirty);
      if (choice === 'discard') return true;
      if (choice !== 'save') return false;
      for (const path of dirty) {
        if (!await this.save(path)) return false;
      }
      if (paths.some((path) => this.editor.isDirty(path))) {
        this.status('Files changed while saving. Review the remaining unsaved edits before closing.', true);
        return false;
      }
      return true;
    }

    async prepareRun({ background = false } = {}) {
      await Promise.all([...this.pending.values()]);
      const dirty = this.editor.dirtyPaths();
      if (!dirty.length)
        return { ok: true, saved: false };
      if (background)
        return { ok: false, message: 'Watch paused: save your open changes to resume, or run the saved files manually.' };
      const choice = await this.api.confirmRunChanges(dirty);
      if (choice === 'saved')
        return { ok: true, saved: false, usingSaved: true, message: 'Running saved files. Unsaved editor changes are not included.' };
      if (choice !== 'save')
        return { ok: false, message: 'Run cancelled.' };
      for (const path of dirty) {
        if (!await this.save(path))
          return { ok: false, message: `Run cancelled: ${path} was not saved. Resolve its changes and run again.` };
      }
      if (this.editor.dirtyPaths().length)
        return { ok: false, message: 'Run cancelled: files changed while saving. Save the remaining edits and run again.' };
      return { ok: true, saved: true };
    }
  }
  return { WorkspaceFiles };
});
