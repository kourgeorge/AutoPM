/**
 * Terminal UI — blessed-based split layout:
 *   ┌─ AutoTrade ──────────────────────────────┐
 *   │  scrollable log + orchestrator replies   │
 *   ├──────────────────────────────────────────┤
 *   │  > operator input                        │
 *   └──────────────────────────────────────────┘
 *
 * Replaces raw process.stdout/stdin in daemon.ts.
 * Everything else (logger, orchestrator reply tool) writes
 * through the exported `ui` singleton.
 */

import * as blessed from 'blessed';

// ── Palette ──────────────────────────────────────────────────────────────────

const COLORS = {
  info:  '{gray-fg}',
  warn:  '{yellow-fg}',
  error: '{red-fg}',
  trade: '{green-fg}',
  tool:  '{magenta-fg}',
  reply: '{cyan-fg}',
  user:  '{white-fg}',
  reset: '{/}',
};

const LEVEL_LABEL: Record<string, string> = {
  INFO:  `${COLORS.info}INFO {/}`,
  WARN:  `${COLORS.warn}WARN {/}`,
  ERROR: `${COLORS.error}ERR  {/}`,
  TRADE: `${COLORS.trade}TRADE{/}`,
  TOOL:  `${COLORS.tool}TOOL {/}`,
};

// ── UI singleton ─────────────────────────────────────────────────────────────

class TerminalUI {
  private screen: blessed.Widgets.Screen;
  private logBox: blessed.Widgets.Log;
  private inputBox: blessed.Widgets.TextboxElement;
  private statusBar: blessed.Widgets.BoxElement;
  private onSubmit?: (line: string) => void;

  constructor() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'AutoTrade',
      fullUnicode: true,
      // Mouse disabled so the terminal retains native text selection / copy-paste
    });

    // ── Log area ─────────────────────────────────────────────────────────────
    this.logBox = blessed.log({
      parent: this.screen,
      top: 0,
      left: 0,
      right: 0,
      bottom: 4,
      border: { type: 'line' },
      style: {
        border: { fg: 'blue' },
      },
      label: ' {bold}{blue-fg}AutoTrade{/} {gray-fg}— Trader Log{/} ',
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: '│',
        style: { fg: 'blue' },
      },
      keys: true,
      vi: true,
      padding: { left: 1, right: 1 },
    });

    // ── Status bar ────────────────────────────────────────────────────────────
    this.statusBar = blessed.box({
      parent: this.screen,
      bottom: 3,
      left: 0,
      right: 0,
      height: 1,
      style: { bg: 'blue', fg: 'white' },
      tags: true,
      content: ' {bold}AutoTrade{/}  |  Type a message and press Enter  |  Tab/Esc → input  |  Ctrl+C to quit',
      padding: { left: 1 },
    });

    // ── Input area ────────────────────────────────────────────────────────────
    this.inputBox = blessed.textbox({
      parent: this.screen,
      bottom: 0,
      left: 0,
      right: 0,
      height: 3,
      border: { type: 'line' },
      style: {
        border: { fg: 'blue' },
        focus: { border: { fg: 'cyan' } },
      },
      label: ' {cyan-fg}Operator{/} ',
      tags: true,
      inputOnFocus: true,
      keys: true,
      padding: { left: 1 },
    });

    // ── Key bindings ─────────────────────────────────────────────────────────
    this.screen.key(['C-c'], () => process.exit(0));

    // Re-focus input from anywhere (Tab or Escape returns to the prompt)
    this.screen.key(['tab', 'escape'], () => {
      this.inputBox.focus();
      this.screen.render();
    });

    this.inputBox.key('enter', () => {
      const value = (this.inputBox.getValue() as string).trim();
      if (value) {
        this.appendUserMessage(value);
        this.onSubmit?.(value);
      }
      this.inputBox.clearValue();
      this.inputBox.focus();
      this.screen.render();
    });

    // Scroll log with Page Up/Down even when input is focused
    this.inputBox.key('pageup',   () => { this.logBox.scroll(-this.logBox.height as number); this.screen.render(); });
    this.inputBox.key('pagedown', () => { this.logBox.scroll(this.logBox.height as number);  this.screen.render(); });

    this.inputBox.focus();
    this.screen.render();
  }

  // ── Public API ───────────────────────────────────────────────────────────

  onMessage(handler: (line: string) => void): void {
    this.onSubmit = handler;
  }

  log(level: 'INFO' | 'WARN' | 'ERROR' | 'TRADE' | 'TOOL', msg: string): void {
    const ts   = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    const label = LEVEL_LABEL[level] ?? level;
    this.logBox.log(`{gray-fg}${ts}{/}  ${label}  ${this.escape(msg)}`);
    this.screen.render();
  }

  reply(msg: string): void {
    this.logBox.log('');
    const lines = msg.split('\n');
    lines.forEach((line, i) => {
      const prefix = i === 0 ? `${COLORS.reply}[ORCHESTRATOR]{/} ` : '               ';
      this.logBox.log(`${prefix}${COLORS.reply}${this.escape(line)}{/}`);
    });
    this.logBox.log('');
    this.screen.render();
  }

  alert(msg: string): void {
    this.logBox.log('');
    this.logBox.log(`{bold}{yellow-fg}⚠ ALERT{/}  ${this.escape(msg)}`);
    this.logBox.log('');
    this.screen.render();
  }

  setStatus(text: string): void {
    this.statusBar.setContent(` {bold}AutoTrade{/}  |  ${text}  |  PgUp/PgDn scroll  |  Tab/Esc → input  |  Ctrl+C quit`);
    this.screen.render();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private appendUserMessage(msg: string): void {
    this.logBox.log(`{bold}{white-fg}user: ${this.escape(msg)}{/}`);
    this.screen.render();
  }

  private escape(s: string): string {
    return s.replace(/[{}]/g, c => c === '{' ? '\\{' : '\\}');
  }

  /**
   * Redirect raw process.stdout / process.stderr writes into the log box.
   * Blessed itself writes ANSI escape sequences (\x1b…) to paint the screen —
   * those are passed straight through to the real fd so the layout isn't broken.
   * Everything else (console.log, third-party warnings, etc.) is captured.
   */
  captureStreams(): void {
    const self = this;
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);

    const makeCapture = (orig: (...a: any[]) => boolean) =>
      (chunk: any, enc?: any, cb?: any): boolean => {
        const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        // Pass through blessed's own terminal-control sequences untouched
        if (str.startsWith('\x1b') || str === '\n' || str === '\r\n') {
          return orig(chunk, enc, cb);
        }
        const text = str.replace(/\r?\n$/, '');
        if (text.trim()) {
          for (const line of text.split(/\r?\n/)) {
            if (line.trim()) self.logBox.log(`{gray-fg}${self.escape(line)}{/}`);
          }
          self.screen.render();
        }
        if (typeof enc === 'function') enc();
        else cb?.();
        return true;
      };

    (process.stdout as any).write = makeCapture(origOut);
    (process.stderr as any).write = makeCapture(origErr);
  }
}

export const ui = new TerminalUI();
