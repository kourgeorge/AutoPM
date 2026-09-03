/**
 * A date in exchange time.
 *
 * Portfolio equity is stamped at the session's ET close and a daily bar at its ET open, so
 * reading either in UTC rolls some of them onto the neighbouring date. Built from
 * `formatToParts` rather than a locale string so the format is ours and not the runtime's.
 */
const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function etDate(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  const parts = ET_PARTS.formatToParts(new Date(ms));
  const get = (type: string) => parts.find(p => p.type === type)?.value;
  const [y, m, d] = [get('year'), get('month'), get('day')];
  return y && m && d ? `${y}-${m}-${d}` : null;
}
