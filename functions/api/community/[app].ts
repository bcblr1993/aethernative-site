import type { Env } from '../../_lib/env';
import { allowWrite, communityBody, cursor, knownApp, listComments, summary, visitor } from '../../_lib/community';
import { error, isSameOrigin, json } from '../../_lib/http';

export const onRequestGet: PagesFunction<Env, 'app'> = async ({ request, env, params }) => {
  if (!await knownApp(env, request, params.app)) return error(404, 'not_found');
  const app = params.app as string;
  const after = cursor(new URL(request.url).searchParams.get('cursor'));
  if (after === false) return error(400, 'invalid_cursor');
  const who = await visitor(request, true);
  const mine = await env.DB.prepare('SELECT liked, rating FROM app_votes WHERE app_id = ? AND visitor_hash = ?').bind(app, who.hash).first<{ liked: number; rating: number | null }>();
  return json({ ...await listComments(env.DB, app, 'approved', after), summary: await summary(env.DB, app), mine: { liked: Boolean(mine?.liked), rating: mine?.rating ?? null } }, 200, who.cookie ? { 'Set-Cookie': who.cookie } : {});
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
  if (v.action === 'comment') {
    if (typeof v.body !== 'string' || typeof v.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(v.requestId)) return error(400, 'invalid');
    text = v.body.trim();
    if (!text || [...text].length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return error(400, 'invalid');
    const prior = await env.DB.prepare('SELECT id, status, app_id, body FROM app_comments WHERE visitor_hash = ? AND request_id = ?').bind(who.hash, v.requestId).first<{ id: string; status: string; app_id: string; body: string }>();
    if (prior) return prior.app_id === app && prior.body === text ? json({ id: prior.id, status: prior.status }) : error(409, 'request_conflict');
  }
  const wait = await allowWrite(env.DB, request, who.hash, v.action === 'comment');
  if (wait) return error(429, 'rate_limited', { 'Retry-After': String(wait) });
  if (v.action === 'comment') {
    const id = crypto.randomUUID();
    const now = Date.now();
    // Idempotent even if two network retries pass the initial lookup concurrently.
    await env.DB.prepare(`INSERT INTO app_comments (id, app_id, visitor_hash, request_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(visitor_hash, request_id) DO NOTHING`).bind(id, app, who.hash, v.requestId, text, now, now).run();
    const row = await env.DB.prepare('SELECT id, status, app_id, body FROM app_comments WHERE visitor_hash = ? AND request_id = ?').bind(who.hash, v.requestId).first<{ id: string; status: string; app_id: string; body: string }>();
    if (row?.app_id !== app || row?.body !== text) return error(409, 'request_conflict');
    return json({ id: row.id, status: row.status }, 201);
  }
  if (v.action === 'like') await env.DB.prepare(`INSERT INTO app_votes(app_id,visitor_hash,liked) VALUES(?,?,?) ON CONFLICT(app_id,visitor_hash) DO UPDATE SET liked=excluded.liked`).bind(app, who.hash, Number(v.liked)).run();
  else await env.DB.prepare(`INSERT INTO app_votes(app_id,visitor_hash,rating) VALUES(?,?,?) ON CONFLICT(app_id,visitor_hash) DO UPDATE SET rating=excluded.rating`).bind(app, who.hash, v.rating).run();
  return json({ summary: await summary(env.DB, app) });
};
