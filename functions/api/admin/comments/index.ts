import type { Env } from '../../../_lib/env';
import { cursor, listComments, pendingComments } from '../../../_lib/community';
import { error, json } from '../../../_lib/http';
import { requireAdmin } from '../../../_lib/session';
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const admin = await requireAdmin(env.DB, request);
  if ('response' in admin) return admin.response;
  const q = new URL(request.url).searchParams;
  const status = q.get('status') ?? 'pending';
  const app = q.get('app') ?? '';
  const after = cursor(q.get('cursor'));
  if (!['pending', 'approved', 'hidden'].includes(status) || (app && !/^[a-z0-9-]{1,64}$/.test(app)) || after === false) return error(400, 'invalid');
  return json({ ...await listComments(env.DB, app, status, after), pending: await pendingComments(env.DB) });
};
