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

/** 读取请求携带的会话；无效或过期时返回 null。 */
export async function getSessionUser(db: D1Database, request: Request, now = Date.now()): Promise<User | null> {
  const token = parseCookies(request.headers.get('Cookie'))[SESSION_COOKIE];
  if (!token || token.length > 128) return null;
  return db
    .prepare(
      `SELECT u.id, u.name, u.email, u.avatar_url, u.is_admin
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .bind(await sha256Hex(token), now)
    .first<User>();
}

export async function deleteSession(db: D1Database, request: Request) {
  const token = parseCookies(request.headers.get('Cookie'))[SESSION_COOKIE];
  if (token && token.length <= 128) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
}

/** 注销账号：删除用户及其全部反馈、身份与会话。显式逐表删除，不依赖外键级联是否开启。 */
export async function deleteUser(db: D1Database, userId: string) {
  await db.batch([
    db.prepare('DELETE FROM feedback WHERE user_id = ?').bind(userId),
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
