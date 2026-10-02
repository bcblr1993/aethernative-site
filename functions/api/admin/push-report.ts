// POST /api/admin/push-report —— 推送服务回报：删除 APNs 判定失效的 token，记录心跳与上一轮统计。
// { "invalidTokens": ["…"], "status": { …任意统计，原样保存… } }
import { removeTokens } from '../../_lib/devices';
import type { Env } from '../../_lib/env';
import { error, json } from '../../_lib/http';
import { readJson, requirePushService } from '../../_lib/push-auth';

const MAX_BYTES = 128 * 1024;
const MAX_TOKENS = 1000;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const denied = await requirePushService(request, env);
  if (denied) return denied;
  const body = await readJson(request, MAX_BYTES);
  if (!body.ok) return body.response;

  const o = (body.value && typeof body.value === 'object' ? body.value : {}) as Record<string, unknown>;
  const tokens = o.invalidTokens ?? [];
  if (!Array.isArray(tokens) || tokens.length > MAX_TOKENS || !tokens.every((t) => typeof t === 'string')) {
    return error(400, 'invalid');
  }
  const status = o.status === undefined ? null : JSON.stringify(o.status).slice(0, 4000);

  const r = await removeTokens(env.DB, tokens as string[]);
  await env.DB.prepare(
    `INSERT INTO push_status (id, last_seen_at, detail) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET last_seen_at = excluded.last_seen_at, detail = COALESCE(excluded.detail, push_status.detail)`,
  ).bind(Date.now(), status).run();
  return json(r);
};
