'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { terminal, readBanner, drawPixels, supportsTruecolor } = require('../scripts/terminal');
const { tempDir } = require('./helpers/tempDir');

const art = readBanner();

function capture({ isTTY = false, columns } = {}) {
  const output = new PassThrough();
  output.isTTY = isTTY;
  output.columns = columns;
  let text = '';
  output.on('data', (chunk) => { text += chunk; });
  return { output, text: () => text };
}

test('the shared banner file holds a symbol and a wordmark of consistent pixel rows', () => {
  assert.ok(art, 'scripts/banner.txt is missing or malformed');
  for (const rows of [art.symbol, art.wordmark]) {
    assert.equal(rows.length % 2, 0, 'two pixel rows make one terminal line');
    assert.ok(rows.every((row) => row.length === rows[0].length && /^[.tdw]+$/.test(row)));
  }
  // Symbol, gap and wordmark fit a default 120-column Windows console.
  assert.ok(2 + art.symbol[0].length + 4 + art.wordmark[0].length <= 120);
});

test('pixel pairs become half blocks with foreground and background colours', () => {
  const rows = ['.tw.d', '..ww.'];
  // Without colour the dark pixel is left out.
  assert.deepEqual(drawPixels(rows, { color: false }), [' ▀█▄ ']);
  assert.deepEqual(drawPixels(rows, { color: true, truecolor: true }), [
    ' \x1b[38;2;0;176;160m▀\x1b[0m\x1b[38;2;221;252;247m█▄\x1b[0m\x1b[38;2;36;44;52m▀\x1b[0m',
  ]);
  assert.deepEqual(drawPixels(['tw', 'wt'], { color: true }), ['\x1b[96;107m▀\x1b[0m\x1b[97;106m▀\x1b[0m']);
  assert.deepEqual(drawPixels(['t.', 'w.'], { color: false, plain: 't' }), ['▄ ']);
});

test('a wide interactive terminal shows the full banner with the title beside the wordmark', () => {
  const out = capture({ isTTY: true, columns: 120 });
  terminal(out.output, { NO_COLOR: '' }).banner('1.2.3', 'Start');
  const lines = out.text().split('\n');
  const symbol = drawPixels(art.symbol);
  assert.ok(lines.some((line) => line.startsWith('  ' + symbol[7].trimEnd())), out.text());
  assert.ok(lines.some((line) => /^ {2}\S.* {6}Record, edit and run Robot Framework web tests$/.test(line)), out.text());
  assert.ok(lines.some((line) => /1\.2\.3 {2}· {2}Start$/.test(line)), out.text());
  assert.doesNotMatch(out.text(), /\x1b\[/);
});

test('the banner uses the brand teal with truecolor and bright cyan otherwise', () => {
  const rich = capture({ isTTY: true, columns: 120 });
  terminal(rich.output, {}, { truecolor: true }).banner('1.2.3', 'Start');
  assert.match(rich.text(), /\x1b\[38;2;0;176;160m/);
  assert.match(rich.text(), /\x1b\[38;2;221;252;247m/);

  const basic = capture({ isTTY: true, columns: 120 });
  terminal(basic.output, {}, { truecolor: false }).banner('1.2.3', 'Start');
  assert.match(basic.text(), /\x1b\[96m/);
  assert.doesNotMatch(basic.text(), /38;2;/);
});

test('logs, CI and narrow windows get the plain title', () => {
  for (const [options, env] of [[{ isTTY: false, columns: 200 }, {}], [{ isTTY: true, columns: 200 }, { CI: 'true' }], [{ isTTY: true, columns: 80 }, {}]]) {
    const out = capture(options);
    terminal(out.output, env).banner('1.2.3', 'Start');
    assert.equal(out.text().replace(/\x1b\[[0-9;]*m/g, ''), '\n  KEYWRIGHT  1.2.3\n  Record, edit and run Robot Framework web tests  ·  Start\n\n');
  }
});

test('a missing or malformed banner file falls back to the plain title', () => {
  const dir = tempDir('banner');
  const file = path.join(dir, 'banner.txt');
  fs.writeFileSync(file, '# comment\r\n[symbol]\r\ntt..\r\nt\r\n[wordmark]\r\nww\r\nww\r\n');
  assert.equal(readBanner(file), null);
  assert.equal(readBanner(path.join(dir, 'missing.txt')), null);
  fs.writeFileSync(file, '# comment\r\n[symbol]\r\ntd\r\nw.\r\n\r\n[wordmark]\r\nww\r\n..\r\n');
  assert.deepEqual(readBanner(file), { symbol: ['td', 'w.'], wordmark: ['ww', '..'] });

  const out = capture({ isTTY: true, columns: 200 });
  terminal(out.output, { NO_COLOR: '' }).banner('1.2.3', 'Start', null);
  assert.match(out.text(), /^\n {2}KEYWRIGHT {2}1\.2\.3\n/);
});

test('truecolor is detected from the terminal or the Windows console build', () => {
  assert.equal(supportsTruecolor({ COLORTERM: 'truecolor' }, 'linux', '6.0.0'), true);
  assert.equal(supportsTruecolor({ WT_SESSION: 'x' }, 'linux', '6.0.0'), true);
  assert.equal(supportsTruecolor({}, 'win32', '10.0.26300'), true);
  assert.equal(supportsTruecolor({}, 'win32', '10.0.14393'), false);
  assert.equal(supportsTruecolor({}, 'linux', '6.0.0'), false);
});

test('setup.ps1 draws the same banner as the Node renderer', { skip: process.platform !== 'win32' }, () => {
  const script = path.join(__dirname, '..', 'scripts', 'setup.ps1');
  // Load only the function definitions, then draw both parts without colour.
  const command = [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile('${script.replace(/'/g, "''")}', [ref]$null, [ref]$null)`,
    '$ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false) | ForEach-Object { . ([scriptblock]::Create($_.Extent.Text)) }',
    `$art = Read-Banner '${path.join(path.dirname(script), 'banner.txt').replace(/'/g, "''")}'`,
    'foreach ($part in @(@($art.symbol, "d"), @($art.wordmark, "t"))) { foreach ($line in (Get-BannerLines $part[0] $part[1] $false)) { ($line | ForEach-Object { $_.Text }) -join "" } }',
  ].join('; ');
  const result = spawnSync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const expected = [...drawPixels(art.symbol), ...drawPixels(art.wordmark, { plain: 't' })];
  assert.deepEqual(result.stdout.split(/\r?\n/).slice(0, expected.length), expected);
});
