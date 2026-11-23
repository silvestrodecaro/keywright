// Section and cell lookup on a Monaco text model (only getLineContent is used).
import { analyzeLine, sectionOf } from './robotSyntax.js';

export function sectionAt(model, lineNumber) {
  for (let line = lineNumber - 1; line >= 1; line--) {
    const section = sectionOf(model.getLineContent(line));
    if (section)
      return section;
  }
  return 'none';
}

/** The keyword cell under `position`, if any. */
export function keywordCellAt(model, position) {
  const line = model.getLineContent(position.lineNumber);
  const { cells } = analyzeLine(line, sectionAt(model, position.lineNumber));
  const column = position.column - 1;
  return cells.find((cell) => cell.type === 'keyword' && column >= cell.start && column <= cell.start + cell.text.length) || null;
}
