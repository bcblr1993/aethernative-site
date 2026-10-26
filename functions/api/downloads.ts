import type { Env } from '../_lib/env';
import { error, json } from '../_lib/http';

/** Public lifetime aggregates. No user, daily or version-level data is exposed. */
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  try {
    const [{ results }, meta] = await Promise.all([
      env.DB.prepare('SELECT app_id AS appId, SUM(requests) AS total FROM download_daily GROUP BY app_id ORDER BY app_id').all(),
      env.DB.prepare('SELECT started_at FROM download_stats_meta WHERE id = 1').first<{ started_at: number }>(),
    ]);
    if (!meta) return error(503, 'download_stats_unavailable');
    const response = json({ metric: 'download_initiations', startedAt: meta.started_at, apps: results });
    response.headers.set('Cache-Control', 'public, max-age=60');
    return response;
  } catch {
    return error(503, 'download_stats_unavailable');
  }
};
