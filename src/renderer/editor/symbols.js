// The keyword or variable under the cursor and its occurrences across the project's files.
// Shared by Find All References and rename; project access is passed in.
import { analyzeLine, normalizeKeyword } from './robotSyntax.js';
import { parseFile, findVariable, variableAt, isBuiltinVariable, importCandidates } from './navigation.js';
import { keywordPart, keywordOccurrences, variablePart, variableOccurrences } from './rename.js';
import { allKeywords, keywordsCalled } from './keywordCatalog.js';
import { sectionAt } from './modelCells.js';

/** The files that import `target` (directly or through other resources), `target` included. */
export function filesImporting(target, contents) {
  const importsOf = new Map([...contents].map(([path, lines]) => [path, parseFile(lines).imports
    .filter((item) => item.type !== 'library')
    .map((item) => importCandidates(path, item.path).find((candidate) => contents.has(candidate) || candidate === target))
    .filter(Boolean)]));
  const reaches = (path, seen = new Set()) => {
    if (path === target)
      return true;
    if (seen.has(path))
      return false;
    seen.add(path);
    return (importsOf.get(path) || []).some((next) => reaches(next, seen));
  };
  return [...contents.keys()].filter((path) => reaches(path));
}

/**
 * @param {{ modelPath: (model) => string, readLines: (path) => Promise<string[]|null>,
 *   resolveVariable: (path, lines, name, line) => Promise<object|null>, projectTree: () => Promise<object[]> }} project
 */
export function createSymbols(monaco, { modelPath, readLines, resolveVariable, projectTree }) {
  async function projectRobotFiles() {
    const flatten = (nodes) => nodes.flatMap((node) => (node.type === 'dir' ? flatten(node.children || [])
      : /\.(robot|resource)$/i.test(node.path) ? [node.path] : []));
    return flatten(await projectTree());
  }

  /** What F2 at `position` renames: { kind, range, text, ... }, { reject } or null. */
  async function renameTarget(model, position) {
    const path = modelPath(model);
    const lines = model.getLinesContent();
    const line = position.lineNumber;
    const offset = position.column - 1;

    const variable = variableAt(lines[line - 1], offset);
    if (variable) {
      if (variable.name.startsWith('%') || isBuiltinVariable(variable.name))
        return { reject: 'Built-in and environment variables cannot be renamed.' };
      const found = await resolveVariable(path, lines, variable.name, line);
      if (!found)
        return { reject: `No definition of ${variable.name} was found in this file or its imports.` };
      const definition = found.definition;
      const part = variablePart(variable.name, definition.key);
      if (!part)
        return { reject: `${variable.name} cannot be renamed here.` };
      return {
        kind: 'variable',
        definition,
        definitionPath: found.path,
        range: new monaco.Range(line, variable.start + part.start + 1, line, variable.start + part.end + 1),
        text: variable.name.slice(part.start, part.end),
        // References are found, but the definition is not in a Robot file.
        reject: definition.how === 'variable file' ? `${variable.name} is defined in the variable file ${found.path}: rename it there.` : undefined,
      };
    }

    const section = sectionAt(model, line);
    const cell = analyzeLine(lines[line - 1], section).cells.find((c) => (c.type === 'keyword' || (c.type === 'name' && section === 'keywords'))
      && offset >= c.start && offset <= c.start + c.text.length);
    if (!cell)
      return null;
    const candidates = cell.type === 'name'
      ? allKeywords().filter((kw) => kw.user && kw.source === path && normalizeKeyword(kw.name) === normalizeKeyword(cell.text))
      : keywordsCalled(cell.text);
    const userKeywords = candidates.filter((kw) => kw.user && kw.source);
    if (!userKeywords.length) {
      if (candidates.length !== 1 || candidates[0].name.includes('${'))
        return { reject: candidates.length ? `'${cell.text}' matches ${candidates.length} library keywords.` : `No keyword named '${cell.text}' was found.` };
      // A library keyword: its calls can be listed (references), not renamed.
      const part = keywordPart(cell.text, candidates[0]);
      return part && {
        kind: 'keyword',
        keyword: candidates[0],
        range: new monaco.Range(line, cell.start + part.start + 1, line, cell.start + part.end + 1),
        text: cell.text.slice(part.start, part.end),
        reject: `'${cell.text}' comes from the ${candidates[0].library} library: only keywords defined in the project can be renamed.`,
      };
    }
    const keyword = userKeywords[0];
    const sameName = allKeywords().filter((kw) => kw.user && normalizeKeyword(kw.name) === normalizeKeyword(keyword.name));
    if (sameName.length > 1)
      return { reject: `${sameName.length} keywords are named '${keyword.name}' (${sameName.map((kw) => kw.source).join(', ')}): rename is ambiguous.` };
    if (keyword.name.includes('${'))
      return { reject: 'Keywords with embedded arguments cannot be renamed.' };
    const part = cell.type === 'name' ? { start: 0, end: cell.text.length } : keywordPart(cell.text, keyword);
    if (!part)
      return null;
    return {
      kind: 'keyword',
      keyword,
      range: new monaco.Range(line, cell.start + part.start + 1, line, cell.start + part.end + 1),
      text: cell.text.slice(part.start, part.end),
    };
  }

  /** Lines of every .robot/.resource file of the project (open files with their unsaved edits). */
  async function projectContents() {
    const contents = new Map();
    for (const path of await projectRobotFiles()) {
      const lines = await readLines(path);
      if (lines)
        contents.set(path, lines);
    }
    return contents;
  }

  /**
   * Where the keyword or variable of `target` (from renameTarget) occurs, by file:
   * Map<path, { line, start, end, expression? }[]>.
   */
  async function symbolOccurrences(target, contents) {
    const occurrences = new Map();
    const add = (path, list) => {
      if (list.length)
        occurrences.set(path, list);
    };

    if (target.kind === 'keyword') {
      const keyword = target.keyword;
      const scope = !keyword.user ? [...contents.keys()]
        : /\.resource$/i.test(keyword.source) ? filesImporting(keyword.source, contents) : [keyword.source];
      for (const path of scope.filter((p) => contents.has(p)))
        add(path, keywordOccurrences(contents.get(path), keyword, { definition: keyword.user && path === keyword.source }));
      return occurrences;
    }

    const { definition, definitionPath } = target;
    const sameDefinition = (other) => !!other && other.line === definition.line && other.start === definition.start;
    const local = !!definition.block && !definition.fileWide;
    const scope = local ? [definitionPath] : filesImporting(definitionPath, contents);
    for (const path of scope.filter((p) => contents.has(p))) {
      const lines = contents.get(path);
      const parsed = parseFile(lines);
      // Other files see the variable through their imports, unless they define it themselves.
      let imported = false;
      if (path !== definitionPath) {
        const found = await resolveVariable(path, lines, definition.name, 0);
        imported = !!found && found.path === definitionPath && sameDefinition(found.definition);
      }
      const accept = (name, line) => {
        const own = findVariable(parsed, name, line);
        return path === definitionPath ? sameDefinition(own) : !own && imported;
      };
      add(path, variableOccurrences(lines, definition.key, accept));
    }
    return occurrences;
  }

  return { renameTarget, projectContents, symbolOccurrences };
}
