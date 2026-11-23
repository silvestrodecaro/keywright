// Go to Definition (keywords, imported files, variables), the outline and Find All References.
// Monaco and the project lookups are passed in, so Node tests run the providers with stubs.
import { parseFile, variableAt, isBuiltinVariable, importCandidates, outline } from './navigation.js';
import { findKeywords } from './keywordCatalog.js';
import { keywordCellAt } from './modelCells.js';

/** The keyword definition provider, then the import and variable one: Monaco merges them in this order. */
export function definitionProviders(monaco, { modelPath, ensureModel, uriFor, firstExisting, resolveVariable }) {
  const keyword = {
    async provideDefinition(model, position) {
      const cell = keywordCellAt(model, position);
      if (!cell)
        return null;
      const targets = findKeywords(cell.text).filter((kw) => kw.user && kw.source);
      for (const source of new Set(targets.map((kw) => kw.source)))
        await ensureModel(source);
      return targets.map((kw) => ({ uri: uriFor(kw.source), range: new monaco.Range(kw.lineno, 1, kw.lineno, 1) }));
    },
  };

  // Ctrl+click / F12 on an imported file or on a variable.
  const importOrVariable = {
    async provideDefinition(model, position) {
      const path = modelPath(model);
      const lines = model.getLinesContent();
      const line = position.lineNumber;
      const offset = position.column - 1;
      const item = parseFile(lines).imports.find((i) => i.line === line && i.start <= offset && offset <= i.end);
      if (item) {
        const target = await firstExisting(importCandidates(path, item.path));
        if (!target)
          return null;
        await ensureModel(target.path);
        return [{
          uri: uriFor(target.path),
          range: new monaco.Range(1, 1, 1, 1),
          originSelectionRange: new monaco.Range(line, item.start + 1, line, item.end + 1),
        }];
      }
      const variable = variableAt(lines[line - 1], offset);
      if (!variable || variable.name.startsWith('%') || isBuiltinVariable(variable.name))
        return null;
      const found = await resolveVariable(path, lines, variable.name, line);
      if (!found)
        return null;
      await ensureModel(found.path);
      const d = found.definition;
      return [{
        uri: uriFor(found.path),
        range: new monaco.Range(d.line, d.start + 1, d.line, d.end + 1),
        originSelectionRange: new monaco.Range(line, variable.start + 1, line, variable.end + 1),
      }];
    },
  };

  return [keyword, importOrVariable];
}

/** The outline (Ctrl+Shift+O). */
export function documentSymbolProvider(monaco) {
  return {
    displayName: 'Robot Framework',
    provideDocumentSymbols(model) {
      const { SymbolKind } = monaco.languages;
      const kinds = { section: SymbolKind.Namespace, test: SymbolKind.Method, keyword: SymbolKind.Function, variable: SymbolKind.Variable,
        resource: SymbolKind.File, variables: SymbolKind.File, library: SymbolKind.Module };
      const symbol = (item) => {
        const end = Math.max(item.end, item.line);
        return {
          name: item.name,
          detail: '',
          kind: kinds[item.kind],
          tags: [],
          range: new monaco.Range(item.line, 1, end, model.getLineMaxColumn(end)),
          selectionRange: new monaco.Range(item.line, 1, item.line, model.getLineMaxColumn(item.line)),
          children: (item.children || []).map(symbol),
        };
      };
      return outline(model.getLinesContent()).map(symbol);
    },
  };
}

/** Shift+F12: references of a keyword (library ones too) or a variable. */
export function referenceProvider(monaco, { ensureModel, uriFor, symbols }) {
  const { renameTarget, projectContents, symbolOccurrences } = symbols;
  return {
    async provideReferences(model, position, context) {
      const target = await renameTarget(model, position);
      if (!target || !target.kind)
        return [];
      const occurrences = await symbolOccurrences(target, await projectContents());
      const isDefinition = (path, o) => (target.kind === 'keyword'
        ? target.keyword.user && path === target.keyword.source && o.line === target.keyword.lineno
        : path === target.definitionPath && o.line === target.definition.line && o.start === target.definition.start + 2);
      const locations = [];
      for (const [path, list] of occurrences) {
        await ensureModel(path); // the peek view shows the lines of every file
        for (const o of list) {
          if (context.includeDeclaration || !isDefinition(path, o))
            locations.push({ uri: uriFor(path), range: new monaco.Range(o.line, o.start + 1, o.line, o.end + 1) });
        }
      }
      // Variable files are not Robot files: add their definition.
      if (context.includeDeclaration && target.kind === 'variable' && target.definition.how === 'variable file') {
        const d = target.definition;
        await ensureModel(target.definitionPath);
        locations.unshift({ uri: uriFor(target.definitionPath), range: new monaco.Range(d.line, d.start + 1, d.line, d.end + 1) });
      }
      return locations;
    },
  };
}

export function registerNavigationProviders(monaco, language, project) {
  for (const provider of definitionProviders(monaco, project))
    monaco.languages.registerDefinitionProvider(language, provider);
  monaco.languages.registerDocumentSymbolProvider(language, documentSymbolProvider(monaco));
  monaco.languages.registerReferenceProvider(language, referenceProvider(monaco, project));
}
