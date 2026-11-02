'use strict';

function terminal(output = process.stdout, env = process.env) {
  const interactive = Boolean(output.isTTY) && env.TERM !== 'dumb' && !env.CI;
  const color = interactive && !Object.hasOwn(env, 'NO_COLOR');
  const paint = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const line = (text = '') => output.write(text + '\n');
  const label = (status, text, code = '36') => line(`  ${paint(code, status.padEnd(6))} ${text}`);
  return {
    line,
    label,
    heading: (text) => line(`\n  ${paint('1', text)}\n`),
    banner(version, mode) {
      line();
      line(`  ${paint('36', '| /')}   ${paint('1', 'KEYWRIGHT')}  ${paint('90', version)}`);
      line(`  ${paint('36', '|< ')}   Robot Framework + Browser`);
      line(`  ${paint('36', '| \\')}   ${paint('90', mode)}`);
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

module.exports = { terminal };
