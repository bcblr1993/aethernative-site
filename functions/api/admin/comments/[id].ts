import type { Env } from '../../../_lib/env';
import { communityBody } from '../../../_lib/community';
import { error, isSameOrigin, json } from '../../../_lib/http';
import { requireAdmin } from '../../../_lib/session';
export const onRequestPatch: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  if (!isSameOrigin(request)) return error(403, 'bad_origin');
  const admin = await requireAdmin(env.DB, request);
  if ('response' in admin) return admin.response;
  if (typeof params.id !== 'string' || params.id.length > 64) return error(404, 'not_found');
  const body = await communityBody(request);
  if (body.response) return body.response;
  const status = body.value?.status;
  if (typeof status !== 'string' || !['pending', 'approved', 'hidden'].includes(status)) return error(400, 'invalid');
  const row = await env.DB.prepare('UPDATE app_comments SET status = ?, updated_at = ? WHERE id = ? RETURNING id, status').bind(status, Date.now(), params.id).first();
  return row ? json(row) : error(404, 'not_found');
};
