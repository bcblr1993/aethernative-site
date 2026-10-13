// POST /api/feedback —— 提交反馈（需登录）。
import { boundedBody, readScreenshots, SCREENSHOT_LIMITS, type Screenshot } from '../../_lib/feedback-screenshots';
import type { Env } from '../../_lib/env';
import { insertFeedback, LIMITS, publicFeedback, rateLimited, validateFeedback } from '../../_lib/feedback';
import { error, isSameOrigin, json } from '../../_lib/http';
import { getSessionUser, hasBearer } from '../../_lib/session';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  // App 使用 Bearer 凭证，没有 CSRF 风险；网页 Cookie 请求仍要求同源
  if (!hasBearer(request) && !isSameOrigin(request)) return error(403, 'bad_origin');
  const contentType = request.headers.get('Content-Type') ?? '';
  const media = contentType.split(';')[0].trim().toLowerCase();
  const multipart = media === 'multipart/form-data';
  if (!multipart && media !== 'application/json') return error(415, 'unsupported_media_type');

  const user = await getSessionUser(env.DB, request);
  if (!user) return error(401, 'unauthenticated');
  const wait = await rateLimited(env.DB, user.id);
  if (wait !== null) return error(429, 'rate_limited', { 'Retry-After': String(Math.max(1, wait)) });

  const bytes = await boundedBody(request, LIMITS.requestBytes + (multipart ? SCREENSHOT_LIMITS.count * SCREENSHOT_LIMITS.bytes : 0));
  if (!bytes) return error(413, 'too_large');
  let raw: unknown;
  let screenshots: Screenshot[] = [];
  try {
    if (multipart) {
      const data = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData();
      raw = Object.fromEntries([...data].filter(([key]) => key !== 'screenshots'));
      const images = await readScreenshots(data.getAll('screenshots'));
      if (!images) return json({ error: 'invalid', fields: ['screenshots'] }, 400);
      screenshots = images;
    } else {
      raw = JSON.parse(new TextDecoder().decode(bytes));
    }
  } catch {
    return error(400, multipart ? 'bad_form' : 'bad_json');
  }

  const v = validateFeedback(raw);
  if (!v.ok) return json({ error: 'invalid', fields: v.fields }, 400);

  const row = await insertFeedback(env.DB, user.id, v.value, Date.now(), screenshots);
  return json({ feedback: publicFeedback(row) }, 201);
};
