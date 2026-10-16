import type { Env } from '../../_lib/env';
import { beijingDay, validApp } from '../../_lib/downloads';
import { error, json } from '../../_lib/http';
import { requireAdmin } from '../../_lib/session';

/** Aggregate existing records only: never return account identifiers or review/feedback text. */
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const admin = await requireAdmin(env.DB, request);
  if ('response' in admin) return admin.response;
  const q = new URL(request.url).searchParams;
  const days = Number(q.get('days') ?? 30);
  const app = q.get('app') ?? '';
  if (![7, 30, 90].includes(days) || (app && !validApp(app))) return error(400, 'invalid_query');
  const now = Date.now(), to = beijingDay(now), from = beijingDay(now - (days - 1) * 86400_000);
  const start = Date.parse(`${from}T00:00:00+08:00`), end = Date.parse(`${to}T00:00:00+08:00`) + 86400_000;
  const filter = app ? ' AND app_id = ?' : '';
  const appArgs = app ? [app] : [];
  const args = [start, end, ...appArgs];
  const all = (sql: string, args: (string | number)[] = []) => env.DB.prepare(sql).bind(...args).all();
  const [downloads, versions, usersDaily, users, providers, feedbackDaily, feedbackStatus, feedbackCategory,
    commentsStatus, votes, stars, pendingFeedback, pendingComments, meta] = await Promise.all([
    all(`SELECT day, app_id, SUM(requests) AS requests FROM download_daily WHERE day >= ? AND day <= ?${filter} GROUP BY day, app_id ORDER BY day`, [from, to, ...appArgs]),
    all(`SELECT app_id, version, SUM(requests) AS requests FROM download_daily WHERE day >= ? AND day <= ?${filter} GROUP BY app_id, version ORDER BY requests DESC, app_id, version LIMIT 12`, [from, to, ...appArgs]),
    all("SELECT strftime('%Y-%m-%d', created_at / 1000 + 28800, 'unixepoch') AS day, COUNT(*) AS count FROM users WHERE created_at >= ? AND created_at < ? GROUP BY day ORDER BY day", [start, end]),
    env.DB.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(created_at >= ? AND created_at < ?),0) AS added,
      COALESCE(SUM(disabled_at IS NOT NULL),0) AS disabled,
      COALESCE(SUM(last_login_at >= ? AND last_login_at < ?),0) AS recentLogin FROM users`).bind(start, end, start, end).first(),
    all('SELECT provider AS label, COUNT(DISTINCT user_id) AS count FROM identities GROUP BY provider ORDER BY count DESC'),
    all(`SELECT strftime('%Y-%m-%d', created_at / 1000 + 28800, 'unixepoch') AS day, COUNT(*) AS count FROM feedback WHERE created_at >= ? AND created_at < ?${filter} GROUP BY day ORDER BY day`, args),
    all(`SELECT status AS label, COUNT(*) AS count FROM feedback WHERE created_at >= ? AND created_at < ?${filter} GROUP BY status`, args),
    all(`SELECT category AS label, COUNT(*) AS count FROM feedback WHERE created_at >= ? AND created_at < ?${filter} GROUP BY category`, args),
    all(`SELECT status AS label, COUNT(*) AS count FROM app_comments WHERE created_at >= ? AND created_at < ?${filter} GROUP BY status`, args),
    all(`SELECT app_id AS appId, SUM(liked) AS likes, COUNT(rating) AS ratings, ROUND(AVG(rating),1) AS average FROM app_votes WHERE 1=1${filter} GROUP BY app_id ORDER BY likes DESC, ratings DESC, app_id`, appArgs),
    all(`SELECT rating AS label, COUNT(*) AS count FROM app_votes WHERE rating IS NOT NULL${filter} GROUP BY rating ORDER BY rating DESC`, appArgs),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM feedback WHERE status IN ('new','triaged')${filter}`).bind(...appArgs).first(),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM app_comments WHERE status = 'pending'${filter}`).bind(...appArgs).first(),
    env.DB.prepare('SELECT started_at FROM download_stats_meta WHERE id = 1').first<{ started_at: number }>(),
  ]);
  return json({ from, to, days, app, timezone: 'Asia/Shanghai', generatedAt: now,
    downloads: { rows: downloads.results, versions: versions.results, startedAt: meta?.started_at ?? null },
    users: { ...users, daily: usersDaily.results, providers: providers.results },
    feedback: { daily: feedbackDaily.results, statuses: feedbackStatus.results, categories: feedbackCategory.results, pending: pendingFeedback },
    community: { comments: commentsStatus.results, votes: votes.results, stars: stars.results, pending: pendingComments },
  });
};
