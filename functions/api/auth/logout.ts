// POST /api/auth/logout —— 删除当前会话。
import type { Env } from '../../_lib/env';
import { error, isSameOrigin } from '../../_lib/http';
import { clearSessionCookies, deleteSession } from '../../_lib/session';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!isSameOrigin(request)) return error(403, 'bad_origin');
  await deleteSession(env.DB, request);
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  for (const c of clearSessionCookies()) headers.append('Set-Cookie', c);
  return new Response(null, { status: 204, headers });
};
