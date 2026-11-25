export const beijingDay = (time = Date.now()) => new Date(time + 8 * 3600_000).toISOString().slice(0, 10);
export const validApp = (s: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(s);
export const validVersion = (s: string) => /^[A-Za-z0-9._+-]{1,100}$/.test(s);

const AUTOMATED_UA = /(?:bot|crawler|spider|slurp|externalagent|facebookexternalhit|skypeuripreview|whatsapp\/|nginx-ssl|curl|wget|python|httpx|aiohttp|urllib|requests\/|scrapy|go-http-client|okhttp|apache-httpclient|java\/|undici|axios|node-fetch|\bnode\/\d|reqwest|httpie|postman|insomnia|libwww|lwp-|guzzle|php\/|ruby|perl|powershell|playwright|puppeteer|selenium|phantomjs|webdriver|headless|lighthouse|pagespeed|uptimerobot|pingdom|statuscake|linkcheck|lychee|ahrefs|semrush|httrack|ia_archiver|archive\.org|heritrix|nutch|zgrab|nuclei|masscan|censys|shodan)/i;

/** Skip known automation, non-navigation fetches and speculative loads. This is a request count, not unique people. */
export function shouldCountDownload(request: Request) {
  if (request.method !== 'GET') return false;
  if (/prefetch|prerender/i.test(`${request.headers.get('Purpose') ?? ''} ${request.headers.get('Sec-Purpose') ?? ''}`)) return false;
  if (request.headers.has('Range')) return false;
  const cf = (request as Request & { cf?: { verifiedBotCategory?: string; botManagement?: { verifiedBot?: boolean } } }).cf;
  if (cf?.botManagement?.verifiedBot || cf?.verifiedBotCategory) return false;
  const agent = request.headers.get('User-Agent') ?? '';
  if (!/^(?:Mozilla|Opera)\//i.test(agent) || AUTOMATED_UA.test(agent)) return false;
  if ((request.headers.get('Sec-Fetch-Mode') ?? '').toLowerCase() !== 'navigate') return false;
  if ((request.headers.get('Sec-Fetch-Dest') ?? '').toLowerCase() !== 'document') return false;
  if (!(request.headers.get('Accept-Language') ?? '').trim()) return false;
  return true;
}

export function safeDownloadTarget(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // One historical installer is served as a static Pages asset. Never allow /api/ or external protocol-relative paths.
  if (/^\/downloads\/[A-Za-z0-9][A-Za-z0-9._+-]*\.(dmg|zip|pkg)$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password
      || url.port || url.search || url.hash
      || !/^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

export async function recordDownload(db: D1Database, app: string, version: string, now = Date.now()) {
  await db.prepare(`INSERT INTO download_daily (day, app_id, version, requests) VALUES (?, ?, ?, 1)
    ON CONFLICT (day, app_id, version) DO UPDATE SET requests = requests + 1`)
    .bind(beijingDay(now), app, version).run();
}

const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function downloadRange(params: URLSearchParams, now = Date.now()) {
  const to = params.get('to') ?? beijingDay(now);
  const from = params.get('from') ?? beijingDay(now - 29 * 86400_000);
  const app = params.get('app') ?? '';
  if (!isDate(from) || !isDate(to) || from > to || to > beijingDay(now)
    || (Date.parse(to) - Date.parse(from)) / 86400_000 > 365 || (app && !validApp(app))) return null;
  return { from, to, app };
}
