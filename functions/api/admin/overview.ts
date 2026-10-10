import type { Env } from '../../_lib/env';
import { requireAdmin } from '../../_lib/session';
import { json } from '../../_lib/http';
import { beijingDay } from '../../_lib/downloads';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const admin = await requireAdmin(env.DB, request);
  if ('response' in admin) return admin.response;
  const today = beijingDay();
  const since = beijingDay(Date.now() - 6 * 86400_000);
  const downloads = await env.DB.prepare(`SELECT COALESCE(SUM(CASE WHEN day = ? THEN requests ELSE 0 END),0) AS today,
    COALESCE(SUM(requests),0) AS week FROM download_daily WHERE day >= ? AND day <= ?`).bind(today, since, today).first();
  const feedback = await env.DB.prepare("SELECT COUNT(*) AS pending FROM feedback WHERE status IN ('new','triaged')").first();
  return json({ downloads, feedback, today, timezone: 'Asia/Shanghai' });
};
