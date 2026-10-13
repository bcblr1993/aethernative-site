import type { Env } from '../../../_lib/env';
import { requireAdmin } from '../../../_lib/session';
import { error, json } from '../../../_lib/http';
import { listUsers, parseUserQuery } from '../../../_lib/admin-users';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const admin = await requireAdmin(env.DB, request);
  if ('response' in admin) return admin.response;
  const query = parseUserQuery(new URL(request.url).searchParams);
  if (!query) return error(400, 'invalid_query');
  return json({ ...await listUsers(env.DB, query), currentUserId: admin.user.id });
};
