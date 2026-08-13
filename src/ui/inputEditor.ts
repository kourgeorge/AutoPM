/**
 * InputEditor — a readline-style single-line editor for blessed.
 *
 * blessed's own `textbox` is append-only: its key listener explicitly ignores
 * left/right/up/down and always paints the terminal cursor after the last
 * character, so mid-line editing is impossible. This widget owns the buffer,
 * the cursor and the horizontal viewport instead.
 *
 * Bindings:
 *   Enter            submit                Esc              clear line
 *   ← / →            char left/right       ⌥/Ctrl ← / →     word left/right
 *   Home / Ctrl+A    line start            End / Ctrl+E     line end
 *   Backspace        delete back           Del / Ctrl+D     delete forward
 *   Ctrl+W / ⌥Bksp   delete word back      ⌥D               delete word forward
 *   Ctrl+U           kill to start         Ctrl+K           kill to end
 *   Ctrl+Y           yank last kill        ↑ / ↓            history
 */

import * as blessed from 'blessed';

interface KeyEvent {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

const HISTORY_LIMIT = 200;
const CONTROL_CHAR = /^[\x00-\x1f\x7f]$/;

export class InputEditor {
  readonly el: blessed.Widgets.BoxElement;

  private readonly screen: blessed.Widgets.Screen;
  /** Buffer as code points, so surrogate pairs move/delete as one unit. */
  private chars: string[] = [];
  private cursor = 0;
  /** Index of the leftmost visible code point. */
  private scroll = 0;
  private history: string[] = [];
  /** Position in `history` while browsing, or null when editing live input. */
  private histPos: number | null = null;
  private stash = '';
  private killed = '';
  private handler?: (line: string) => void;

  constructor(options: blessed.Widgets.BoxOptions) {
    this.el = blessed.box({ ...options, tags: false, wrap: false });
    this.screen = this.el.screen;

    // Make the box eligible to receive key events, then own them.
    (this.screen as any)._listenKeys(this.el);
    this.el.on('keypress', (ch: string | undefined, key: KeyEvent) => this.onKey(ch, key));

    // screen.render() calls this on the focused element — our cursor hook.
    (this.el as any)._updateCursor = (fromRender?: boolean) => this.placeCursor(fromRender);

    this.el.on('focus', () => this.screen.program.showCursor());
    this.el.on('resize', () => this.render());
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get value(): string {
    return this.chars.join('');
  }

  setValue(text: string): void {
    this.chars = Array.from(text);
    this.cursor = this.chars.length;
    this.scroll = 0;
    this.render();
  }

  onSubmit(handler: (line: string) => void): void {
    this.handler = handler;
  }

  focus(): void {
    this.el.focus();
    this.screen.program.showCursor();
    this.render();
  }

  // ── Key dispatch ───────────────────────────────────────────────────────────

  private onKey(ch: string | undefined, key: KeyEvent): void {
    const name = key?.name ?? '';
    const ctrl = !!key?.ctrl;
    const meta = !!key?.meta;

    // '\r' is emitted twice by blessed: as 'return', then again as 'enter'.
    if (name === 'return') return;

    if (name === 'enter') return this.submit();
    if (name === 'escape') return this.setValue('');
    if (name === 'left') return ctrl || meta ? this.moveTo(this.wordEdge(-1)) : this.move(-1);
    if (name === 'right') return ctrl || meta ? this.moveTo(this.wordEdge(1)) : this.move(1);
    if (name === 'up') return this.recall(-1);
    if (name === 'down') return this.recall(1);
    if (name === 'home' || (ctrl && name === 'a')) return this.moveTo(0);
    if (name === 'end' || (ctrl && name === 'e')) return this.moveTo(this.chars.length);
    if (name === 'backspace') return ctrl || meta ? this.deleteWord(-1) : this.delete(-1);
    if (name === 'delete' || (ctrl && name === 'd')) return this.delete(1);
    if (meta && name === 'b') return this.moveTo(this.wordEdge(-1));
    if (meta && name === 'f') return this.moveTo(this.wordEdge(1));
    if (meta && name === 'd') return this.deleteWord(1);
    if (ctrl && name === 'w') return this.deleteWord(-1);
    if (ctrl && name === 'u') return this.kill(0, this.cursor);
    if (ctrl && name === 'k') return this.kill(this.cursor, this.chars.length);
    if (ctrl && name === 'y') return this.insert(this.killed);

    if (ch && !ctrl && !meta) this.insert(ch);
  }

  // ── Editing ────────────────────────────────────────────────────────────────

  private insert(text: string): void {
    const cps = Array.from(text).filter(c => !CONTROL_CHAR.test(c));
    if (!cps.length) return;
    this.chars.splice(this.cursor, 0, ...cps);
    this.cursor += cps.length;
    this.pairSurrogates();
    this.render();
  }

  /**
   * blessed delivers astral characters (emoji) as two keypresses — one per
   * UTF-16 half — so re-join the halves into a single buffer entry.
   */
  private pairSurrogates(): void {
    const i = this.cursor - 1;
    const code = (c: string | undefined) => (c && c.length === 1 ? c.charCodeAt(0) : 0);
    const high = code(this.chars[i - 1]);
    const low = code(this.chars[i]);
    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
      this.chars.splice(i - 1, 2, this.chars[i - 1] + this.chars[i]);
      this.cursor--;
    }
  }

  private delete(dir: -1 | 1): void {
    const at = dir < 0 ? this.cursor - 1 : this.cursor;
    if (at < 0 || at >= this.chars.length) return;
    this.chars.splice(at, 1);
    this.cursor = at;
    this.render();
  }

  private deleteWord(dir: -1 | 1): void {
    const edge = this.wordEdge(dir);
    if (dir < 0) this.kill(edge, this.cursor);
    else this.kill(this.cursor, edge);
  }

  /** Cut [from, to) into the kill buffer. */
  private kill(from: number, to: number): void {
    if (to <= from) return;
    this.killed = this.chars.slice(from, to).join('');
    this.chars.splice(from, to - from);
    this.cursor = from;
    this.render();
  }

  private move(delta: number): void {
    this.moveTo(this.cursor + delta);
  }

  private moveTo(index: number): void {
    const next = Math.max(0, Math.min(this.chars.length, index));
    if (next === this.cursor) return;
    this.cursor = next;
    this.render();
  }

  /** Nearest whitespace-delimited word boundary in `dir`. */
  private wordEdge(dir: -1 | 1): number {
    const blank = (i: number) => /\s/.test(this.chars[i] ?? ' ');
    let i = this.cursor;
    if (dir < 0) {
      while (i > 0 && blank(i - 1)) i--;
      while (i > 0 && !blank(i - 1)) i--;
    } else {
      const n = this.chars.length;
      while (i < n && blank(i)) i++;
      while (i < n && !blank(i)) i++;
    }
    return i;
  }

  // ── History ────────────────────────────────────────────────────────────────

  private submit(): void {
    const line = this.value.trim();
    this.setValue('');
    this.histPos = null;
    this.stash = '';
    if (!line) return;
    if (this.history[this.history.length - 1] !== line) {
      this.history.push(line);
      if (this.history.length > HISTORY_LIMIT) this.history.shift();
    }
    this.handler?.(line);
  }

  private recall(dir: -1 | 1): void {
    if (!this.history.length) return;

    if (this.histPos === null) {
      if (dir > 0) return; // already on the live buffer
      this.stash = this.value;
      this.histPos = this.history.length - 1;
    } else {
      const next = this.histPos + dir;
      if (next < 0) return; // hold at the oldest entry
      if (next >= this.history.length) {
        this.histPos = null;
        return this.setValue(this.stash);
      }
      this.histPos = next;
    }
    this.setValue(this.history[this.histPos]);
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  private render(): void {
    const width = this.textWidth();
    this.reveal(width);

    let out = '';
    let used = 0;
    for (let i = this.scroll; i < this.chars.length; i++) {
      const w = this.widthOf(i, i + 1);
      if (used + w > width) break;
      out += this.chars[i];
      used += w;
    }
    this.el.setContent(out);
    this.screen.render(); // in turn calls placeCursor() via _updateCursor
  }

  /** Slide the viewport so the cursor stays visible, keeping the tail in view. */
  private reveal(width: number): void {
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    while (this.scroll < this.cursor && this.widthOf(this.scroll, this.cursor) > width) {
      this.scroll++;
    }
    while (this.scroll > 0 && this.widthOf(this.scroll - 1, this.chars.length) <= width) {
      this.scroll--;
    }
  }

  private placeCursor(fromRender?: boolean): void {
    if (this.screen.focused !== this.el) return;
    const pos = fromRender ? (this.el as any).lpos : (this.el as any)._getCoords();
    if (!pos) return;
    this.screen.program.cup(
      pos.yi + this.el.itop,
      pos.xi + this.el.ileft + this.widthOf(this.scroll, this.cursor),
    );
  }

  /** Columns available for text — one is reserved for the trailing cursor. */
  private textWidth(): number {
    return Math.max(1, (this.el.width as number) - (this.el.iwidth as number) - 1);
  }

  /** Display columns of chars [from, to), accounting for wide glyphs. */
  private widthOf(from: number, to: number): number {
    // @types/blessed mistypes strWidth as returning a string.
    return this.el.strWidth(this.chars.slice(from, to).join('')) as unknown as number;
  }
}
