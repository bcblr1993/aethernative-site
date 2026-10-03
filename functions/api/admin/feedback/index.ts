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
  if (before !== undefined && !Number.isFinite(before)) return error(400, 'invalid_query');
  const { rows, next } = await listAllFeedback(env.DB, { status: status as Status | undefined, before });
  return json({ feedback: rows.map(adminFeedback), next });
};
