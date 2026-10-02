// GET /api/admin/push-targets?kind=news | kind=release&app=<id>&channel=stable|beta [&cursor=<上一页 next>]
// 推送服务按条目查询目标设备（只含开启了通知的设备），按 id 分页，每页 500 条。
import { findTargets, parseTargetQuery } from '../../_lib/devices';
import type { Env } from '../../_lib/env';
import { error, json } from '../../_lib/http';
import { requirePushService } from '../../_lib/push-auth';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const denied = await requirePushService(request, env);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const q = parseTargetQuery(params);
  if (!q) return error(400, 'invalid_query');
  const cursor = params.get('cursor') ?? '';
  if (cursor.length > 64) return error(400, 'invalid_query');
  return json(await findTargets(env.DB, q, cursor));
};
