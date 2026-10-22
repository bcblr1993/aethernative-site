import type { Env } from '../../_lib/env';
import { allowWrite, communityBody, communityIdentity, cursor, knownApp, listComments, summary, visitor } from '../../_lib/community';
import { error, isSameOrigin, json } from '../../_lib/http';

export const onRequestGet: PagesFunction<Env, 'app'> = async ({ request, env, params }) => {
  if (!await knownApp(env, request, params.app)) return error(404, 'not_found');
  const app = params.app as string;
  const after = cursor(new URL(request.url).searchParams.get('cursor'));
  if (after === false) return error(400, 'invalid_cursor');
  const thread = new URL(request.url).searchParams.get('thread');
  const focus = new URL(request.url).searchParams.get('focus');
  let rootId: string | undefined;
  if (focus !== null) {
    if (thread !== null || after || !/^[a-zA-Z0-9-]{1,64}$/.test(focus)) return error(400, 'invalid');
    const target = await env.DB.prepare(`SELECT c.id, c.thread_id FROM app_comments c WHERE c.id = ? AND c.app_id = ? AND c.status = 'approved'
      AND (c.thread_id IS NULL OR EXISTS (SELECT 1 FROM app_comments root WHERE root.id = c.thread_id AND root.status = 'approved' AND root.app_id = c.app_id))`)
      .bind(focus, app).first<{ id: string; thread_id: string | null }>();
    if (!target) return error(404, 'not_found');
    rootId = target.thread_id ?? target.id;
  }
  if (thread !== null) {
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(thread)) return error(400, 'invalid');
    const root = await env.DB.prepare("SELECT id FROM app_comments WHERE id = ? AND app_id = ? AND status = 'approved' AND thread_id IS NULL").bind(thread, app).first();
    if (!root) return error(404, 'not_found');
  }
  const who = await communityIdentity(env.DB, request, true);
  const [mine, comments, stats] = await Promise.all([
    env.DB.prepare('SELECT liked, rating FROM app_votes WHERE app_id = ? AND visitor_hash = ?').bind(app, who.hash).first<{ liked: number; rating: number | null }>(),
    listComments(env.DB, app, 'approved', after, { thread: thread ?? undefined, rootId, highlightId: focus ?? undefined, voterKey: who.voterKey ?? undefined }), summary(env.DB, app),
  ]);
  return json({ ...comments, summary: stats, mine: { liked: Boolean(mine?.liked), rating: mine?.rating ?? null } }, 200, who.cookie ? { 'Set-Cookie': who.cookie } : {});
};

export const onRequestPost: PagesFunction<Env, 'app'> = async ({ request, env, params }) => {
  if (!isSameOrigin(request)) return error(403, 'bad_origin');
  if (!await knownApp(env, request, params.app)) return error(404, 'not_found');
  const who = await communityIdentity(env.DB, request);
  // Establish the browser credential with GET first; mutations never race to create separate identities.
  if (!who.hash) return error(428, 'visitor_required');
  const body = await communityBody(request);
  if (body.response) return body.response;
  const v = body.value!;
  const app = params.app as string;
  if (v.requireLogin === true && !who.user) return error(401, 'session_expired');
  if (v.action !== 'like' && v.action !== 'rate' && v.action !== 'comment' && v.action !== 'comment-like') return error(400, 'invalid');
  if (v.action === 'like' && typeof v.liked !== 'boolean') return error(400, 'invalid');
  if (v.action === 'rate' && v.rating !== null && (!Number.isInteger(v.rating) || Number(v.rating) < 1 || Number(v.rating) > 5)) return error(400, 'invalid');
  if (v.action === 'comment-like') {
    if (typeof v.commentId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(v.commentId) || typeof v.liked !== 'boolean') return error(400, 'invalid');
    const visible = `SELECT c.id FROM app_comments c WHERE c.id = ? AND c.app_id = ? AND c.status = 'approved' AND (c.thread_id IS NULL OR EXISTS (SELECT 1 FROM app_comments root WHERE root.id = c.thread_id AND root.app_id = c.app_id AND root.status = 'approved'))`;
    if (!await env.DB.prepare(visible).bind(v.commentId, app).first()) return error(404, 'not_found');
    const wait = await allowWrite(env.DB, request, who.voterKey!, false);
    if (wait) return error(429, 'rate_limited', { 'Retry-After': String(wait) });
    if (v.liked) await env.DB.prepare(`INSERT INTO app_comment_likes(comment_id,voter_hash,created_at) SELECT id, ?, ? FROM (${visible}) WHERE 1 ON CONFLICT(comment_id,voter_hash) DO NOTHING`).bind(who.voterKey, Date.now(), v.commentId, app).run();
    else await env.DB.prepare('DELETE FROM app_comment_likes WHERE comment_id = ? AND voter_hash = ?').bind(v.commentId, who.voterKey).run();
    const likes = await env.DB.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(voter_hash = ?),0) AS liked FROM app_comment_likes WHERE comment_id = ?').bind(who.voterKey, v.commentId).first<{ count: number; liked: number }>();
    return json({ id: v.commentId, likeCount: likes!.count, likedByMe: Boolean(likes!.liked) });
  }
  let text = '';
  let parentId: string | null = null, threadId: string | null = null;
  if (v.action === 'comment') {
    if (typeof v.body !== 'string' || typeof v.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(v.requestId)) return error(400, 'invalid');
    text = v.body.trim();
    if (!text || [...text].length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return error(400, 'invalid');
    if (v.parentId !== undefined && v.parentId !== null) {
      if (typeof v.parentId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(v.parentId)) return error(400, 'invalid');
      parentId = v.parentId;
    }
    const prior = await env.DB.prepare('SELECT id, status, app_id, body, parent_id, user_id FROM app_comments WHERE visitor_hash = ? AND request_id = ?').bind(who.hash, v.requestId).first<{ id: string; status: string; app_id: string; body: string; parent_id: string | null; user_id: string | null }>();
    if (prior) return prior.app_id === app && prior.body === text && prior.parent_id === parentId && prior.user_id === (who.user?.id ?? null) ? json({ id: prior.id, status: prior.status }) : error(409, 'request_conflict');
    if (parentId) {
      const parent = await env.DB.prepare("SELECT id, thread_id FROM app_comments WHERE id = ? AND app_id = ? AND status = 'approved'").bind(parentId, app).first<{ id: string; thread_id: string | null }>();
      if (!parent) return error(404, 'not_found');
      threadId = parent.thread_id ?? parent.id;
      const root = await env.DB.prepare("SELECT id FROM app_comments WHERE id = ? AND app_id = ? AND status = 'approved' AND thread_id IS NULL").bind(threadId, app).first();
      if (!root) return error(404, 'not_found');
    }
  }
  const wait = await allowWrite(env.DB, request, who.voterKey!, v.action === 'comment');
  if (wait) return error(429, 'rate_limited', { 'Retry-After': String(wait) });
  if (v.action === 'comment') {
    const id = crypto.randomUUID();
    const now = Date.now();
    // Idempotent even if two network retries pass the initial lookup concurrently.
    await env.DB.prepare(`INSERT INTO app_comments (id, app_id, visitor_hash, request_id, body, status, created_at, updated_at, parent_id, thread_id, user_id) SELECT ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ? WHERE ? IS NULL OR EXISTS (SELECT 1 FROM app_comments p JOIN app_comments root ON root.id = ? WHERE p.id = ? AND p.app_id = ? AND p.status = 'approved' AND root.status = 'approved') ON CONFLICT(visitor_hash, request_id) DO NOTHING`).bind(id, app, who.hash, v.requestId, text, now, now, parentId, threadId, who.user?.id ?? null, parentId, threadId, parentId, app).run();
    const row = await env.DB.prepare('SELECT id, status, app_id, body, parent_id, user_id FROM app_comments WHERE visitor_hash = ? AND request_id = ?').bind(who.hash, v.requestId).first<{ id: string; status: string; app_id: string; body: string; parent_id: string | null; user_id: string | null }>();
    if (!row) return error(404, 'not_found');
    if (row.app_id !== app || row.body !== text || row.parent_id !== parentId || row.user_id !== (who.user?.id ?? null)) return error(409, 'request_conflict');
    return json({ id: row.id, status: row.status }, 201);
  }
  if (v.action === 'like') await env.DB.prepare(`INSERT INTO app_votes(app_id,visitor_hash,liked) VALUES(?,?,?) ON CONFLICT(app_id,visitor_hash) DO UPDATE SET liked=excluded.liked`).bind(app, who.hash, Number(v.liked)).run();
  else await env.DB.prepare(`INSERT INTO app_votes(app_id,visitor_hash,rating) VALUES(?,?,?) ON CONFLICT(app_id,visitor_hash) DO UPDATE SET rating=excluded.rating`).bind(app, who.hash, v.rating).run();
  return json({ summary: await summary(env.DB, app) });
};
