// iPhone App 登录的公共部分：回调地址、一次性 code、登录成功后的响应。
import { pkceChallenge, randomToken, sha256Hex } from './crypto';
import { json } from './http';
import { createAppSession, getProviders, publicUser, type User } from './session';

/** App 内网页登录完成后跳回 App 的地址（ASWebAuthenticationSession 拦截这个 scheme） */
export const APP_CALLBACK = 'aethernative://auth/callback';
export const AUTH_CODE_TTL_MS = 120_000;
/** PKCE（RFC 7636）：verifier 43–128 个字符；challenge 为其 SHA-256 的 base64url（43 个字符） */
export const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
export const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export const appRedirect = (params: Record<string, string>) => `${APP_CALLBACK}?${new URLSearchParams(params)}`;

/** 网页登录成功后发给 App 的一次性 code（只存哈希，2 分钟有效）。 */
export async function issueAuthCode(db: D1Database, userId: string, challenge: string, now = Date.now()) {
  const code = randomToken();
  await db.batch([
    db.prepare('DELETE FROM auth_codes WHERE expires_at < ?').bind(now),
    db.prepare('INSERT INTO auth_codes (code_hash, user_id, challenge, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256Hex(code), userId, challenge, now + AUTH_CODE_TTL_MS),
  ]);
  return code;
}

/** 用 code + verifier 换取用户 ID。code 无论成功与否都只能用一次（DELETE … RETURNING 保证原子性）。 */
export async function redeemAuthCode(db: D1Database, code: string, verifier: string, now = Date.now()) {
  const row = await db
    .prepare('DELETE FROM auth_codes WHERE code_hash = ? RETURNING user_id, challenge, expires_at')
    .bind(await sha256Hex(code))
    .first<{ user_id: string; challenge: string; expires_at: number }>();
  if (!row || row.expires_at < now) return null;
  if ((await pkceChallenge(verifier)) !== row.challenge) return null;
  return row.user_id;
}

/** 登录成功：新建 App 会话，返回令牌与用户资料。 */
export async function signedInResponse(db: D1Database, user: User, userAgent: string | null) {
  const { token, expiresAt } = await createAppSession(db, user.id, userAgent);
  return json({ token, expiresAt, user: publicUser(user, await getProviders(db, user.id)) });
}
