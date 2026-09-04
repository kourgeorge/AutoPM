/**
 * The one place that decides which characters this terminal may be shown.
 *
 * The verdict is NOT sniffed from `process.platform`. Blessed already resolves it properly
 * from terminfo — `screen._unicode = tput.unicode || tput.numbers.U8 === 1`
 * (blessed/lib/widgets/screen.js:83) — and, for anything non-ASCII that slips through, maps
 * the character to the terminal's ACS equivalent or to a literal `?` (screen.js:1356). That
 * second behaviour is exactly what makes a hand-rolled platform guess worse than useless: a
 * wrong guess does not garble the screen, it silently replaces every arrow and bullet with a
 * question mark. So `ui.ts` asks blessed and passes the answer here, and the only thing this
 * module owns is what to draw INSTEAD.
 *
 * Box-drawing characters are deliberately absent: blessed draws its own borders and handles
 * their fallback through the same ACS path.
 */

export interface Glyphs {
  /** Cycle-in-progress animation. Frame count is arbitrary; callers modulo by `length`. */
  spinner: readonly string[];
  /** Live/heartbeat marker in the panel header. */
  live: string;
  /** Bullish / bearish / neutral direction. */
  up: string;
  down: string;
  flat: string;
  /** Value that does not exist — a null price, an unset stop. Never a zero. */
  dash: string;
  /** Value that exists but could not be trusted this tick. */
  stale: string;
  /** Inline field separator. */
  sep: string;
  /** Truncation marker; one column wide in both modes. */
  ellipsis: string;
  /** Event severity, for the inbox panel. */
  sevCritical: string;
  sevUrgent: string;
  sevWarn: string;
  sevInfo: string;
}

const UNICODE: Glyphs = {
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  live: '●',
  up: '▲',
  down: '▼',
  flat: '·',
  dash: '—',
  stale: '⋯',
  sep: '·',
  ellipsis: '…',
  sevCritical: '⛔',
  sevUrgent: '▲',
  sevWarn: '⚠',
  sevInfo: '·',
};

const ASCII: Glyphs = {
  spinner: ['|', '/', '-', '\\'],
  live: '*',
  up: '^',
  down: 'v',
  flat: '-',
  dash: '-',
  stale: '~',
  sep: '|',
  ellipsis: '+',
  sevCritical: 'X',
  sevUrgent: '^',
  sevWarn: '!',
  sevInfo: '-',
};

/**
 * `unicodeOk` comes from blessed's terminfo verdict. `AUTOTRADE_ASCII=1` overrides it downward
 * for the operator whose terminal claims more than it can draw — the reverse override is not
 * offered, because forcing unicode onto a terminal that cannot render it produces `?`.
 */
export function makeGlyphs(unicodeOk: boolean): Glyphs {
  if (process.env.AUTOTRADE_ASCII === '1') return ASCII;
  return unicodeOk ? UNICODE : ASCII;
}

export { ASCII as ASCII_GLYPHS, UNICODE as UNICODE_GLYPHS };
