// GET /api/admin/feedback?status=new|triaged|replied|closed&before=<created_at> —— 管理员查看全部反馈（需 is_admin）。
import type { Env } from '../../../_lib/env';
import { adminFeedback, listAllFeedback, STATUSES, type Status } from '../../../_lib/feedback';
import { error, json } from '../../../_lib/http';
import { requireAdmin } from '../../../_lib/session';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const admin = await requireAdmin(env.DB, request);
  if ('response' in admin) return admin.response;
  const p = new URL(request.url).searchParams;
  const status = p.get('status') || undefined;
  if (status && !STATUSES.includes(status as Status)) return error(400, 'invalid_query');
  const before = p.get('before') ? Number(p.get('before')) : undefined;
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) return error(400, 'invalid_query');
  const beforeId = p.get('beforeId') || undefined;
  if (beforeId && (before === undefined || !/^[a-zA-Z0-9-]{1,128}$/.test(beforeId))) return error(400, 'invalid_query');
  const userId = p.get('user') || undefined;
  const appId = p.get('app') || undefined;
  if ((userId && userId.length > 128) || (appId && !/^[a-z0-9-]{1,40}$/.test(appId))) return error(400, 'invalid_query');
  const { rows, next, nextId } = await listAllFeedback(env.DB, { status: status as Status | undefined, before, beforeId, userId, appId });
  return json({ feedback: rows.map(adminFeedback), next, nextId });
};
