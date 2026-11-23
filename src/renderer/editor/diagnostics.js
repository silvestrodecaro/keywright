// Diagnostics: Robot's parser (via the Python helper), unknown keywords and arguments,
// undefined variables and Robocop lint, as Monaco markers per source.
// Monaco and the project access are passed in, so Node tests run the checks with stubs.
import { analyzeLine } from './robotSyntax.js';
import { collectCalls, checkCall } from './argumentCheck.js';
import { parseFile, importCandidates, variableFileDefinitions, isDynamicVariableFile, unresolvedVariables } from './navigation.js';
import { catalogComplete, keywordsCalled } from './keywordCatalog.js';

/** Whether the file uses test templates, where a test row's first cell is data, not a keyword. */
export function usesTemplate(lines) {
  let section = 'none';
  return lines.some((line) => {
    const result = analyzeLine(line, section);
    section = result.section;
    const first = result.cells.find((cell) => cell.text && cell.type !== 'comment');
    if (!first)
      return false;
    return (section === 'settings' && /^(?:test|task) template$/i.test(first.text))
      || (section === 'tests' && /^\[template\]$/i.test(first.text));
  });
}

/**
 * @param {{ language: string, firstExisting: (paths) => Promise<{ path, lines }|null>,
 *   projectVariables: () => Promise<object>, checkFile: (path, text) => Promise<object>,
 *   lintFile: (path, text) => Promise<object>, onLintUnavailable: () => void }} project
 */
export function createDiagnostics(monaco, { language, firstExisting, projectVariables: readProjectVariables, checkFile, lintFile, onLintUnavailable }) {
  /** Unknown keywords (warnings) and invalid arguments (errors), checked against the keyword index. */
  function keywordMarkers(model) {
    const text = model.getValue();
    // With templates the first cell of a test row is data, not a keyword.
    if (!catalogComplete() || usesTemplate(model.getLinesContent()))
      return [];
    const marker = (severity, message, cell) => ({
      severity,
      message,
      startLineNumber: cell.line,
      startColumn: cell.start + 1,
      endLineNumber: cell.line,
      endColumn: cell.start + cell.text.length + 1,
      source: 'keywords',
    });
    const markers = [];
    for (const call of collectCalls(text.split(/\r?\n/))) {
      const name = call.keyword.text;
      if (/^[$@&%]\{/.test(name) || name.toUpperCase() === 'NONE')
        continue;
      const found = keywordsCalled(name);
      if (!found.length) {
        markers.push(marker(monaco.MarkerSeverity.Warning, `No keyword with name '${name}' found.`, call.keyword));
        continue;
      }
      // Ambiguous names and embedded arguments: the signature to check is not certain.
      if (found.length > 1 || found[0].name.includes('${'))
        continue;
      for (const problem of checkCall(call, found[0]))
        markers.push(marker(monaco.MarkerSeverity.Error, problem.message, problem.cell));
    }
    return markers;
  }

  // Variables known across the project (see src/main/projectVariables.js), reloaded after file changes.
  let projectVariablesPromise = null;

  function projectVariables() {
    if (!projectVariablesPromise) {
      projectVariablesPromise = readProjectVariables()
        .then((r) => ({ runtime: new Set(r.runtime), suite: new Set(r.suite), dynamicSuite: r.dynamicSuite }))
        .catch(() => null);
    }
    return projectVariablesPromise;
  }

  /**
   * Variables defined by the resource and variable files a file imports (recursively).
   * `unknown`: some import cannot be read statically (missing file, path with variables,
   * module name, get_variables()), so undefined variables cannot be told apart.
   */
  async function importedVariables(path, lines) {
    const keys = new Set();
    const names = []; // as written in their definitions, for suggestions
    let unknown = false;
    const seen = new Set([path]);
    const queue = parseFile(lines).imports.filter((i) => i.type !== 'library').map((i) => ({ from: path, item: i }));
    while (queue.length) {
      const { from, item } = queue.shift();
      const target = await firstExisting(importCandidates(from, item.path));
      if (!target) {
        unknown = true;
        continue;
      }
      if (seen.has(target.path))
        continue;
      seen.add(target.path);
      if (item.type === 'variables') {
        if (isDynamicVariableFile(target.path, target.lines))
          unknown = true;
        else
          variableFileDefinitions(target.path, target.lines).forEach((d) => {
            keys.add(d.key);
            names.push('${' + d.name + '}');
          });
        continue;
      }
      const imported = parseFile(target.lines);
      for (const d of [...imported.variables, ...imported.locals.filter((l) => l.fileWide)]) {
        keys.add(d.key);
        names.push(d.name);
      }
      queue.push(...imported.imports.filter((i) => i.type !== 'library').map((i) => ({ from: target.path, item: i })));
    }
    return { keys, names, unknown };
  }

  /** Warnings for variables defined neither in the file, its imports nor (at run time) elsewhere in the project. */
  async function variableMarkers(model, path) {
    const lines = model.getLinesContent();
    const unresolved = unresolvedVariables(lines);
    if (!unresolved.length)
      return [];
    const [imported, project] = await Promise.all([importedVariables(path, lines), projectVariables()]);
    const resource = /\.resource$/i.test(path);
    if (imported.unknown || !project || (resource && project.dynamicSuite))
      return [];
    const known = (key) => imported.keys.has(key) || project.runtime.has(key) || (resource && project.suite.has(key));
    return unresolved.filter((u) => !u.keys.some(known)).map((u) => ({
      severity: monaco.MarkerSeverity.Warning,
      message: `Variable '${u.name}' is not defined in this file${resource ? ', its imports or the project\'s suites' : ' or its imports'}.`,
      startLineNumber: u.line,
      startColumn: u.start + 1,
      endLineNumber: u.line,
      endColumn: u.end + 1,
      source: 'variables',
    }));
  }

  // Robocop lint (style and quality rules, configured by the project's robocop.toml):
  // errors become warnings, warnings and infos become infos, so they never look like Robot errors.
  let lintEnabled = true;
  let lintUnavailableNotified = false;

  async function lintMarkers(path, text) {
    if (!lintEnabled)
      return [];
    const result = await lintFile(path, text);
    if (!result.available) {
      if (!lintUnavailableNotified) {
        lintUnavailableNotified = true;
        onLintUnavailable();
      }
      return [];
    }
    lintUnavailableNotified = false;
    return result.problems.map((problem) => ({
      severity: problem.severity === 'E' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
      message: problem.message,
      code: `${problem.rule} ${problem.name}`,
      startLineNumber: problem.line,
      startColumn: problem.column,
      endLineNumber: problem.endLine,
      endColumn: Math.max(problem.endColumn, problem.column + 1),
      source: 'robocop',
    }));
  }

  async function validate(model, path) {
    if (model.isDisposed() || model.getLanguageId() !== language)
      return;
    monaco.editor.setModelMarkers(model, 'keywords', keywordMarkers(model));
    const version = model.getVersionId();
    const text = model.getValue();
    const failed = (error) => ({ ok: false, problems: [], error: error?.message || String(error) });
    const [result, variables, lint] = await Promise.all([
      checkFile(path, text).catch(failed),
      variableMarkers(model, path).catch(() => []),
      lintMarkers(path, text).catch(() => []),
    ]);
    if (model.isDisposed() || model.getVersionId() !== version)
      return; // edited meanwhile: a newer check is scheduled
    monaco.editor.setModelMarkers(model, 'variables', variables);
    monaco.editor.setModelMarkers(model, 'robocop', lint);
    // No error: no Python to check with, which the project already reports elsewhere.
    monaco.editor.setModelMarkers(model, 'robot', result?.ok === false && result.error ? checkUnavailable(result.error) : robotMarkers(result));
  }

  /** A check that could not run (no Python, a broken environment) says so instead of finding nothing. */
  function checkUnavailable(error) {
    const reason = String(error || 'The Python helper did not answer.').split('\n').slice(0, 4).join('\n');
    return [{
      severity: monaco.MarkerSeverity.Info,
      message: `Keywright could not check this file with Robot Framework: ${reason}`,
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
      source: 'Keywright',
    }];
  }

  /** Parser problems from the Python helper (editor:check) as markers. */
  function robotMarkers(result) {
    return result.problems.map((problem) => ({
      severity: problem.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
      message: problem.message,
      startLineNumber: problem.line,
      startColumn: problem.column,
      endLineNumber: problem.endLine,
      endColumn: problem.endColumn,
      source: 'Robot Framework',
    }));
  }

  /** All the editor's checks on the content of a file that is not open (no model needed). */
  async function fileMarkers(path, text) {
    const lines = text.split(/\r?\n/);
    const document = { getValue: () => text, getLinesContent: () => lines };
    const [result, variables, lint] = await Promise.all([
      checkFile(path, text),
      variableMarkers(document, path).catch(() => []),
      lintMarkers(path, text).catch(() => []),
    ]);
    return [...robotMarkers(result), ...keywordMarkers(document), ...variables, ...lint];
  }

  function toProblem(marker) {
    return {
      severity: marker.severity === monaco.MarkerSeverity.Error ? 'error'
        : marker.severity === monaco.MarkerSeverity.Warning ? 'warning' : 'info',
      message: marker.message,
      line: marker.startLineNumber,
      column: marker.startColumn,
      source: marker.source,
      code: marker.code ? String(marker.code) : undefined,
    };
  }

  return {
    keywordMarkers,
    importedVariables,
    validate,
    fileMarkers,
    toProblem,
    /** Project variables are read again at the next check (after file changes). */
    resetProjectVariables() {
      projectVariablesPromise = null;
    },
    /** Turns Robocop lint on or off; an unavailable Robocop is reported again. */
    setLintEnabled(enabled) {
      lintEnabled = enabled;
      lintUnavailableNotified = false;
    },
  };
}
