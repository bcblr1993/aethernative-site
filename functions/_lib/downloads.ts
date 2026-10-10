export const beijingDay = (time = Date.now()) => new Date(time + 8 * 3600_000).toISOString().slice(0, 10);
export const validApp = (s: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(s);
export const validVersion = (s: string) => /^[A-Za-z0-9._+-]{1,100}$/.test(s);

/** Skip known automation and speculative loads. This is a request count, not unique people. */
export function shouldCountDownload(request: Request) {
  if (request.method !== 'GET') return false;
  if (/prefetch|prerender/i.test(`${request.headers.get('Purpose') ?? ''} ${request.headers.get('Sec-Purpose') ?? ''}`)) return false;
  const agent = request.headers.get('User-Agent') ?? '';
  if (!agent || /bot|crawler|spider|slurp|externalagent|nginx-ssl|curl|wget|python|headless/i.test(agent)) return false;
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
