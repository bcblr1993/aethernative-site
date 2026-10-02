// GET /api/me —— 当前登录用户；DELETE /api/me —— 注销账号并删除全部数据。
import type { Env } from '../../_lib/env';
import { appleConfig, decryptToken, revokeToken } from '../../_lib/apple';
import { error, isSameOrigin, json } from '../../_lib/http';
import { clearSessionCookies, deleteUser, getProviders, getSessionUser, hasBearer, publicUser } from '../../_lib/session';

const signedOut = () => {
  // 顺带清掉“可能已登录”标记，页面之后就不会再请求本接口
  const headers = new Headers();
  for (const c of clearSessionCookies()) headers.append('Set-Cookie', c);
  return error(401, 'unauthenticated', headers);
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const user = await getSessionUser(env.DB, request);
  if (!user) return signedOut();
  return json({ user: publicUser(user, await getProviders(env.DB, user.id)) });
};

export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  // App 使用 Bearer 凭证，没有 CSRF 风险；网页 Cookie 请求仍要求同源
  if (!hasBearer(request) && !isSameOrigin(request)) return error(403, 'bad_origin');
  const user = await getSessionUser(env.DB, request);
  if (!user) return signedOut();
  await revokeAppleTokens(env, user.id);
  await deleteUser(env.DB, user.id);
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  for (const c of clearSessionCookies()) headers.append('Set-Cookie', c);
  return new Response(null, { status: 204, headers });
};

/**
 * 用 Apple 登录过的账号，注销时调用 Apple 的撤销接口（App Store 审核规则 5.1.1(v)）。
 * 撤销失败（网络等）只记录日志，不阻止删除：用户要求删除的数据必须删除。
 */
async function revokeAppleTokens(env: Env, userId: string) {
  const { results } = await env.DB
    .prepare("SELECT apple_refresh_token FROM identities WHERE user_id = ? AND provider = 'apple' AND apple_refresh_token IS NOT NULL")
    .bind(userId)
    .all<{ apple_refresh_token: string }>();
  if (!results.length) return;
  const cfg = appleConfig(env);
  if (!cfg) {
    console.error('注销账号：缺少 Apple 配置，无法撤销授权', userId);
    return;
  }
  for (const r of results) {
    try {
      await revokeToken(cfg, await decryptToken(cfg, r.apple_refresh_token));
    } catch (e) {
      console.error('注销账号：撤销 Apple 授权失败', userId, e instanceof Error ? e.message : e);
    }
  }
}
