// 用户与会话的数据库操作。
import { randomToken, sha256Hex } from './crypto';
import { clearCookie, parseCookies, serializeCookie } from './http';
import type { Profile, ProviderId } from './oauth';

/** 会话 Cookie：HttpOnly，脚本读不到。 */
export const SESSION_COOKIE = '__Host-sid';
/** 仅表示“这个浏览器可能已登录”，不含任何秘密；页面据此决定是否请求 /api/me，未登录访客不产生接口请求。 */
export const HINT_COOKIE = 'an_signed_in';
/** OAuth 进行中的临时状态（state、PKCE verifier、跳转地址），10 分钟有效。 */
export const OAUTH_COOKIE = '__Host-oauth';

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
/** App 会话：90 天有效，剩余不足 30 天时使用即续期（经常打开 App 就不会被登出） */
export const APP_SESSION_TTL_MS = 90 * 24 * 3600 * 1000;
const APP_RENEW_BELOW_MS = 30 * 24 * 3600 * 1000;
const BEARER = /^Bearer ([A-Za-z0-9_-]{32,128})$/;

export interface User {
  id: string;
  name: string;
  email: string | null;
  avatar_url: string | null;
  is_admin: number;
}

/**
 * 按第三方身份查找用户；首次登录则新建用户。已有用户每次登录时同步最新的昵称、头像、邮箱。
 * 不按邮箱合并不同平台的账号（见 migrations/0001_auth.sql）。
 */
export async function upsertUser(db: D1Database, p: Profile, now = Date.now()): Promise<User> {
  const found = await db
    .prepare('SELECT user_id FROM identities WHERE provider = ? AND provider_user_id = ?')
    .bind(p.provider, p.id)
    .first<{ user_id: string }>();

  if (found) {
    await db.batch([
      db.prepare('UPDATE users SET name = ?, email = ?, avatar_url = ?, last_login_at = ? WHERE id = ?')
        .bind(p.name, p.email, p.avatarUrl, now, found.user_id),
      db.prepare('UPDATE identities SET email = ? WHERE provider = ? AND provider_user_id = ?').bind(p.email, p.provider, p.id),
    ]);
    return (await getUser(db, found.user_id))!;
  }

  const id = crypto.randomUUID();
  // batch 在 D1 中是一个事务：两条都成功或都失败，不会留下没有身份的孤儿用户
  await db.batch([
    db.prepare('INSERT INTO users (id, name, email, avatar_url, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, p.name, p.email, p.avatarUrl, now, now),
    db.prepare('INSERT INTO identities (provider, provider_user_id, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(p.provider, p.id, id, p.email, now),
  ]);
  return (await getUser(db, id))!;
}

export const getUser = (db: D1Database, id: string) =>
  db.prepare('SELECT id, name, email, avatar_url, is_admin FROM users WHERE id = ?').bind(id).first<User>();

export async function getProviders(db: D1Database, userId: string): Promise<ProviderId[]> {
  const { results } = await db.prepare('SELECT provider FROM identities WHERE user_id = ? ORDER BY created_at').bind(userId).all<{ provider: ProviderId }>();
  return results.map((r) => r.provider);
}

/** 新建会话，返回需要设置的 Cookie。顺带清理全站已过期的会话。 */
export async function createSession(db: D1Database, userId: string, userAgent: string | null, now = Date.now()) {
  const token = randomToken();
  const expires = now + SESSION_TTL_MS;
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)')
      .bind(await sha256Hex(token), userId, now, expires, userAgent?.slice(0, 256) ?? null),
  ]);
  const maxAge = SESSION_TTL_MS / 1000;
  return [serializeCookie(SESSION_COOKIE, token, { maxAge }), serializeCookie(HINT_COOKIE, '1', { maxAge, httpOnly: false })];
}

/** App 登录：新建 Bearer 会话，返回令牌（只在这一次返回，数据库只存哈希）。 */
export async function createAppSession(db: D1Database, userId: string, userAgent: string | null, now = Date.now()) {
  const token = randomToken();
  const expiresAt = now + APP_SESSION_TTL_MS;
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent, client) VALUES (?, ?, ?, ?, ?, 'ios')")
      .bind(await sha256Hex(token), userId, now, expiresAt, userAgent?.slice(0, 256) ?? null),
  ]);
  return { token, expiresAt };
}

/** 请求是否带了 Bearer 凭证（App）。这类请求不依赖浏览器自动携带的 Cookie，不受 CSRF 影响，无需同源校验。 */
export const hasBearer = (request: Request) => /^Bearer /.test(request.headers.get('Authorization') ?? '');

export interface Auth {
  user: User;
  via: 'cookie' | 'bearer';
  tokenHash: string;
}

/**
 * 读取请求携带的会话：Authorization: Bearer（只认 App 会话）或 Cookie（只认网页会话）。
 * 两种令牌互不通用，网页 Cookie 泄露也不能当作 App 令牌使用，反之亦然。无效或过期时返回 null。
 */
export async function authenticate(db: D1Database, request: Request, now = Date.now()): Promise<Auth | null> {
  const bearer = BEARER.exec(request.headers.get('Authorization') ?? '')?.[1];
  const token = bearer ?? parseCookies(request.headers.get('Cookie'))[SESSION_COOKIE];
  if (!token || token.length > 128) return null;
  const via = bearer ? 'bearer' : 'cookie';
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT u.id, u.name, u.email, u.avatar_url, u.is_admin, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ? AND s.client = ?`,
    )
    .bind(tokenHash, now, bearer ? 'ios' : 'web')
    .first<User & { expires_at: number }>();
  if (!row) return null;
  if (bearer && row.expires_at - now < APP_RENEW_BELOW_MS) {
    await db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').bind(now + APP_SESSION_TTL_MS, tokenHash).run();
  }
  const { expires_at: _, ...user } = row;
  return { user, via, tokenHash };
}

/** 读取请求携带的会话用户（Cookie 或 Bearer）；无效或过期时返回 null。 */
export async function getSessionUser(db: D1Database, request: Request, now = Date.now()): Promise<User | null> {
  return (await authenticate(db, request, now))?.user ?? null;
}

export async function deleteSession(db: D1Database, request: Request) {
  const token = BEARER.exec(request.headers.get('Authorization') ?? '')?.[1] ?? parseCookies(request.headers.get('Cookie'))[SESSION_COOKIE];
  if (token && token.length <= 128) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
}

/** 注销账号：删除用户及其全部反馈、身份与会话。显式逐表删除，不依赖外键级联是否开启。 */
export async function deleteUser(db: D1Database, userId: string) {
  await db.batch([
    db.prepare('DELETE FROM feedback WHERE user_id = ?').bind(userId),
    // 设备本身保留（仍可接收公告与版本推送），只解除与账号的关联
    db.prepare('UPDATE devices SET user_id = NULL WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM auth_codes WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM identities WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);
}

export const clearSessionCookies = () => [clearCookie(SESSION_COOKIE), clearCookie(HINT_COOKIE, false)];

export const publicUser = (u: User, providers: ProviderId[]) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  avatarUrl: u.avatar_url,
  providers,
});
