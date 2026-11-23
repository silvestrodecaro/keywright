// Rename (F2): user keywords and variables, across the project's files.
// Open files get the edits in the editor (unsaved, undoable); the others are written to disk.
// Monaco, the symbols and the editor/project access are passed in, so Node tests run it with stubs.
import { normalizeKeyword } from './robotSyntax.js';
import { invalidName, applyEdits } from './rename.js';
import { findKeywords } from './keywordCatalog.js';

/**
 * @param {{ symbols: { renameTarget, projectContents, symbolOccurrences },
 *   openModel: (path) => object|null, readVersion: (path) => number|undefined,
 *   readFile: (path) => Promise<object>, writeFile: (path, content, revision) => Promise<object>,
 *   disposePreviews: (paths: string[]) => void, status: (text: string) => void }} editor
 */
export function renameProvider(monaco, { symbols, openModel, readVersion, readFile, writeFile, disposePreviews, status }) {
  const { renameTarget, projectContents, symbolOccurrences } = symbols;

  /** Edits of a rename, by file: Map<path, { line, start, end, text }[]>. */
  async function renameEdits(target, newName) {
    if (target.kind === 'keyword') {
      const existing = findKeywords(newName).filter((kw) => kw !== target.keyword && kw.user);
      if (existing.length && normalizeKeyword(newName) !== normalizeKeyword(target.keyword.name))
        throw new Error(`A keyword named '${existing[0].name}' already exists in ${existing[0].source}.`);
    }
    const occurrences = await symbolOccurrences(target, await projectContents());
    // `$name` in Python expressions must stay an identifier.
    const text = (o) => (o.expression ? newName.replace(/ /g, '_') : newName);
    return new Map([...occurrences].map(([path, list]) => [path, list.map((o) => ({ ...o, text: text(o) }))]));
  }

  /**
   * Applies a rename: workspace edits for open files (returned), files written to disk for the
   * others. Every closed file is read before any is written, and a failed write puts back the
   * files already written, so a rename never applies to part of the project.
   */
  async function applyRename(edits) {
    const workspace = [];
    const closed = [];
    for (const [path, list] of edits) {
      const open = openModel(path);
      if (open) {
        // The version the edits were computed from: Monaco refuses them if the user typed since.
        const versionId = readVersion(path) ?? open.getVersionId();
        for (const edit of list) {
          workspace.push({
            resource: open.uri,
            versionId,
            textEdit: { range: new monaco.Range(edit.line, edit.start + 1, edit.line, edit.end + 1), text: edit.text },
          });
        }
        continue;
      }
      const file = await readFile(path);
      if (file.content === null)
        throw new Error(`${path}: ${file.reason}`);
      const eol = file.content.includes('\r\n') ? '\r\n' : '\n';
      closed.push({ path, before: file.content, revision: file.revision, content: applyEdits(file.content.split(/\r?\n/), list).join(eol) });
    }
    const written = [];
    try {
      for (const file of closed) {
        const saved = await writeFile(file.path, file.content, file.revision);
        if (!saved.ok)
          throw new Error(`${file.path} changed on disk. Reload the file and try renaming again.`);
        written.push({ ...file, revision: saved.revision });
      }
    } catch (error) {
      for (const file of written.reverse())
        await writeFile(file.path, file.before, file.revision).catch(() => {});
      throw new Error(`${error.message} No file was changed.`);
    }
    disposePreviews(closed.map((file) => file.path));
    return { workspace, written: written.length };
  }

  return {
    async resolveRenameLocation(model, position) {
      const target = await renameTarget(model, position);
      if (!target)
        return { rejectReason: 'Only keywords and variables can be renamed.' };
      if (target.reject)
        return { rejectReason: target.reject };
      return { range: target.range, text: target.text };
    },
    async provideRenameEdits(model, position, newName) {
      const target = await renameTarget(model, position);
      if (!target || target.reject)
        return { edits: [], rejectReason: target ? target.reject : 'Only keywords and variables can be renamed.' };
      const invalid = invalidName(newName, target.kind);
      if (invalid)
        return { edits: [], rejectReason: invalid };
      if (newName === target.text)
        return { edits: [] };
      try {
        const edits = await renameEdits(target, newName);
        const { workspace, written } = await applyRename(edits);
        const count = [...edits.values()].reduce((sum, list) => sum + list.length, 0);
        const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
        let text = `Renamed '${target.text}' to '${newName}': ${plural(count, 'occurrence')} in ${plural(edits.size, 'file')}`;
        if (written)
          text += `, ${written} saved`;
        if (workspace.length)
          text += '; open files have unsaved changes';
        status(text);
        return { edits: workspace };
      } catch (error) {
        return { edits: [], rejectReason: error.message };
      }
    },
  };
}

export function registerRenameProvider(monaco, language, editor) {
  return monaco.languages.registerRenameProvider(language, renameProvider(monaco, editor));
}
