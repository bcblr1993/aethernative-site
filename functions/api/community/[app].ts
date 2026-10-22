import type { Env } from '../../_lib/env';
import { allowWrite, communityBody, cursor, knownApp, listComments, summary, visitor } from '../../_lib/community';
import { error, isSameOrigin, json } from '../../_lib/http';

export const onRequestGet: PagesFunction<Env, 'app'> = async ({ request, env, params }) => {
  if (!await knownApp(env, request, params.app)) return error(404, 'not_found');
  const app = params.app as string;
  const after = cursor(new URL(request.url).searchParams.get('cursor'));
  if (after === false) return error(400, 'invalid_cursor');
  const thread = new URL(request.url).searchParams.get('thread');
  if (thread !== null) {
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(thread)) return error(400, 'invalid');
    const root = await env.DB.prepare("SELECT id FROM app_comments WHERE id = ? AND app_id = ? AND status = 'approved' AND thread_id IS NULL").bind(thread, app).first();
    if (!root) return error(404, 'not_found');
  }
  const who = await visitor(request, true);
  const [mine, comments, stats] = await Promise.all([
    env.DB.prepare('SELECT liked, rating FROM app_votes WHERE app_id = ? AND visitor_hash = ?').bind(app, who.hash).first<{ liked: number; rating: number | null }>(),
    listComments(env.DB, app, 'approved', after, { thread: thread ?? undefined }), summary(env.DB, app),
  ]);
  return json({ ...comments, summary: stats, mine: { liked: Boolean(mine?.liked), rating: mine?.rating ?? null } }, 200, who.cookie ? { 'Set-Cookie': who.cookie } : {});
};

export const onRequestPost: PagesFunction<Env, 'app'> = async ({ request, env, params }) => {
  if (!isSameOrigin(request)) return error(403, 'bad_origin');
  if (!await knownApp(env, request, params.app)) return error(404, 'not_found');
  const who = await visitor(request);
  // Establish the browser credential with GET first; mutations never race to create separate identities.
  if (!who.hash) return error(428, 'visitor_required');
  const body = await communityBody(request);
  if (body.response) return body.response;
  const v = body.value!;
  const app = params.app as string;
  if (v.action !== 'like' && v.action !== 'rate' && v.action !== 'comment') return error(400, 'invalid');
  if (v.action === 'like' && typeof v.liked !== 'boolean') return error(400, 'invalid');
  if (v.action === 'rate' && v.rating !== null && (!Number.isInteger(v.rating) || Number(v.rating) < 1 || Number(v.rating) > 5)) return error(400, 'invalid');
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
    const prior = await env.DB.prepare('SELECT id, status, app_id, body, parent_id FROM app_comments WHERE visitor_hash = ? AND request_id = ?').bind(who.hash, v.requestId).first<{ id: string; status: string; app_id: string; body: string; parent_id: string | null }>();
    if (prior) return prior.app_id === app && prior.body === text && prior.parent_id === parentId ? json({ id: prior.id, status: prior.status }) : error(409, 'request_conflict');
    if (parentId) {
      const parent = await env.DB.prepare("SELECT id, thread_id FROM app_comments WHERE id = ? AND app_id = ? AND status = 'approved'").bind(parentId, app).first<{ id: string; thread_id: string | null }>();
      if (!parent) return error(404, 'not_found');
      threadId = parent.thread_id ?? parent.id;
      const root = await env.DB.prepare("SELECT id FROM app_comments WHERE id = ? AND app_id = ? AND status = 'approved' AND thread_id IS NULL").bind(threadId, app).first();
      if (!root) return error(404, 'not_found');
    }
  }
  const wait = await allowWrite(env.DB, request, who.hash, v.action === 'comment');
  if (wait) return error(429, 'rate_limited', { 'Retry-After': String(wait) });
  if (v.action === 'comment') {
    const id = crypto.randomUUID();
    const now = Date.now();
    // Idempotent even if two network retries pass the initial lookup concurrently.
    await env.DB.prepare(`INSERT INTO app_comments (id, app_id, visitor_hash, request_id, body, status, created_at, updated_at, parent_id, thread_id) SELECT ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ? WHERE ? IS NULL OR EXISTS (SELECT 1 FROM app_comments p JOIN app_comments root ON root.id = ? WHERE p.id = ? AND p.app_id = ? AND p.status = 'approved' AND root.status = 'approved') ON CONFLICT(visitor_hash, request_id) DO NOTHING`).bind(id, app, who.hash, v.requestId, text, now, now, parentId, threadId, parentId, threadId, parentId, app).run();
    const row = await env.DB.prepare('SELECT id, status, app_id, body, parent_id FROM app_comments WHERE visitor_hash = ? AND request_id = ?').bind(who.hash, v.requestId).first<{ id: string; status: string; app_id: string; body: string; parent_id: string | null }>();
    if (!row) return error(404, 'not_found');
    if (row.app_id !== app || row.body !== text || row.parent_id !== parentId) return error(409, 'request_conflict');
    return json({ id: row.id, status: row.status }, 201);
  }
  if (v.action === 'like') await env.DB.prepare(`INSERT INTO app_votes(app_id,visitor_hash,liked) VALUES(?,?,?) ON CONFLICT(app_id,visitor_hash) DO UPDATE SET liked=excluded.liked`).bind(app, who.hash, Number(v.liked)).run();
  else await env.DB.prepare(`INSERT INTO app_votes(app_id,visitor_hash,rating) VALUES(?,?,?) ON CONFLICT(app_id,visitor_hash) DO UPDATE SET rating=excluded.rating`).bind(app, who.hash, v.rating).run();
  return json({ summary: await summary(env.DB, app) });
};
