// Quick fixes (Ctrl+.): similar names, create keyword, define variable, disable a Robocop rule,
// add END; and the command that adds a keyword to a file. Monaco and the editor/project access
// are passed in, so Node tests run them with stubs.
import { normalizeKeyword } from './robotSyntax.js';
import { parseFile, importCandidates, normalizeVariable } from './navigation.js';
import { similarNames, keywordStub, keywordInsertion, variableInsertion, endInsertion, applyInsertion, callArguments } from './quickFix.js';
import { allKeywords } from './keywordCatalog.js';

/**
 * @param {{ modelPath, firstExisting, importedVariables, openModel, previewModel, readFile, writeFile,
 *   reveal: (detail: { path, line, column }) => void, status: (text: string) => void }} deps
 */
function createCodeActions(monaco, { modelPath, firstExisting, importedVariables, openModel, previewModel, readFile, writeFile, reveal, status }) {
  /** A Monaco text edit inserting `insertion` ({ afterLine, lines }) into a model. */
  function insertionEdit(model, insertion) {
    const lineCount = model.getLineCount();
    if (insertion.afterLine >= lineCount) {
      const column = model.getLineMaxColumn(lineCount);
      return { range: new monaco.Range(lineCount, column, lineCount, column), text: '\n' + insertion.lines.join('\n') };
    }
    const line = insertion.afterLine + 1;
    return { range: new monaco.Range(line, 1, line, 1), text: insertion.lines.join('\n') + '\n' };
  }

  function quickFix(title, model, marker, edits, preferred = false) {
    return {
      title,
      kind: 'quickfix',
      diagnostics: [marker],
      isPreferred: preferred,
      edit: { edits: edits.map((textEdit) => ({ resource: model.uri, versionId: model.getVersionId(), textEdit })) },
    };
  }

  // Adds a keyword to a file (open: as an unsaved edit; closed: saved), then shows it.
  async function createKeyword(_accessor, { path, stub }) {
    const model = openModel(path);
    let insertion;
    if (model) {
      insertion = keywordInsertion(model.getLinesContent(), stub);
      model.pushEditOperations([], [insertionEdit(model, insertion)], () => null);
    } else {
      const file = await readFile(path);
      const eol = file.content.includes('\r\n') ? '\r\n' : '\n';
      const lines = file.content.split(/\r?\n/);
      insertion = keywordInsertion(lines, stub);
      const content = applyInsertion(lines, insertion).join(eol);
      const saved = await writeFile(path, content, file.revision);
      if (!saved.ok)
        throw new Error(`${path} changed on disk. Reload the file and create the keyword again.`);
      previewModel(path)?.setValue(content); // definition preview
    }
    reveal({ path, line: insertion.keywordLine + stub.length - 1, column: 5 });
    status(`Created keyword '${stub[0]}' in ${path}`);
  }

  const BDD = /^(given|when|then|and|but)\s+/i;

  async function keywordFixes(model, marker, name) {
    const actions = [];
    const path = modelPath(model);
    const lines = model.getLinesContent();
    const bdd = BDD.exec(name)?.[0] || '';
    const base = name.slice(bdd.length);
    for (const candidate of similarNames(base, [...new Set(allKeywords().map((kw) => kw.name))].filter((n) => !n.includes('${')), normalizeKeyword)) {
      actions.push(quickFix(`Change to '${candidate}'`, model, marker,
        [{ range: new monaco.Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn), text: bdd + candidate }],
        actions.length === 0));
    }
    const stub = keywordStub(base, callArguments(lines, marker.startLineNumber, marker.startColumn - 1));
    const create = (target, title) => ({ title, kind: 'quickfix', diagnostics: [marker],
      command: { id: 'keywright.createKeyword', title, arguments: [{ path: target, stub }] } });
    actions.push(create(path, `Create keyword '${base}' in this file`));
    // Resource files the file imports: the new keyword is found there too.
    for (const item of parseFile(lines).imports.filter((i) => i.type === 'resource')) {
      const target = await firstExisting(importCandidates(path, item.path));
      if (target && /\.resource$/i.test(target.path))
        actions.push(create(target.path, `Create keyword '${base}' in ${target.path}`));
    }
    return actions;
  }

  async function variableFixes(model, marker, name) {
    const actions = [];
    const path = modelPath(model);
    const lines = model.getLinesContent();
    const line = marker.startLineNumber;
    const parsed = parseFile(lines);
    const block = parsed.blocks.find((b) => b.line <= line && line <= b.end);
    const visible = [...parsed.variables, ...parsed.locals.filter((d) => d.fileWide || (block && d.block === block))].map((d) => d.name);
    const imported = await importedVariables(path, lines);
    const inner = (variable) => variable.slice(2, -1);
    const range = new monaco.Range(line, marker.startColumn + 2, line, marker.endColumn - 1); // the name inside ${ }
    for (const candidate of similarNames(name, [...visible, ...imported.names], (n) => normalizeVariable(n))) {
      actions.push(quickFix(`Change to ${name[0]}{${inner(candidate)}}`, model, marker, [{ range, text: inner(candidate) }], actions.length === 0));
    }
    const definition = name.startsWith('$') ? `${name}    \${EMPTY}` : name;
    actions.push(quickFix(`Define ${name} in the Variables section`, model, marker, [insertionEdit(model, variableInsertion(lines, definition))]));
    return actions;
  }

  // Robocop rules can be disabled with comments: `# robocop: off=rule` at the end of a line, or
  // before the first section for the whole file. Rules are added to an existing disabler.
  const ROBOCOP_DISABLER = /# robocop: off=[\w-]+(?:, ?[\w-]+)*/;

  function robocopFixes(model, marker, rule) {
    if (!rule)
      return [];
    const disable = (line, title, preferred) => {
      const text = model.getLineContent(line);
      const existing = ROBOCOP_DISABLER.exec(text);
      if (existing) {
        const column = existing.index + existing[0].length + 1;
        return quickFix(title, model, marker, [{ range: new monaco.Range(line, column, line, column), text: `, ${rule}` }], preferred);
      }
      const end = text.trimEnd().length + 1;
      return quickFix(title, model, marker, [{ range: new monaco.Range(line, end, line, text.length + 1), text: `    # robocop: off=${rule}` }], preferred);
    };
    const actions = [disable(marker.startLineNumber, `Disable ${rule} on this line`, false)];
    if (ROBOCOP_DISABLER.test(model.getLineContent(1)) && /^#/.test(model.getLineContent(1)))
      actions.push(disable(1, `Disable ${rule} in this file`, false));
    else
      actions.push(quickFix(`Disable ${rule} in this file`, model, marker, [insertionEdit(model, { afterLine: 0, lines: [`# robocop: off=${rule}`] })]));
    return actions;
  }

  const provider = {
    async provideCodeActions(model, _range, context) {
      const actions = [];
      for (const marker of context.markers) {
        const keyword = /^No keyword with name '(.+)' found\.$/.exec(marker.message);
        const variable = /^Variable '([$@&]\{.+?\})' is not defined/.exec(marker.message);
        if (keyword)
          actions.push(...await keywordFixes(model, marker, keyword[1]));
        else if (variable)
          actions.push(...await variableFixes(model, marker, variable[1]));
        else if (marker.source === 'robocop' && marker.code)
          actions.push(...robocopFixes(model, marker, String(marker.code).split(' ')[1]));
        else if (/must have closing END/.test(marker.message))
          actions.push(quickFix('Add END', model, marker, [insertionEdit(model, endInsertion(model.getLinesContent(), marker.startLineNumber))], true));
      }
      return { actions, dispose() {} };
    },
  };

  return { provider, createKeyword };
}

export function codeActionProvider(monaco, deps) {
  return createCodeActions(monaco, deps).provider;
}

/** The `keywright.createKeyword` command: open files get an unsaved edit, closed files are saved. */
export function createKeywordCommand(monaco, deps) {
  return createCodeActions(monaco, deps).createKeyword;
}

/** Registers the command, then the code action provider that refers to it. */
export function registerQuickFixes(monaco, language, deps) {
  const { provider, createKeyword } = createCodeActions(monaco, deps);
  monaco.editor.registerCommand('keywright.createKeyword', createKeyword);
  monaco.languages.registerCodeActionProvider(language, provider, { providedCodeActionKinds: ['quickfix'] });
}
