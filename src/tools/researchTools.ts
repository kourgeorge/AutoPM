/**
 * The tool here that reaches outside the system for PROSE.
 *
 * Everything else that used to live in this file was scraped from an unofficial endpoint and
 * removed. Each has since come back through a source that can be named, and each has its own
 * tool: macro indicators from FRED (`get_macro_regime`), bars and quotes from the broker
 * (`alpacaDataTools.ts`), indicators from the signal engine (`get_signals`), and earnings
 * dates and fundamentals from Yahoo's `quoteSummary` (`get_calendar`, `get_fundamentals`,
 * built on `src/collect/fundamentals.ts`). SEC filings are still absent; they belong to
 * `data.sec.gov`, not to a scrape.
 *
 * So what remains here is the one capability nothing structured can supply: recent news in
 * prose, through Tavily web search. (Per-ticker news from Alpaca and Yahoo is `get_news`.)
 * Note the division that follows from it — a DATE is never news. An earnings date read out
 * of a search result is a guess with a citation attached; `get_calendar` is the only
 * source of one.
 */

import { ToolDefinition } from '../core/types';

export const RESEARCH_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'web_search',
    description:
      'Search the web for recent news, analysis, or information about a company or market topic.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query, e.g. "NVDA earnings guidance 2025"' },
        limit: { type: 'integer', description: 'Max results to return (default 5)', minimum: 1, maximum: 10 },
      },
      required: ['query'],
    },
  },
];

/** Tavily only. Without a key, or when Tavily fails, says so — never an empty result list. Never throws. */
async function executeWebSearch(query: string, limit: number): Promise<string> {
  const tavilyKey = process.env.TAVILY_API_KEY;
  // DuckDuckGo's HTML endpoint used to be the keyless fallback. It now answers bots with a
  // challenge page, which parsed as zero results — "no news" when search was in fact down.
  if (!tavilyKey) return JSON.stringify({ results: [], error: 'web search unavailable: TAVILY_API_KEY is not set' });

  try {
    const { default: axios } = await import('axios');
    const res = await axios.post(
      'https://api.tavily.com/search',
      { api_key: tavilyKey, query, max_results: limit, search_depth: 'basic' },
      { timeout: 10_000 },
    );
    const hits = (res.data.results ?? []).slice(0, limit).map((r: any) => ({
      title: r.title,
      url: r.url,
      snippet: r.content ?? '',
      publishedAt: r.published_date ?? null,
      score: r.score ?? null,
    }));
    return JSON.stringify({ results: hits });
  } catch (err: any) {
    const status = err?.response?.status;
    return JSON.stringify({ results: [], error: `web search unavailable: Tavily ${status ? `HTTP ${status}` : err?.message ?? 'request failed'}` });
  }
}

export async function executeResearchTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (name === 'web_search') return executeWebSearch(input.query as string, (input.limit as number | undefined) ?? 5);
  return null;
}
