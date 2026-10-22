import type { Env } from '../../_lib/env';
import { communityBody, communityIdentity } from '../../_lib/community';
import { error, isSameOrigin, json } from '../../_lib/http';

// Derive recipients from the parent comment, never from client-supplied identities.
const incoming = `FROM app_comments c
  JOIN app_comments p ON p.id = c.parent_id AND p.app_id = c.app_id
  JOIN app_comments root ON root.id = c.thread_id AND root.app_id = c.app_id
  WHERE ((p.user_id IS NOT NULL AND p.user_id = ?) OR (p.user_id IS NULL AND p.visitor_hash = ?))
    AND ((p.user_id IS NOT NULL AND (c.user_id IS NULL OR c.user_id <> p.user_id)) OR (p.user_id IS NULL AND c.visitor_hash <> p.visitor_hash))
    AND c.status = 'approved' AND p.status = 'approved' AND root.status = 'approved'
    AND NOT EXISTS (SELECT 1 FROM app_reply_reads r WHERE r.reply_id = c.id)`;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = await communityIdentity(env.DB, request);
  if (!who.hash && !who.user) return json({ count: 0, notifications: [] });
  const [count, rows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS count ${incoming}`).bind(who.user?.id ?? '', who.hash ?? '').first<{ count: number }>(),
    env.DB.prepare(`SELECT c.id, c.app_id, c.body, c.created_at, p.body AS parent_body ${incoming} ORDER BY c.created_at DESC, c.id DESC LIMIT 20`)
      .bind(who.user?.id ?? '', who.hash ?? '').all<{ id: string; app_id: string; body: string; created_at: number; parent_body: string }>(),
  ]);
  return json({ count: count?.count ?? 0, notifications: rows.results.map(r => ({
    id: r.id, appId: r.app_id, body: r.body, parentBody: r.parent_body, createdAt: r.created_at,
    href: `/apps/${encodeURIComponent(r.app_id)}/?focus=${encodeURIComponent(r.id)}#reviews`,
  })) });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!isSameOrigin(request)) return error(403, 'bad_origin');
  const who = await communityIdentity(env.DB, request);
  if (!who.hash && !who.user) return error(428, 'visitor_required');
  const body = await communityBody(request);
  if (body.response) return body.response;
  const ids = body.value?.ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20 || ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(id))) return error(400, 'invalid');
  // Only mark the supplied snapshot as read; replies arriving later stay unread.
  await env.DB.prepare(`INSERT INTO app_reply_reads (reply_id, read_at) SELECT c.id, ? ${incoming} AND c.id IN (${ids.map(() => '?').join(',')}) ON CONFLICT(reply_id) DO NOTHING`)
    .bind(Date.now(), who.user?.id ?? '', who.hash ?? '', ...ids).run();
  return json({ ok: true });
};
