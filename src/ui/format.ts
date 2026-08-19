/**
 * Pure formatting for the dashboard. No blessed, no widgets, no imports — so it can be
 * probed under `tmp/` without a terminal and without `config.ts` throwing on a missing key.
 *
 * Two rules run through everything here.
 *
 * 1. **`null` is a first-class value, and it is never zero.** Every numeric field on
 *    `TickData` is nullable, and the difference between "RSI is 0" and "we do not know the
 *    RSI" is the difference between a signal and a missing feed. So the null renderer is
 *    `glyphs.dash`, chosen per terminal, and nothing here ever coalesces to 0.
 *
 * 2. **Width is measured on plain text, colour is applied after.** Blessed tags
 *    (`{green-fg}`, `{/}`) occupy zero columns on screen but plenty in a JS string, so any
 *    `padEnd` applied to already-tagged text is off by the length of the tags and the panel's
 *    right border walks. `cell()` is the single place the two meet: fit first, tag second.
 */

// ── Width ─────────────────────────────────────────────────────────────────────

/**
 * On-screen columns of a plain string.
 *
 * Not `s.length`: a code point above the BMP is two UTF-16 units and one column, a combining
 * mark is zero, and a CJK ideograph is two. The panel is a fixed-width grid, so a wrong count
 * here is a visibly ragged border rather than a subtly wrong number.
 */
export function plainWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x200b || (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

/** East-Asian Wide / Fullwidth ranges, coarse but sufficient for tickers and ASCII labels. */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff)
  );
}

/**
 * Columns a piece of blessed MARKUP will occupy — the inverse of `cell()`, used by the probe
 * to assert that every rendered line is exactly as wide as it claimed.
 *
 * Escaped braces (written by `escapeTags`) are one visible column each and must survive tag
 * stripping, so they are removed before the tag pass rather than after it.
 */
export function markupWidth(markup: string): number {
  const escapes = markup.match(/\\[{}]/g)?.length ?? 0;
  const stripped = markup.replace(/\\[{}]/g, '').replace(/\{[^{}]*\}/g, '');
  return plainWidth(stripped) + escapes;
}

/**
 * Escape a string so blessed renders it literally instead of parsing it as a tag.
 *
 * Shared with the log box: a symbol, a model id or an operator's message can contain braces,
 * and an unbalanced brace swallows the rest of the line. One implementation so a panel row and
 * a log line can never disagree about it.
 */
export function escapeTags(s: string): string {
  return s.replace(/[{}]/g, (c) => (c === '{' ? '\\{' : '\\}'));
}

// ── Wrapping ──────────────────────────────────────────────────────────────────

/**
 * Greedy word-wrap of PLAIN text to `width` columns.
 *
 * Here rather than in the widget because a hanging indent has to be applied by whoever owns the
 * prefix: blessed wraps to the box edge and always resumes at column 0 (element.js:600), which
 * turns the second row of a reply into something that reads like a new speaker. Callers wrap
 * first, then prefix every row themselves.
 *
 * Measured with `plainWidth`, so an emoji or a CJK ideograph costs what it actually costs.
 * `width <= 0` returns the input untouched — there is no sane wrap of a message into no
 * columns, and silently returning `['']` would DELETE it.
 */
export function wrapPlain(plain: string, width: number): string[] {
  if (width <= 0) return [plain];

  const rows: string[] = [];
  let row = '';
  let rowW = 0;

  // Trailing spaces are dropped on the way out: they are invisible on screen but land in the
  // operator's clipboard when they select the line.
  const flush = (): void => {
    rows.push(row.replace(/\s+$/, ''));
    row = '';
    rowW = 0;
  };

  // Runs of space and runs of non-space, so a row that breaks can swallow the whitespace it
  // broke on instead of opening the next row with it.
  for (const token of plain.match(/\s+|\S+/g) ?? []) {
    if (/\s/.test(token[0])) {
      const w = plainWidth(token);
      if (rowW + w <= width) {
        row += token;
        rowW += w;
      } else if (rowW > 0) {
        flush();
      }
      continue;
    }

    let rest = token;
    // A word that does not fit the rest of this row starts the next one — unless the row is
    // already empty, in which case the word is longer than any row and has to be cut.
    if (rowW > 0 && rowW + plainWidth(rest) > width) flush();

    while (plainWidth(rest) > width - rowW) {
      const [head, tail] = splitAt(rest, width - rowW);
      // Defensive: a zero-width cut would spin here forever rather than lose a character.
      if (head === '') break;
      row += head;
      flush();
      rest = tail;
    }

    row += rest;
    rowW += plainWidth(rest);
  }

  // `rows.length === 0` keeps an empty input an empty LINE — a blank row inside a reply is a
  // paragraph break the author put there, not an absence of content.
  if (row !== '' || rows.length === 0) flush();
  return rows;
}

/** Split after at most `width` columns, never inside a code point. */
function splitAt(plain: string, width: number): [string, string] {
  const chars = Array.from(plain);
  let head = '';
  let w = 0;
  let i = 0;
  for (; i < chars.length; i++) {
    const cw = plainWidth(chars[i]);
    if (w + cw > width) break;
    head += chars[i];
    w += cw;
  }
  return [head, chars.slice(i).join('')];
}

// ── The formatter ─────────────────────────────────────────────────────────────

/** The glyph fields this module needs. Structural, so `glyphs.ts` stays the owner. */
export interface FormatGlyphs {
  dash: string;
  ellipsis: string;
}

export interface Fmt {
  /** `$1,482` / `$14.82` — decimals only where they carry information. */
  money(n: number | null | undefined): string;
  /** `+2.41%` / `-0.30%`, sign always explicit so a loss can never read as a gain. */
  signedPct(n: number | null | undefined, dp?: number): string;
  fixed(n: number | null | undefined, dp: number): string;
  /** `42s` / `7m12s` / `2h04m` / `3d4h`. Negative clamps to `0s`. */
  duration(ms: number | null | undefined): string;
  /** How long ago an ISO timestamp was, as a duration. */
  ageOf(iso: string | null | undefined, now: number): string;
  /** `HH:MM:SS` in New York, the only clock a trading operator wants. */
  etClock(now: number): string;
  /** Truncate-with-ellipsis or pad to exactly `width` columns of plain text. */
  fit(plain: string, width: number): string;
  /** Right-align to exactly `width`; over-long text still truncates from the right. */
  fitRight(plain: string, width: number): string;
  /** `fit`, then wrap in a colour tag — the one place width and colour meet. */
  cell(plain: string, width: number, color?: string): string;
  /** Colour without touching width. `color` is a blessed tag name, e.g. `green-fg`. */
  tint(markup: string, color?: string): string;
  /** Green when positive, red when negative, plain at zero, dim when null. */
  pnlColor(n: number | null | undefined): string;
  dash: string;
}

export function makeFormat(g: FormatGlyphs): Fmt {
  const dash = g.dash;

  const isNum = (n: number | null | undefined): n is number =>
    typeof n === 'number' && Number.isFinite(n);

  function group(int: string): string {
    // Manual grouping rather than `toLocaleString`: a small-ICU Node build silently ignores a
    // locale it does not carry, and the panel must look the same on every machine.
    let out = '';
    for (let i = 0; i < int.length; i++) {
      if (i > 0 && (int.length - i) % 3 === 0) out += ',';
      out += int[i];
    }
    return out;
  }

  const fmt: Fmt = {
    dash,

    money(n) {
      if (!isNum(n)) return dash;
      const neg = n < 0;
      const abs = Math.abs(n);
      const dp = abs >= 1000 ? 0 : 2;
      const [int, frac] = abs.toFixed(dp).split('.');
      return `${neg ? '-' : ''}$${group(int)}${frac ? '.' + frac : ''}`;
    },

    signedPct(n, dp = 2) {
      if (!isNum(n)) return dash;
      return `${n >= 0 ? '+' : ''}${n.toFixed(dp)}%`;
    },

    fixed(n, dp) {
      return isNum(n) ? n.toFixed(dp) : dash;
    },

    duration(ms) {
      if (!isNum(ms)) return dash;
      const s = Math.max(0, Math.floor(ms / 1000));
      if (s < 60) return `${s}s`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`;
      return `${Math.floor(h / 24)}d${h % 24}h`;
    },

    ageOf(iso, now) {
      if (!iso) return dash;
      const t = Date.parse(iso);
      if (Number.isNaN(t)) return dash;
      return fmt.duration(now - t);
    },

    etClock(now) {
      // `Intl` is in every Node build (the timezone database is not locale data), and the ET
      // offset changes twice a year — so this is resolved, never hardcoded to -4 or -5.
      try {
        return new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York',
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }).format(new Date(now));
      } catch {
        return new Date(now).toISOString().slice(11, 19);
      }
    },

    fit(plain, width) {
      if (width <= 0) return '';
      const w = plainWidth(plain);
      if (w === width) return plain;
      if (w < width) return plain + ' '.repeat(width - w);
      return truncate(plain, width, g.ellipsis);
    },

    fitRight(plain, width) {
      if (width <= 0) return '';
      const w = plainWidth(plain);
      if (w === width) return plain;
      if (w < width) return ' '.repeat(width - w) + plain;
      return truncate(plain, width, g.ellipsis);
    },

    cell(plain, width, color) {
      return fmt.tint(escapeTags(fmt.fit(plain, width)), color);
    },

    tint(markup, color) {
      return color ? `{${color}}${markup}{/}` : markup;
    },

    pnlColor(n) {
      if (!isNum(n)) return 'gray-fg';
      if (n > 0) return 'green-fg';
      if (n < 0) return 'red-fg';
      return '';
    },
  };

  return fmt;
}

/**
 * Cut to `width` columns, spending the last column on the ellipsis so the reader can see that
 * something was removed. Walks code points, because slicing UTF-16 units can split a surrogate
 * pair into two halves that render as replacement characters.
 */
function truncate(plain: string, width: number, ellipsis: string): string {
  const ew = plainWidth(ellipsis);
  if (width <= ew) {
    // No room for content plus a marker; show the marker alone when it fits exactly, else pad.
    return width === ew ? ellipsis : ' '.repeat(width);
  }
  const budget = width - ew;
  let out = '';
  let w = 0;
  for (const ch of plain) {
    const cw = plainWidth(ch);
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return out + ' '.repeat(budget - w) + ellipsis;
}
