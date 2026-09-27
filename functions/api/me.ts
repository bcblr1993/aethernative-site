// GET /api/me —— 当前登录用户；DELETE /api/me —— 注销账号并删除全部数据。
import type { Env } from '../_lib/env';
import { error, isSameOrigin, json } from '../_lib/http';
import { clearSessionCookies, deleteUser, getProviders, getSessionUser, publicUser } from '../_lib/session';

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
  if (!isSameOrigin(request)) return error(403, 'bad_origin');
  const user = await getSessionUser(env.DB, request);
  if (!user) return signedOut();
  await deleteUser(env.DB, user.id);
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  for (const c of clearSessionCookies()) headers.append('Set-Cookie', c);
  return new Response(null, { status: 204, headers });
};
