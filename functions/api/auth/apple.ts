// POST /api/auth/apple —— iPhone App 用 Apple 登录。
// { identityToken, authorizationCode, nonce（原始随机数）, name?: { givenName, familyName } }
// 校验 identity token → 用 authorization code 换取 refresh token（注销时撤销授权用）→ 建立 App 会话。
import { appleConfig, encryptToken, exchangeCode, verifyIdentityToken } from '../../_lib/apple';
import { signedInResponse } from '../../_lib/app-auth';
import type { Env } from '../../_lib/env';
import { error } from '../../_lib/http';
import { readJson } from '../../_lib/push-auth';
import { upsertUser } from '../../_lib/session';

const str = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
const namePart = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 50) : '');

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const cfg = appleConfig(env);
  if (!cfg) return error(503, 'apple_not_configured');
  const body = await readJson(request, 16 * 1024);
  if (!body.ok) return body.response;
  const o = (body.value && typeof body.value === 'object' ? body.value : {}) as Record<string, unknown>;
  const identityToken = str(o.identityToken, 4096);
  const authorizationCode = str(o.authorizationCode, 1024);
  const nonce = str(o.nonce, 256);
  if (!identityToken || !authorizationCode || !nonce) return error(400, 'invalid');

  let identity;
  try {
    identity = await verifyIdentityToken(identityToken, { bundleId: cfg.bundleId, rawNonce: nonce });
  } catch (e) {
    console.warn('Apple identity token 校验失败', e instanceof Error ? e.message : e);
    return error(401, 'invalid_token');
  }

  // 先换 refresh token 再建用户：换不到就无法在注销时撤销授权，宁可登录失败
  let refreshToken: string;
  try {
    refreshToken = await exchangeCode(cfg, authorizationCode);
  } catch (e) {
    console.error('Apple 换取 refresh token 失败', e instanceof Error ? e.message : e);
    return error(502, 'apple_exchange_failed');
  }

  // Apple 只在首次授权时提供姓名；之后登录保留已有昵称，不被默认值覆盖
  const n = (o.name && typeof o.name === 'object' ? o.name : {}) as Record<string, unknown>;
  const given = namePart(n.givenName), family = namePart(n.familyName);
  const provided = /[一-鿿]/.test(given + family) ? `${family}${given}` : `${given} ${family}`.trim();
  const existing = await env.DB
    .prepare("SELECT u.name FROM identities i JOIN users u ON u.id = i.user_id WHERE i.provider = 'apple' AND i.provider_user_id = ?")
    .bind(identity.sub)
    .first<{ name: string }>();
  const name = provided || existing?.name || identity.email || 'Apple 用户';

  const user = await upsertUser(env.DB, { provider: 'apple', id: identity.sub, name, email: identity.email, avatarUrl: null });
  await env.DB.prepare("UPDATE identities SET apple_refresh_token = ? WHERE provider = 'apple' AND provider_user_id = ?")
    .bind(await encryptToken(cfg, refreshToken), identity.sub)
    .run();
  return signedInResponse(env.DB, user, request.headers.get('User-Agent'));
};
