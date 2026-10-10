import type { Env } from '../../_lib/env';
import { downloadRange } from '../../_lib/downloads';
import { requireAdmin } from '../../_lib/session';
import { error, json } from '../../_lib/http';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const admin = await requireAdmin(env.DB, request);
  if ('response' in admin) return admin.response;
  const range = downloadRange(new URL(request.url).searchParams);
  if (!range) return error(400, 'invalid_query');
  const { from, to, app } = range;
  const query = env.DB.prepare(`SELECT day, app_id, SUM(requests) AS requests FROM download_daily
    WHERE day >= ? AND day <= ? ${app ? 'AND app_id = ?' : ''}
    GROUP BY day, app_id ORDER BY day DESC, app_id`);
  const rows = await (app ? query.bind(from, to, app) : query.bind(from, to)).all();
  const versionsQuery = env.DB.prepare(`SELECT app_id, version, SUM(requests) AS requests FROM download_daily
    WHERE day >= ? AND day <= ? ${app ? 'AND app_id = ?' : ''}
    GROUP BY app_id, version ORDER BY requests DESC, app_id, version`);
  const versions = await (app ? versionsQuery.bind(from, to, app) : versionsQuery.bind(from, to)).all();
  const meta = await env.DB.prepare('SELECT started_at FROM download_stats_meta WHERE id = 1')
    .first<{ started_at: number }>();
  return json({ timezone: 'Asia/Shanghai', metric: 'download_initiations', startedAt: meta?.started_at ?? null,
    ...range, rows: rows.results, versions: versions.results });
};
