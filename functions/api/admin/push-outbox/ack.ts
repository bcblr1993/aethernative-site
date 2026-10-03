// POST /api/admin/push-outbox/ack —— 推送服务确认任务已发送：{ ids: [...], invalidTokens?: [...] }（PUSH_SERVICE_TOKEN）。
import { removeTokens } from '../../../_lib/devices';
import type { Env } from '../../../_lib/env';
import { error, json } from '../../../_lib/http';
import { ackJobs } from '../../../_lib/outbox';
import { readJson, requirePushService } from '../../../_lib/push-auth';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const denied = await requirePushService(request, env);
  if (denied) return denied;
  const body = await readJson(request, 128 * 1024);
  if (!body.ok) return body.response;
  const o = (body.value && typeof body.value === 'object' ? body.value : {}) as Record<string, unknown>;
  const ids = o.ids ?? [];
  const invalid = o.invalidTokens ?? [];
  const strings = (v: unknown, max: number) => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.length <= 256);
  if (!strings(ids, 200) || !strings(invalid, 1000)) return error(400, 'invalid');
  const acked = await ackJobs(env.DB, ids as string[]);
  const { removed } = await removeTokens(env.DB, invalid as string[]);
  return json({ acked, removed });
};
