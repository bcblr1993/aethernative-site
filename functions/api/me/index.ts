// GET /api/me —— 当前登录用户；PATCH /api/me —— 修改昵称 { name }；DELETE /api/me —— 注销账号并删除全部数据。
import type { Env } from '../../_lib/env';
import { pendingComments } from '../../_lib/community';
import { pendingFeedback } from '../../_lib/feedback';
import { appleConfig, decryptToken, revokeToken } from '../../_lib/apple';
import { error, isSameOrigin, json, parseCookies } from '../../_lib/http';
import { readJson } from '../../_lib/push-auth';
import { authenticate, refreshWebSession, LAST_LOGIN_COOKIE, lastLoginCookie, cleanName, clearSessionCookies, deleteUser, getProviders, getSessionUser, hasBearer, publicUser, updateName } from '../../_lib/session';

const signedOut = () => {
  // 无效会话清理会话和辅助标记；保留上次成功登录方式。
  const headers = new Headers();
  for (const c of clearSessionCookies()) headers.append('Set-Cookie', c);
  return error(401, 'unauthenticated', headers);
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await authenticate(env.DB, request);
  if (!auth) return signedOut();
  const { user } = auth;
  const providers = await getProviders(env.DB, user.id);
  const headers = new Headers();
  for (const cookie of await refreshWebSession(env.DB, request, auth)) headers.append('Set-Cookie', cookie);
  // 旧会话只有一个登录身份时，可以准确补上提示；多个身份时不猜测。
  if (auth.via === 'cookie' && !parseCookies(request.headers.get('Cookie'))[LAST_LOGIN_COOKIE] && providers.length === 1 && (providers[0] === 'google' || providers[0] === 'github')) {
    headers.append('Set-Cookie', lastLoginCookie(providers[0]));
  }
  return json({ user: {
    ...publicUser(user, providers),
    isAdmin: user.is_admin === 1,
    ...(user.is_admin === 1 ? { adminFeedback: await pendingFeedback(env.DB), adminComments: await pendingComments(env.DB) } : {}),
  } }, 200, headers);
};

export const onRequestPatch: PagesFunction<Env> = async ({ request, env }) => {
  if (!hasBearer(request) && !isSameOrigin(request)) return error(403, 'bad_origin');
  const user = await getSessionUser(env.DB, request);
  if (!user) return signedOut();
  const body = await readJson(request, 2 * 1024);
  if (!body.ok) return body.response;
  const name = cleanName((body.value as Record<string, unknown> | null)?.name);
  if (!name) return json({ error: 'invalid', fields: ['name'] }, 400);
  const updated = await updateName(env.DB, user.id, name);
  return json({ user: publicUser(updated, await getProviders(env.DB, user.id)) });
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
