// POST /api/feedback —— 提交反馈（需登录）。
import type { Env } from '../../_lib/env';
import { insertFeedback, LIMITS, publicFeedback, rateLimited, validateFeedback } from '../../_lib/feedback';
import { error, isSameOrigin, json } from '../../_lib/http';
import { getSessionUser } from '../../_lib/session';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!isSameOrigin(request)) return error(403, 'bad_origin');
  // 只接受 JSON：跨站的普通表单无法发送这种类型，多一层 CSRF 防护
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return error(415, 'unsupported_media_type');

  const user = await getSessionUser(env.DB, request);
  if (!user) return error(401, 'unauthenticated');

  const text = await request.text();
  if (new TextEncoder().encode(text).length > LIMITS.requestBytes) return error(413, 'too_large');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return error(400, 'bad_json');
  }

  const v = validateFeedback(raw);
  if (!v.ok) return json({ error: 'invalid', fields: v.fields }, 400);

  const wait = await rateLimited(env.DB, user.id);
  if (wait !== null) return error(429, 'rate_limited', { 'Retry-After': String(Math.max(1, wait)) });

  const row = await insertFeedback(env.DB, user.id, v.value);
  return json({ feedback: publicFeedback(row) }, 201);
};
