'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// banner.txt is pixel art shared with setup.ps1: one character per pixel
// (. empty, t teal, d dark, w light) in a [symbol] and a [wordmark] section.
// Two pixel rows make one line of half blocks, which Lucida Console also has.
const PALETTE = {
  t: { rgb: '0;176;160', fg: '96', bg: '106' },
  d: { rgb: '36;44;52', fg: '30', bg: '40' },
  w: { rgb: '221;252;247', fg: '97', bg: '107' },
};

function readBanner(file = path.join(__dirname, 'banner.txt')) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const sections = {};
  let current;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[(\w+)\]$/.exec(line);
    if (header) sections[current = header[1]] = [];
    else if (current) sections[current].push(line);
  }
  const valid = (rows) => rows?.length && rows.every((row) => row.length === rows[0].length && /^[.tdw]+$/.test(row));
  return valid(sections.symbol) && valid(sections.wordmark) ? { symbol: sections.symbol, wordmark: sections.wordmark } : null;
}

// Without colour, the pixels in `plain` are left out: the symbol drops its dark fill and
// the wordmark its shadow, so outlines, eyes and letters stay readable.
function drawPixels(rows, { color = false, truecolor = false, plain = 'd' } = {}) {
  const sgr = (fg, bg) => {
    if (!color) return '';
    const codes = [];
    if (fg) codes.push(truecolor ? `38;2;${PALETTE[fg].rgb}` : PALETTE[fg].fg);
    if (bg) codes.push(truecolor ? `48;2;${PALETTE[bg].rgb}` : PALETTE[bg].bg);
    return codes.length ? `\x1b[${codes.join(';')}m` : '';
  };
  const visible = (pixel) => pixel && pixel !== '.' && (color || !plain.includes(pixel)) ? pixel : '';
  const lines = [];
  for (let y = 0; y < rows.length; y += 2) {
    let text = '';
    let style = '';
    for (let x = 0; x < rows[y].length; x++) {
      const top = visible(rows[y][x]);
      const bottom = visible(rows[y + 1]?.[x]);
      let glyph = ' ', fg = '', bg = '';
      if (top && bottom && top === bottom) [glyph, fg] = ['█', top];
      else if (top && bottom) [glyph, fg, bg] = ['▀', top, bottom];
      else if (top) [glyph, fg] = ['▀', top];
      else if (bottom) [glyph, fg] = ['▄', bottom];
      const next = sgr(fg, bg);
      if (next !== style) { text += (style ? '\x1b[0m' : '') + next; style = next; }
      text += glyph;
    }
    lines.push(text + (style ? '\x1b[0m' : ''));
  }
  return lines;
}

// The Windows console has handled 24-bit colour since Windows 10 build 14931.
function supportsTruecolor(env, platform = process.platform, release = os.release()) {
  if (/truecolor|24bit/i.test(env.COLORTERM || '') || env.WT_SESSION) return true;
  return platform === 'win32' && Number(release.split('.')[2]) >= 14931;
}

function terminal(output = process.stdout, env = process.env, { truecolor = supportsTruecolor(env) } = {}) {
  const interactive = Boolean(output.isTTY) && env.TERM !== 'dumb' && !env.CI;
  const color = interactive && !Object.hasOwn(env, 'NO_COLOR');
  const paint = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const line = (text = '') => output.write(text + '\n');
  const label = (status, text, code = '36') => line(`  ${paint(code, status.padEnd(6))} ${text}`);
  return {
    line,
    label,
    heading: (text) => line(`\n  ${paint('1', text)}\n`),
    // The full banner needs an interactive terminal wide enough for symbol and wordmark;
    // logs, CI and narrow windows get the plain title.
    banner(version, mode, art = readBanner()) {
      const gap = 4;
      const required = art ? 2 + art.symbol[0].length + gap + art.wordmark[0].length : Infinity;
      line();
      if (!interactive || (output.columns || 0) < required) {
        line(`  ${paint('1', 'KEYWRIGHT')}  ${paint('90', version)}`);
        line(`  Record, edit and run Robot Framework web tests  ${paint('90', '·  ' + mode)}`);
        line();
        return;
      }
      const options = { color, truecolor };
      const symbol = drawPixels(art.symbol, options);
      const right = [
        ...drawPixels(art.wordmark, { ...options, plain: 't' }),
        `  Record, edit and run Robot Framework web tests`,
        `  ${paint('90', `${version}  ·  ${mode}`)}`,
      ];
      const top = Math.max(0, Math.floor((symbol.length - right.length) / 2));
      for (let index = 0; index < Math.max(symbol.length, top + right.length); index++) {
        const left = symbol[index] ?? ' '.repeat(art.symbol[0].length);
        const text = right[index - top];
        line(`  ${left}${text === undefined ? '' : ' '.repeat(gap) + text}`.trimEnd());
      }
      line();
    },
    async task(title, work, { background = false } = {}) {
      const start = Date.now();
      let frame = 0;
      let timer;
      const elapsed = () => ((Date.now() - start) / 1000).toFixed(1) + 's';
      const redraw = () => {
        const width = Math.max(12, (output.columns || 80) - 22);
        const text = title.length > width ? title.slice(0, width - 3) + '...' : title;
        output.write(`\r\x1b[2K  ${paint('36', '|/-\\'[frame++ % 4])}      ${text}  ${paint('90', elapsed())}`);
      };
      const clear = () => { clearInterval(timer); if (interactive) output.write('\r\x1b[2K'); };
      if (background) label('OPEN', title);
      else if (interactive) { redraw(); timer = setInterval(redraw, 120); timer.unref(); }
      else label('RUN', title);
      try {
        const result = await work();
        clear();
        label(background ? 'CLOSED' : 'OK', `${title}  ${elapsed()}`, '32');
        return result;
      } catch (error) {
        clear();
        label(error.name === 'AbortError' ? 'STOPPED' : 'FAILED', `${title}  ${elapsed()}`, error.name === 'AbortError' ? '90' : '31');
        throw error;
      }
    },
  };
}

module.exports = { terminal, readBanner, drawPixels, supportsTruecolor };
