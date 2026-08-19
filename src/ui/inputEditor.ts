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
 *
 * A multi-line paste collapses into one `[Pasted +N lines]` cell rather than being spilled into
 * a one-line box: the text is kept verbatim for `value`, moves and deletes as a single unit, and
 * never reaches `submit` line by line. See the paste section at the bottom for why the terminal
 * has to be asked to bracket its pastes before any of that is possible.
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

/** Turn bracketed paste (DEC private mode 2004) on and off. */
const PASTE_ON = '\x1b[?2004h';
const PASTE_OFF = '\x1b[?2004l';
/** What blessed leaves of `ESC[200~` / `ESC[201~` once its key table fails to name them. */
const PASTE_BEGIN_CODE = '[200~';
const PASTE_END_CODE = '[201~';

/**
 * Prefix on a buffer cell that stands in for a whole pasted block.
 *
 * The buffer is an array of CELLS, normally one code point each; a pasted block is one cell too,
 * holding the entire text behind this marker. That is what makes the placeholder move, delete
 * and yank as a single unit for free — every existing edit already works a cell at a time. The
 * marker is a NUL so it can never collide with pasted content: `insert` drops control
 * characters, so no cell reached through typing can begin with one.
 */
const PASTE_MARK = '\x00';

const isPaste = (cell: string): boolean => cell.startsWith(PASTE_MARK);

/** The text a cell contributes to `value` — a pasted block in full, anything else verbatim. */
const expand = (cell: string): string => (isPaste(cell) ? cell.slice(1) : cell);

/**
 * What a pasted block shows instead of itself. One trailing newline is not a line: a clipboard
 * that ends with a break has as many lines as one that does not.
 */
const pasteLabel = (cell: string): string => {
  const lines = expand(cell).replace(/\n$/, '').split('\n').length;
  return `[Pasted +${lines} line${lines === 1 ? '' : 's'}]`;
};

export class InputEditor {
  readonly el: blessed.Widgets.BoxElement;

  private readonly screen: blessed.Widgets.Screen;
  /**
   * Buffer as cells: one code point each, except a pasted block, which is one cell holding the
   * whole text (see `PASTE_MARK`). Surrogate pairs are joined into one cell too.
   */
  private chars: string[] = [];
  private cursor = 0;
  /** Index of the leftmost visible code point. */
  private scroll = 0;
  private history: string[] = [];
  /** Position in `history` while browsing, or null when editing live input. */
  private histPos: number | null = null;
  private stash = '';
  /** Last kill, as CELLS — so yanking a killed paste brings the block back, not its label. */
  private killed: string[] = [];
  /** Text collected between the paste markers, or null when not inside a bracketed paste. */
  private pasting: string[] | null = null;
  /** Inside the run of keypresses that one line break arrives as. See `breakRole`. */
  private inBreak = false;
  /** A submit waiting one turn of the loop to see whether more input follows it. */
  private pendingSubmit = false;
  /** A line break has already been folded out of this burst of input, so it was a paste. */
  private folded = false;
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

    this.listenForPaste();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get value(): string {
    return this.chars.map(expand).join('');
  }

  setValue(text: string): void {
    // Multi-line text collapses on the way in as well as on the way out: a recalled history
    // entry can be a whole pasted block, and raw newlines in a one-line box render as garbage.
    this.chars = text.includes('\n') ? [PASTE_MARK + text] : Array.from(text);
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

    // Inside a bracketed paste nothing is a command: the terminal has told us this text came
    // from a clipboard, so an Esc or a Ctrl+U in it is content that happens to look like a key.
    if (this.pasting) return this.collect(ch, name);

    // Drop the echoes of a line break before anything else can mistake one for input.
    const role = this.breakRole(name);
    if (role === 'echo') return;

    // Something behind an armed submit in the same read of stdin — another break included —
    // means that newline came from a paste that arrived without markers. Fold it into the
    // buffer and carry on with this key.
    if (this.pendingSubmit) {
      this.pendingSubmit = false;
      this.folded = true;
      // Cleared at the end of the burst, unless a submit is armed by then — that one has to see
      // the flag to know it is the tail of a paste. Without this, the operator's next Return
      // after an unmarked paste would be swallowed as one more fold.
      setImmediate(() => {
        if (!this.pendingSubmit) this.folded = false;
      });
      this.fold('\n');
    }

    if (role === 'break') return this.armSubmit();
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
    if (ctrl && name === 'y') return this.yank();

    // A tab is a column separator in a pasted table far more often than it is a keystroke —
    // nothing in this box is bound to it — and `insert` drops it as a control character, welding
    // two columns into one word. A space keeps the separation the operator pasted. The same
    // substitution happens to a single-line bracketed paste, in `insertBlock`.
    if (name === 'tab' && !ctrl && !meta) return this.insert(' ');

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
    this.killed = this.chars.slice(from, to);
    this.chars.splice(from, to - from);
    this.cursor = from;
    this.render();
  }

  /** Re-insert the last kill. Cells rather than text, so a killed paste returns as one block. */
  private yank(): void {
    if (!this.killed.length) return;
    this.chars.splice(this.cursor, 0, ...this.killed);
    this.cursor += this.killed.length;
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
    // A pasted block is one word. Testing its text would match the spaces INSIDE it and read
    // the whole block as whitespace, so word motion has to look at the cell, not its content.
    const blank = (i: number) => {
      const cell = this.chars[i];
      return cell === undefined ? true : !isPaste(cell) && /\s/.test(cell);
    };
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
      const disp = this.displayOf(i);
      const w = this.cellWidth(disp);
      if (used + w > width) break;
      out += disp;
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

  /** What cell `i` looks like on screen: itself, or the label standing in for a pasted block. */
  private displayOf(i: number): string {
    const cell = this.chars[i];
    return isPaste(cell) ? pasteLabel(cell) : cell;
  }

  /**
   * Display columns of cells [from, to), accounting for wide glyphs.
   *
   * Summed per cell rather than measured over the joined range, because a pasted block occupies
   * the columns of its LABEL and not of its text — and every caller (`reveal`, `placeCursor`)
   * is asking where the cursor sits on screen.
   */
  private widthOf(from: number, to: number): number {
    let w = 0;
    for (let i = from; i < to; i++) w += this.cellWidth(this.displayOf(i));
    return w;
  }

  private cellWidth(display: string): number {
    // @types/blessed mistypes strWidth as returning a string.
    return this.el.strWidth(display) as unknown as number;
  }

  // ── Paste ──────────────────────────────────────────────────────────────────

  /**
   * Ask the terminal to bracket pastes, and watch the raw key stream for the markers.
   *
   * Bracketed paste (DEC private mode 2004) wraps pasted text in `ESC[200~` … `ESC[201~`, which
   * is the only way to know that a newline came from a clipboard rather than from the Return
   * key. blessed neither enables it nor delivers it: `program.js:388` returns early for any
   * sequence its key table cannot name, and that is precisely what both markers parse to. The
   * sequence does survive as `key.code` on the raw input stream, where every listener still sees
   * it, so that is where this listens.
   *
   * Registration order against blessed's own handler does not matter: `keys.js` dispatches one
   * keypress completely before parsing the next character, so `pasting` is always set before the
   * first pasted character reaches `onKey`.
   */
  private listenForPaste(): void {
    const program = this.screen.program;
    program.write(PASTE_ON);

    // Leaving the mode on outlives the process: the shell that gets the terminal back would
    // echo the raw markers into its next command line. blessed's own exit handling restores
    // plenty, but it knows nothing about a mode it never set.
    const off = (): void => {
      try {
        program.write(PASTE_OFF);
      } catch {
        // Stream already closed — nothing left to restore.
      }
    };
    process.once('exit', off);
    this.screen.once('destroy', off);

    (program.input as NodeJS.EventEmitter).on('keypress', (_ch: unknown, key?: { code?: string }) => {
      if (key?.code === PASTE_BEGIN_CODE) this.pasting = [];
      else if (key?.code === PASTE_END_CODE) this.flushPaste();
    });
  }

  /**
   * Where a key sits in a line break, so one break is never counted twice.
   *
   * A single break reaches a widget up to three times, in this order: blessed re-emits every CR
   * as an 'enter' keypress from inside its own handler (program.js:397) — which is dispatched
   * before the 'return' it was made from — and a CRLF puts a 'linefeed' behind both. `break` is
   * the occurrence that counts, `echo` is a follow-up to drop, `other` is not part of a break at
   * all and ends the run.
   *
   * Called for every key on both paths, because it is also what keeps the echo of a submit from
   * looking like input arriving behind it.
   */
  private breakRole(name: string): 'break' | 'echo' | 'other' {
    if (name === 'enter') {
      this.inBreak = true;
      return 'break';
    }
    if (name === 'return') {
      // Only reached first if blessed did not duplicate the CR, which it always does — but a
      // break that counts is the safe reading of a break we were not expecting.
      const first = !this.inBreak;
      this.inBreak = true;
      return first ? 'break' : 'echo';
    }
    if (name === 'linefeed') {
      if (!this.inBreak) return 'break';
      this.inBreak = false;
      return 'echo';
    }
    this.inBreak = false;
    return 'other';
  }

  /** One keypress from inside a bracketed paste: text only, no commands, no submit. */
  private collect(ch: string | undefined, name: string): void {
    const role = this.breakRole(name);
    if (role === 'echo') return;
    const buf = this.pasting!;
    if (role === 'break') {
      buf.push('\n');
      return;
    }
    if (name === 'tab') {
      buf.push('\t');
      return;
    }
    if (ch && !CONTROL_CHAR.test(ch)) buf.push(ch);
  }

  /** End of a bracketed paste: everything collected becomes one insertion. */
  private flushPaste(): void {
    const text = (this.pasting ?? []).join('');
    this.pasting = null;
    this.inBreak = false;
    if (text) this.insertBlock(text);
  }

  /**
   * Insert pasted text at the cursor: as characters when it is one line, as one collapsed cell
   * when it is more.
   *
   * A single line stays editable in place — pasting a symbol or a sentence should look like
   * typing it — with tabs turned into spaces, because `insert` drops control characters and a
   * silently shortened line is worse than a widened one.
   */
  private insertBlock(text: string): void {
    if (!text.includes('\n')) return this.insert(text.replace(/\t/g, ' '));
    this.chars.splice(this.cursor, 0, PASTE_MARK + text);
    this.cursor++;
    this.render();
  }

  /**
   * Hold a submit for one turn of the event loop.
   *
   * A newline a human typed is the last thing in its read of stdin; a newline inside a paste has
   * the rest of the paste behind it. That is the only difference available when the markers
   * never come — an old terminal, or a `tmux` that strips them — and it is what `onKey` acts on
   * when it turns an armed submit into a line break.
   */
  private armSubmit(): void {
    this.pendingSubmit = true;
    setImmediate(() => {
      if (!this.pendingSubmit) return;
      this.pendingSubmit = false;
      // Nothing followed this break, but earlier ones in the same burst were folded away, so
      // this is a paste that happens to end with a newline — not an operator pressing Return.
      // Sending 31 pasted lines to the agent unbidden is the one outcome worth ruling out here.
      if (this.folded) {
        this.folded = false;
        return this.fold('\n');
      }

      this.submit();
    });
  }

  /**
   * Fold the whole buffer, plus a line break, into one pasted block.
   *
   * Only ever reached on the unmarked path, where the paste has no start marker and therefore no
   * known beginning: whatever is on the line is taken to be part of it. That can swallow a
   * prefix the operator typed themselves, which costs nothing — `value` expands to the same text
   * either way — and it is what makes a paste split across several reads of stdin come back
   * together as one cell instead of one per read.
   */
  private fold(tail: string): void {
    this.setValue(this.value + tail);
  }
}
