'use strict';

// Minimal Robot Framework syntax highlighter for the generated code view.
// Returns a list of DOM nodes (one <div class="line"> per source line).
(function () {
  const SEPARATOR = /( {2,}|\t+)/;
  const VARIABLE = /(\\?[$@&%]\{[^}]*\}(?:\[[^\]]*\])?=?)/g;
  const OPERATORS = new Set(['==', '!=', '*=', '^=', '$=', '<', '>', '<=', '>=', 'contains', 'not contains', 'matches', 'validate', 'then']);

  function span(cls, text) {
    const el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    return el;
  }

  function appendWithVariables(parent, text, cls) {
    let last = 0;
    for (const match of text.matchAll(VARIABLE)) {
      if (match.index > last)
        parent.append(span(cls, text.slice(last, match.index)));
      const isEscaped = match[0].startsWith('\\');
      parent.append(span(isEscaped ? cls : 'tok-var', match[0]));
      last = match.index + match[0].length;
    }
    if (last < text.length)
      parent.append(span(cls, text.slice(last)));
  }

  function highlightLine(text) {
    const line = document.createElement('div');
    line.className = 'line';
    if (/^\*{3}.*\*{3}\s*$/.test(text)) {
      line.append(span('tok-section', text));
      return line;
    }
    if (/^\s*#/.test(text)) {
      line.append(span('tok-comment', text));
      return line;
    }
    if (text !== '' && !/^\s/.test(text)) {
      // Test case name or a setting in the first column.
      const [head, ...rest] = text.split(SEPARATOR);
      line.append(span('tok-name', head));
      rest.forEach((cell) => appendWithVariables(line, cell, 'tok-arg'));
      return line;
    }
    const cells = text.split(SEPARATOR);
    let keywordSeen = false;
    for (const cell of cells) {
      if (cell === '' || SEPARATOR.test(cell)) {
        line.append(cell);
      } else if (!keywordSeen && /^[$@&]\{.*\}=?$/.test(cell)) {
        line.append(span('tok-var', cell));
      } else if (!keywordSeen) {
        keywordSeen = true;
        line.append(span('tok-keyword', cell));
      } else if (OPERATORS.has(cell)) {
        line.append(span('tok-operator', cell));
      } else {
        const named = /^([A-Za-z_]\w*)(=)(.*)$/.exec(cell);
        if (named) {
          line.append(span('tok-param', named[1] + named[2]));
          appendWithVariables(line, named[3], 'tok-arg');
        } else {
          appendWithVariables(line, cell, 'tok-arg');
        }
      }
    }
    return line;
  }

  window.highlightRobot = function highlightRobot(source) {
    const lines = source.replace(/\n$/, '').split('\n');
    return lines.map(highlightLine);
  };
})();
