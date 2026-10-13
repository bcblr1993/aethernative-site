import type { Env } from '../../../_lib/env';
import { error } from '../../../_lib/http';
import { getSessionUser } from '../../../_lib/session';

/** 图片始终通过鉴权接口读取；不暴露公共静态资源地址。 */
export const onRequestGet: PagesFunction<Env> = async ({ request, env, params }) => {
  const user = await getSessionUser(env.DB, request);
  if (!user) return error(401, 'unauthenticated');
  const row = await env.DB.prepare(
    `SELECT s.mime, s.data FROM feedback_screenshots s JOIN feedback f ON f.id = s.feedback_id
     WHERE s.id = ? AND (f.user_id = ? OR ? = 1)`,
  ).bind(String(params.id), user.id, user.is_admin).first<{ mime: string; data: number[] | ArrayBuffer }>();
  if (!row) return error(404, 'not_found');
  return new Response(new Uint8Array(row.data), { headers: {
    'Content-Type': row.mime,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
  } });
};
