// POST /api/admin/push-outbox/claim —— 推送服务领取待发任务（PUSH_SERVICE_TOKEN）。每个任务附带目标设备与通知内容。
import type { Env } from '../../../_lib/env';
import { json } from '../../../_lib/http';
import { claimJobs } from '../../../_lib/outbox';
import { requirePushService } from '../../../_lib/push-auth';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const denied = await requirePushService(request, env);
  if (denied) return denied;
  return json({ jobs: await claimJobs(env.DB) });
};
