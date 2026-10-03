// PATCH /api/admin/feedback/:id —— 管理员修改状态 / 回复：{ status?, reply? }（需 is_admin）。
// 回复内容有变化时自动设为“已回复”，并给提交者关联的设备排一条推送（push_outbox）。
import type { Env } from '../../../_lib/env';
import { publicFeedback, updateFeedbackAdmin, validateAdminUpdate } from '../../../_lib/feedback';
import { error, isSameOrigin, json } from '../../../_lib/http';
import { enqueueFeedbackReply } from '../../../_lib/outbox';
import { readJson } from '../../../_lib/push-auth';
import { hasBearer, requireAdmin } from '../../../_lib/session';

export const onRequestPatch: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  if (!hasBearer(request) && !isSameOrigin(request)) return error(403, 'bad_origin');
  const admin = await requireAdmin(env.DB, request);
  if ('response' in admin) return admin.response;
  if (typeof params.id !== 'string' || params.id.length > 64) return error(404, 'not_found');

  const body = await readJson(request, 32 * 1024);
  if (!body.ok) return body.response;
  const v = validateAdminUpdate(body.value);
  if (!v.ok) return error(400, 'invalid');

  const r = await updateFeedbackAdmin(env.DB, params.id, v.value);
  if (!r) return error(404, 'not_found');
  const notified = r.replied ? await enqueueFeedbackReply(env.DB, r.row) : false;
  return json({ feedback: publicFeedback(r.row), notified });
};
