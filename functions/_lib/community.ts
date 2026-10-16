import type { Env } from './env';
import { randomToken, sha256Hex } from './crypto';
import { error, parseCookies, serializeCookie } from './http';
import { boundedBody } from './feedback-screenshots';

export const VISITOR_COOKIE = '__Host-community';
export async function visitor(request: Request, create = false) {
  let token = parseCookies(request.headers.get('Cookie'))[VISITOR_COOKIE];
  if (!/^[A-Za-z0-9_-]{43}$/.test(token ?? '')) token = '';
  const fresh = !token && create;
  if (fresh) token = randomToken();
  return { hash: token ? await sha256Hex(token) : null,
    cookie: fresh ? serializeCookie(VISITOR_COOKIE, token, { maxAge: 365 * 86400 }) : null };
}

export async function knownApp(env: Env, request: Request, app: unknown) {
  if (typeof app !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(app)) return false;
  const r = await env.ASSETS.fetch(new Request(new URL('/community-catalog.json', request.url)));
  if (!r.ok) return false;
  try { const ids = await r.json(); return Array.isArray(ids) && ids.includes(app); }
  catch { return false; }
}

export async function communityBody(request: Request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return { response: error(415, 'unsupported_media_type') };
  const bytes = await boundedBody(request, 8192);
  if (!bytes) return { response: error(413, 'too_large') };
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { response: error(400, 'invalid') };
    return { value: value as Record<string, unknown> };
  } catch { return { response: error(400, 'bad_json') }; }
}

/** Atomic counters: concurrency cannot bypass limits. IP hashes are salted per deployment and time bucket. */
export async function allowWrite(db: D1Database, request: Request, hash: string, comment: boolean, now = Date.now()) {
  const window = comment ? 3600_000 : 60_000;
  const bucket = Math.floor(now / window);
  const salt = await db.prepare("SELECT value FROM community_settings WHERE key = 'rate_salt'").first<{ value: string }>();
  if (!salt) throw new Error('community_not_migrated');
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  const network = await sha256Hex(`${salt.value}:${bucket}:${ip}`);
  await db.prepare('DELETE FROM community_limits WHERE expires_at < ?').bind(now).run();
  for (const [key, max] of [[`ip:${network}`, comment ? 10 : 60], [`visitor:${hash}`, comment ? 3 : 30]] as const) {
    const row = await db.prepare(`INSERT INTO community_limits (key, hits, expires_at) VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET hits = hits + 1 RETURNING hits`)
      .bind(`${comment ? 'comment' : 'vote'}:${bucket}:${key}`, (bucket + 1) * window).first<{ hits: number }>();
    if (!row || row.hits > max) return Math.ceil(((bucket + 1) * window - now) / 1000);
  }
  return 0;
}

export const summary = (db: D1Database, app: string) => db.prepare(`SELECT COALESCE(SUM(liked),0) AS likes,
  COUNT(rating) AS ratings, ROUND(AVG(rating),1) AS average FROM app_votes WHERE app_id = ?`).bind(app).first();

export function cursor(raw: string | null): { time: number; id: string } | null | false {
  if (!raw) return null;
  const match = /^(\d{1,15}):([a-zA-Z0-9-]{1,64})$/.exec(raw);
  return match ? { time: Number(match[1]), id: match[2] } : false;
}
export interface Comment { id: string; app_id: string; body: string; status: string; created_at: number }
export async function listComments(db: D1Database, app: string, status: string, after: ReturnType<typeof cursor>) {
  const where = ['status = ?'];
  const args: (string | number)[] = [status];
  if (app) { where.push('app_id = ?'); args.push(app); }
  if (after) { where.push('(created_at < ? OR (created_at = ? AND id < ?))'); args.push(after.time, after.time, after.id); }
  const { results } = await db.prepare(`SELECT id, app_id, body, status, created_at FROM app_comments WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT 21`).bind(...args).all<Comment>();
  const rows = results.slice(0, 20);
  const last = rows.at(-1);
  return { comments: rows.map(r => ({ id: r.id, appId: r.app_id, body: r.body, status: r.status, createdAt: r.created_at })), next: results.length > 20 && last ? `${last.created_at}:${last.id}` : null };
}

export const pendingComments = (db: D1Database) => db.prepare("SELECT COUNT(*) AS count, (SELECT id FROM app_comments WHERE status = 'pending' ORDER BY created_at DESC, id DESC LIMIT 1) AS latestId FROM app_comments WHERE status = 'pending'").first<{ count: number; latestId: string | null }>();
