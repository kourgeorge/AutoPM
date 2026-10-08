import axios from 'axios';
import { readValue, saveValue } from '../core/storage';
import { agentContext } from '../core/agentContext';

const BLS_URL = 'https://www.bls.gov/schedule/news_release/bls.ics';
const FED_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
export interface EconomicEvent { title: string; date: string; scheduledAt: string | null; source: string; sourceUrl: string; timeConfirmed: boolean }
interface EconomicCalendar { fetchedAt: string; events: EconomicEvent[]; sources: Array<{ source: string; status: 'available' | 'unavailable'; error?: string }>; caveats: string[] }

/** Convert a stated local ET time, respecting DST. Never guess a time for a date-only event. */
export function easternTimestamp(date: string, hour: number, minute: number): string {
  const target = Date.parse(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  let utc = target;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(utc));
    const p = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const local = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);
    utc += target - local;
  }
  return new Date(utc).toISOString();
}

export function parseBlsCalendar(text: string): EconomicEvent[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const events: EconomicEvent[] = [];
  for (const match of unfolded.matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT/g)) {
    const block = match[1], title = /^SUMMARY[^:]*:(.+)$/m.exec(block)?.[1]?.trim();
    const start = /^DTSTART([^:]*):([0-9]{8})(?:T([0-9]{2})([0-9]{2})([0-9]{2})(Z)?)?\s*$/m.exec(block);
    if (!title || !start) continue;
    const date = `${start[2].slice(0, 4)}-${start[2].slice(4, 6)}-${start[2].slice(6, 8)}`;
    const timezoneKnown = !start[1] || /TZID=(?:America\/New_York|US\/Eastern)/.test(start[1]);
    const scheduledAt = start[3] && timezoneKnown ? start[6] ? `${date}T${start[3]}:${start[4]}:${start[5]}Z` : easternTimestamp(date, Number(start[3]), Number(start[4])) : null;
    events.push({ title: title.replace(/\\n/g, ' ').replace(/\\,/g, ','), date, scheduledAt, source: 'BLS', sourceUrl: BLS_URL, timeConfirmed: scheduledAt !== null });
  }
  if (!events.length) throw new Error('BLS calendar contained no parseable events');
  return events;
}

export function parseFomcCalendar(html: string): EconomicEvent[] {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const sections = [...html.matchAll(/(\d{4}) FOMC Meetings([\s\S]*?)(?=\d{4} FOMC Meetings|$)/g)];
  const out: EconomicEvent[] = [];
  for (const section of sections) {
    for (const row of section[2].matchAll(/class="[^"]*fomc-meeting__month[^"]*"[^>]*>([\s\S]*?)<\/div>[\s\S]*?class="[^"]*fomc-meeting__date[^"]*"[^>]*>([\s\S]*?)<\/div>/g)) {
      const monthNames = row[1].replace(/<[^>]+>/g, '').trim().split('/'), month = months.indexOf(monthNames.at(-1)!) + 1;
      const days = row[2].replace(/<[^>]+>/g, '').match(/\d+/g), day = days?.at(-1);
      if (!month || !day || /unscheduled|cancel/i.test(row[2])) continue;
      const date = `${section[1]}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`;
      out.push({ title: 'FOMC meeting final day', date, scheduledAt: null, source: 'Federal Reserve', sourceUrl: FED_URL, timeConfirmed: false });
    }
  }
  if (!out.length) throw new Error('Federal Reserve calendar contained no parseable meeting dates');
  return out;
}

export function cachedEconomicCalendar(): EconomicCalendar | null {
  const value = readValue<EconomicCalendar>('economic-calendar');
  return value && Date.now() - Date.parse(value.fetchedAt) < 6 * 3600000 ? value : null;
}
export async function economicCalendar(days = 14) {
  let calendar = cachedEconomicCalendar();
  if (!calendar) {
    const sources = [{ source: 'BLS', url: BLS_URL, parse: parseBlsCalendar }, { source: 'Federal Reserve', url: FED_URL, parse: parseFomcCalendar }];
    const results = await Promise.allSettled(sources.map(async s => s.parse((await axios.get<string>(s.url, { timeout: 10000, maxContentLength: 2000000, signal: agentContext.getStore()?.signal })).data)));
    calendar = { fetchedAt: new Date().toISOString(), events: results.flatMap(r => r.status === 'fulfilled' ? r.value : []),
      sources: results.map((r, i) => r.status === 'fulfilled' ? { source: sources[i].source, status: 'available' } : { source: sources[i].source, status: 'unavailable', error: String(r.reason?.message ?? r.reason) }),
      caveats: ['FOMC dates identify meeting final days; exact announcement times are unknown here.', 'Coverage is BLS releases and scheduled FOMC meetings, not every economic or geopolitical catalyst.'] };
    // Outages are retried on the next tool request instead of becoming a six-hour empty calendar.
    if (calendar.sources.every(s => s.status === 'available')) saveValue('economic-calendar', calendar);
  }
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const to = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  return { ...calendar, from: today, to, events: calendar.events.filter(e => e.date >= today && e.date <= to),
    complete: calendar.sources.every(s => s.status === 'available') };
}
