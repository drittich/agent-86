/**
 * DuckDuckGo Lite search backend.
 *
 * Uses the free lite.duckduckgo.com endpoint (no API key required).
 * Parses the HTML response to extract result links, titles, and snippets.
 */

export type HttpGetFn = (url: string, headers: Record<string, string>) => Promise<string>;

export interface RawSearchResult {
  title: string;
  url: string;
  snippet?: string;
  source: 'duckduckgo_lite';
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve a DDG href to the actual destination URL.
 *
 * DDG Lite uses redirect links in the form:
 *   //duckduckgo.com/l/?uddg=<encoded_url>&rut=...
 * The `uddg` param holds the encoded target URL.
 */
function resolveDdgHref(href: string): string | null {
  const uddgMatch = href.match(/[?&]uddg=([^&]+)/);
  if (uddgMatch) {
    try { return decodeURIComponent(uddgMatch[1]); } catch { return null; }
  }
  // Direct HTTP/HTTPS link not pointing back to DDG
  if (/^https?:\/\//.test(href) && !href.includes('duckduckgo.com')) {
    return href;
  }
  return null;
}

export function parseDdgLiteHtml(html: string): RawSearchResult[] {
  const results: RawSearchResult[] = [];
  const seenUrls = new Set<string>();

  // Match anchors — inner content capped at 400 chars to avoid cross-element greed
  const anchorRe = /<a[^>]+href="([^"]{1,2000})"[^>]*>([\s\S]{1,400}?)<\/a>/gi;
  let m: RegExpExecArray | null;

  while ((m = anchorRe.exec(html)) !== null) {
    const resolved = resolveDdgHref(m[1]);
    if (!resolved) { continue; }
    if (seenUrls.has(resolved)) { continue; }
    seenUrls.add(resolved);

    const title = stripHtml(m[2]);
    if (!title || title.length < 3) { continue; }

    results.push({ title, url: resolved, snippet: undefined, source: 'duckduckgo_lite' });
    if (results.length >= 8) { break; }
  }

  // Extract snippets from result-snippet cells
  const snipRe = /<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]{1,500}?)<\/td>/gi;
  let i = 0;
  while ((m = snipRe.exec(html)) !== null && i < results.length) {
    const text = stripHtml(m[1]);
    if (text) { results[i].snippet = text; }
    i++;
  }

  return results;
}

export async function searchDuckDuckGoLite(query: string, httpGet: HttpGetFn): Promise<RawSearchResult[]> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  try {
    const html = await httpGet(url, {
      'User-Agent': 'Mozilla/5.0 (compatible; agent-86/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
    });
    return parseDdgLiteHtml(html);
  } catch {
    return [];
  }
}
