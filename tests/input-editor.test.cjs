const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PassThrough, Writable } = require('node:stream');
const { stripVTControlCharacters } = require('node:util');
const { setImmediate: nextTurn, setTimeout: delay } = require('node:timers/promises');
const blessed = require('blessed');
require('ts-node/register');
const { InputEditor } = require('../src/ui/inputEditor');

function editorFixture(t, { width = 80, height = 24 } = {}) {
  const input = new PassThrough();
  input.isTTY = true; input.setRawMode = () => {};
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  Object.assign(output, { isTTY: true, columns: width, rows: height });
  const screen = blessed.screen({ input, output, terminal: 'xterm-256color', fullUnicode: true });
  const editor = new InputEditor({ parent: screen, bottom: 0, left: 0, right: 0, height: 3, border: { type: 'line' } });
  const commands = [
    { name: 'help', aliases: ['?', 'commands'], help: 'List commands.' },
    { name: 'positions', aliases: ['pos'], help: 'Show positions.' },
    { name: 'lessons', args: '[n]', help: 'Show recent lessons.' },
  ];
  const submitted = [];
  editor.setCommands(() => commands);
  editor.onSubmit(line => submitted.push(line));
  // The app has a global Tab-to-focus binding, which must not reset menu selection.
  screen.key('tab', () => editor.focus());
  editor.focus();
  t.after(() => { screen.destroy(); input.destroy(); output.destroy(); });
  const type = async bytes => {
    input.write(bytes);
    await nextTurn();
    if (bytes === '\x1b') await delay(550);
  };
  const capture = () => stripVTControlCharacters(screen.screenshot(0, screen.width, 0, screen.height));
  return { editor, screen, commands, submitted, type, capture, output };
}

test('terminal slash menu renders from the live registry and accepts keys without submitting a selection', async t => {
  const { editor, screen, commands, submitted, type, capture } = editorFixture(t);
  await type('/');
  assert.match(capture(), /Commands 1\/3/);
  assert.match(capture(), /\/positions — Show positions/);
  await type('\x1b[B');
  assert.match(capture(), /Commands 2\/3/);
  await type('\t');
  assert.equal(editor.value, '/positions ');
  assert.equal(screen.focused, editor.el);
  assert.doesNotMatch(capture(), /Commands 2\/3/);
  assert.deepEqual(submitted, []);
  await type('\r');
  assert.deepEqual(submitted, ['/positions']);
  commands.push({ name: 'policy', help: 'Show saved policy.' });
  await type('/POL');
  assert.match(capture(), /\/policy — Show saved policy/);
  await type('\r');
  assert.equal(editor.value, '/policy ');
  assert.deepEqual(submitted, ['/positions']);
  await type('\r');
  assert.deepEqual(submitted, ['/positions', '/policy']);
  await type('/pos');
  assert.match(capture(), /Commands 1\/1/);
  await type('\t');
  assert.equal(editor.value, '/positions ');
});

test('terminal completion preserves arguments, unknown commands, history and Escape behavior', async t => {
  const { editor, submitted, type, capture } = editorFixture(t);
  await type('/le');
  assert.match(capture(), /\/lessons \[n\]/);
  await type('\t');
  await type('5');
  assert.doesNotMatch(capture(), /Commands/);
  await type('\r');
  assert.deepEqual(submitted, ['/lessons 5']);
  await type('\x1b[A');
  assert.equal(editor.value, '/lessons 5');
  await type('\x1b');
  assert.equal(editor.value, '');
  await type('/pos');
  await type('\x1b');
  assert.equal(editor.value, '/pos');
  assert.doesNotMatch(capture(), /Commands/);
  await type('\x1b[B');
  assert.match(capture(), /Commands/);
  await type('\x1b');
  await type('\x1b');
  assert.equal(editor.value, '');
  await type('Explain /positions');
  assert.doesNotMatch(capture(), /Commands/);
  await type('\x1b');
  await type('/missing');
  assert.match(capture(), /No matching commands/);
  await type('\r');
  assert.deepEqual(submitted, ['/lessons 5', '/missing']);
});

test('terminal completion never changes or submits bracketed and unbracketed pasted tables', async t => {
  const { editor, submitted, type, capture } = editorFixture(t);
  await type('\x1b[200~/pos\tvalue\r\n/lessons 3\x1b[201~');
  assert.equal(editor.value, '/pos\tvalue\n/lessons 3');
  assert.match(capture(), /Pasted \+2 lines/);
  assert.deepEqual(submitted, []);
  editor.setValue('');
  await type('/pos\tvalue\r\n/lessons 3\r\n');
  assert.equal(editor.value, '/pos value\n/lessons 3\n');
  assert.deepEqual(submitted, []);
  editor.setValue('');
  await type('/pos\tvalue');
  assert.equal(editor.value, '/pos value');
  assert.deepEqual(submitted, []);
});

test('terminal command menu scrolls, stays above the prompt on resize and supports clicking', async t => {
  const { editor, screen, commands, type, capture, output } = editorFixture(t);
  for (let i = 0; i < 12; i++) commands.push({ name: 'test' + i, help: 'Additional command.' });
  await type('/');
  await type('\x1b[A');
  assert.match(capture(), /Commands 15\/15/);
  assert.match(capture(), /\/test11/);
  output.columns = 40; output.rows = 10;
  screen.program.cols = 40; screen.program.rows = 10;
  screen.program.emit('resize');
  const menu = screen.children.find(child => child !== editor.el && !child.hidden);
  assert.ok(menu);
  assert.ok(menu.atop >= 0);
  assert.equal(menu.atop + menu.height, editor.el.atop);
  assert.match(capture(), /\/test7 — Additional command/);
  assert.match(capture(), /\/test11/);
  // SGR mouse down/up over the visible selected command, through blessed's mouse parser.
  const x = menu.aleft + menu.ileft + 2;
  const y = menu.atop + menu.height - menu.ibottom;
  await type(`\x1b[<0;${x};${y}M`);
  await type(`\x1b[<0;${x};${y}m`);
  assert.equal(editor.value, '/test11 ');
  assert.equal(screen.focused, editor.el);
});

test('the real terminal UI exposes built-in and runtime commands and routes completed input', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-terminal-'));
  const result = spawnSync(process.execPath, ['-r', './scripts/no-network.cjs', '-r', 'ts-node/register', 'tests/fixtures/terminal-commands.cjs'], {
    cwd: path.resolve(__dirname, '..'), timeout: 20000, encoding: 'utf8',
    env: { ...process.env, DATA_DIR: dir, HEADLESS: '0', TERM: 'xterm-256color',
      BROKER: 'alpaca', AI_PROVIDER: 'ollama', AI_API_KEY: 'test',
      ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets',
      ALERT_WEBHOOK_URL: '' },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(fs.readFileSync(path.join(dir, 'terminal-menu.txt'), 'utf8'), /Commands 1\/19/);
});
