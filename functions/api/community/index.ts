import type { Env } from '../../_lib/env';
import { json } from '../../_lib/http';
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const { results } = await env.DB.prepare('SELECT app_id AS appId, SUM(liked) AS likes, COUNT(rating) AS ratings, ROUND(AVG(rating),1) AS average FROM app_votes GROUP BY app_id').all();
  return json({ apps: results });
};
