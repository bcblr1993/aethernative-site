import type { Env } from '../../../_lib/env';
import { getUser, hasBearer, requireAdmin } from '../../../_lib/session';
import { error, isSameOrigin, json } from '../../../_lib/http';
import { readJson } from '../../../_lib/push-auth';

export const onRequestPatch: PagesFunction<Env> = async ({ request, env, params }) => {
  if (!hasBearer(request) && !isSameOrigin(request)) return error(403, 'bad_origin');
  const admin = await requireAdmin(env.DB, request);
  if ('response' in admin) return admin.response;
  const parsed = await readJson(request, 1024);
  if (!parsed.ok) return parsed.response;
  const input = parsed.value;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => k !== 'action')) return error(400, 'invalid');
  const action = (input as { action?: unknown }).action;
  if (!['disable', 'enable', 'revoke_sessions'].includes(action as string)) return error(400, 'invalid');
  const target = await getUser(env.DB, String(params.id));
  if (!target) return error(404, 'not_found');
  if (target.id === admin.user.id || target.is_admin === 1) return error(409, 'protected_admin');
  const statements: D1PreparedStatement[] = [];
  if (action === 'disable') statements.push(env.DB.prepare('UPDATE users SET disabled_at = COALESCE(disabled_at, ?) WHERE id = ? AND is_admin = 0').bind(Date.now(), target.id));
  if (action === 'enable') statements.push(env.DB.prepare('UPDATE users SET disabled_at = NULL WHERE id = ? AND is_admin = 0').bind(target.id));
  // 清除网页/App 会话和登录中的一次性 code；恢复不会让旧凭据重新生效。
  statements.push(
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.id),
    env.DB.prepare('DELETE FROM auth_codes WHERE user_id = ?').bind(target.id),
  );
  await env.DB.batch(statements);
  return json({ ok: true });
};
