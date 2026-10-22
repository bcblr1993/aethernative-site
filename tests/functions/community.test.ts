import { beforeEach, describe, expect, it } from 'vitest';
import { createD1 } from './d1';
import { onRequestGet as get, onRequestPost as post } from '../../functions/api/community/[app]';
import { onRequestGet as aggregate } from '../../functions/api/community/index';
import { onRequestGet as list } from '../../functions/api/admin/comments/index';
import { onRequestPatch as patch } from '../../functions/api/admin/comments/[id]';
import { allowWrite, visitor } from '../../functions/_lib/community';
import { createSession, upsertUser } from '../../functions/_lib/session';
import { onRequestGet as me } from '../../functions/api/me/index';

const origin = 'https://aethernative.com';
let env: ReturnType<typeof setup>;
const setup = () => ({ DB: createD1(), ASSETS: { fetch: async (request: Request) => {
  return new URL(request.url).pathname === '/community-catalog.json' ? Response.json(['aetherterm','aethernote']) : new Response('not found', { status: 404 });
} } });
beforeEach(() => { env = setup(); });
async function read(cookie = '', query = '', app = 'aetherterm') {
  return get({ request: new Request(`${origin}/api/community/${app}${query}`, { headers: { Cookie: cookie } }), env, params: { app } } as any);
}
async function identity() { return (await read()).headers.get('Set-Cookie')!.split(';')[0]; }
const write = (cookie: string, body: unknown, app = 'aetherterm', site = origin) => post({
  request: new Request(`${origin}/api/community/${app}`, { method: 'POST', headers: { Cookie: cookie, Origin: site, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' }, body: JSON.stringify(body) }), env, params: { app },
} as any);
async function admin(isAdmin = true) {
  const u = await upsertUser(env.DB, { provider: 'github', id: crypto.randomUUID(), name: 'admin', email: null, avatarUrl: null });
  if (isAdmin) env.DB.raw.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(u.id);
  return (await createSession(env.DB, u.id, null)).map(c => c.split(';')[0]).join('; ');
}
const moderate = (cookie: string, id: string, status: string, site = origin) => patch({ request: new Request(`${origin}/api/admin/comments/${id}`, { method: 'PATCH', headers: { Cookie: cookie, Origin: site, 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }), env, params: { id } } as any);
const queue = (cookie: string, query = '') => list({ request: new Request(`${origin}/api/admin/comments${query}`, { headers: { Cookie: cookie } }), env } as any);

describe('Anonymous app community', () => {
  it('uses an HttpOnly browser credential and returns honest empty state without exposing identifiers', async () => {
    const r = await read();
    expect(r.headers.get('Set-Cookie')).toContain('HttpOnly');
    expect(r.headers.get('Set-Cookie')).toContain('Secure');
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(await r.json()).toMatchObject({ summary: { likes: 0, ratings: 0, average: null }, mine: { liked: false, rating: null }, comments: [], next: null });
    const cookie = r.headers.get('Set-Cookie')!.split(';')[0];
    expect((await read(cookie)).headers.get('Set-Cookie')).toBeNull();
    expect(await visitor(new Request(origin, { headers: { Cookie: '__Host-community=invalid' } }))).toMatchObject({ hash: null });
  });
  it('upserts independently, supports withdrawal, and isolates browser and app votes', async () => {
    const a = await identity(), b = await identity();
    for (let i = 0; i < 3; i++) expect((await write(a, { action: 'like', liked: true })).status).toBe(200);
    await write(a, { action: 'rate', rating: 5 }); await write(a, { action: 'rate', rating: 3 });
    await write(b, { action: 'rate', rating: 4 });
    expect(await (await read(a)).json()).toMatchObject({ summary: { likes: 1, ratings: 2, average: 3.5 }, mine: { liked: true, rating: 3 } });
    expect(await (await read(a, '', 'aethernote')).json()).toMatchObject({ summary: { likes: 0, ratings: 0, average: null } });
    await write(a, { action: 'like', liked: false }); await write(a, { action: 'rate', rating: null });
    expect(await (await read(a)).json()).toMatchObject({ summary: { likes: 0, ratings: 1, average: 4 }, mine: { liked: false, rating: null } });
    const summaries = await (await aggregate({ env } as any)).json() as any;
    expect(Object.keys(summaries.apps[0]).sort()).toEqual(['appId', 'average', 'likes', 'ratings']);
  });
  it('rejects cross-origin, unknown app, missing cookies, malformed and oversized requests', async () => {
    const a = await identity();
    expect((await write(a, { action: 'like', liked: true }, 'aetherterm', 'https://evil.test')).status).toBe(403);
    expect((await write(a, { action: 'like', liked: true }, 'unknown')).status).toBe(404);
    expect((await read('', '', '../evil')).status).toBe(404);
    expect((await write('', { action: 'like', liked: true })).status).toBe(428);
    for (const value of [0, 6, 1.5, '5', false, {}, undefined]) expect((await write(a, { action: 'rate', rating: value })).status).toBe(400);
    for (const value of ['', ' '.repeat(10), '字'.repeat(1001), 'bad\u0000text']) expect((await write(a, { action: 'comment', body: value, requestId: crypto.randomUUID() })).status).toBe(400);
    expect((await write(a, { action: 'comment', body: 'x'.repeat(9000), requestId: crypto.randomUUID() })).status).toBe(413);
    expect((await read(a, '?cursor=invalid')).status).toBe(400);
  });
  it('publishes new comments immediately, retains moderation and never exposes browser hashes', async () => {
    const a = await identity(), owner = await admin(), ordinary = await admin(false);
    const text = '<img src=x onerror=alert(1)> Plain text, never HTML';
    const submitted = await (await write(a, { action: 'comment', body: text, requestId: crypto.randomUUID() })).json() as any;
    expect(submitted.status).toBe('approved');
    expect((await (await read(a)).json() as any).comments[0].body).toBe(text);
    // Historical submissions retain their original private state.
    await moderate(owner, submitted.id, 'pending');
    expect((await (await read(a)).json() as any).comments).toEqual([]);
    expect((await queue('')).status).toBe(401); expect((await queue(ordinary)).status).toBe(403);
    expect((await moderate(ordinary, submitted.id, 'approved')).status).toBe(403);
    expect((await moderate(owner, submitted.id, 'approved', 'https://evil.test')).status).toBe(403);
    expect((await moderate(owner, submitted.id, 'invalid')).status).toBe(400);
    const pending = await (await queue(owner, '?status=pending')).json() as any;
    expect(pending.pending.count).toBe(1); expect(pending.comments[0].body).toBe(text);
    const adminMe = await (await me({ request: new Request(`${origin}/api/me`, { headers: { Cookie: owner } }), env } as any)).json() as any;
    expect(adminMe.user.adminComments).toEqual({ count: 1, latestId: submitted.id });
    const userMe = await (await me({ request: new Request(`${origin}/api/me`, { headers: { Cookie: ordinary } }), env } as any)).json() as any;
    expect(userMe.user).not.toHaveProperty('adminComments');
    expect((await moderate(owner, submitted.id, 'approved')).status).toBe(200);
    const visible = (await (await read()).json() as any).comments[0];
    expect(Object.keys(visible).sort()).toEqual(['id', 'appId', 'body', 'status', 'createdAt', 'parentId', 'threadId', 'author', 'replyTo', 'replies', 'repliesNext'].sort());
    expect(visible.body).toBe(text);
    await moderate(owner, submitted.id, 'hidden');
    expect((await (await read()).json() as any).comments).toEqual([]);
    await moderate(owner, submitted.id, 'approved');
    expect((await (await read()).json() as any).comments).toHaveLength(1);
    expect((await moderate(owner, 'missing', 'hidden')).status).toBe(404);
  });
  it('deduplicates concurrent comment retries but rejects reusing an id for different content', async () => {
    const a = await identity();
    const input = { action: 'comment', body: 'A real comment', requestId: crypto.randomUUID() };
    const results = await Promise.all([write(a, input), write(a, input)]);
    const ids = await Promise.all(results.map(async r => (await r.json() as any).id));
    expect(new Set(ids).size).toBe(1);
    expect(env.DB.raw.prepare('SELECT COUNT(*) n FROM app_comments').get()!.n).toBe(1);
    expect((await write(a, { ...input, body: 'Different comment' })).status).toBe(409);
    expect((await write(a, input, 'aethernote')).status).toBe(409);
  });
  it('supports mutual replies, validates targets and keeps hidden threads private', async () => {
    const owner = await admin(), a = await identity(), b = await identity();
    const root = await (await write(a, { action: 'comment', body: 'Question', requestId: crypto.randomUUID() })).json() as any;
    const input = { action: 'comment', body: '<img src=x onerror=alert(1)> Answer', parentId: root.id, requestId: crypto.randomUUID() };
    const first = await (await write(b, input)).json() as any;
    expect(first.status).toBe('approved');
    expect((await write(b, input)).status).toBe(200);
    expect((await write(b, { ...input, parentId: null })).status).toBe(409);
    const second = await (await write(a, { action: 'comment', body: 'Thank you', parentId: first.id, requestId: crypto.randomUUID() })).json() as any;
    const page = await (await read()).json() as any;
    expect(page.comments).toHaveLength(1);
    expect(page.comments[0].replies).toHaveLength(2);
    const nested = page.comments[0].replies.find((r: any) => r.id === second.id);
    expect(nested).toMatchObject({ parentId: first.id, threadId: root.id, author: page.comments[0].author });
    expect(nested.replyTo).toBe(page.comments[0].replies.find((r: any) => r.id === first.id).author);
    expect(JSON.stringify(page)).not.toMatch(/visitor_hash|parent_hash|request_id/);
    const replyInput = { action: 'comment', body: 'Another reply', requestId: crypto.randomUUID() };
    for (const parentId of ['', 42, {}, 'bad/target']) expect((await write(b, { ...replyInput, parentId })).status).toBe(400);
    expect((await write(b, { ...replyInput, parentId: 'missing' })).status).toBe(404);
    expect((await write(b, { ...replyInput, parentId: root.id }, 'aethernote')).status).toBe(404);
    await moderate(owner, first.id, 'hidden');
    const visible = await (await read()).json() as any;
    expect(visible.comments[0].replies).toHaveLength(1);
    expect(visible.comments[0].replies[0].replyTo).toBeNull();
    expect((await write(b, { ...replyInput, parentId: first.id })).status).toBe(404);
    await moderate(owner, root.id, 'hidden');
    expect((await (await read()).json() as any).comments).toEqual([]);
    expect((await read('', `?thread=${root.id}`)).status).toBe(404);
    expect((await write(b, { ...replyInput, parentId: second.id })).status).toBe(404);
    const hidden = await (await queue(owner, '?status=hidden')).json() as any;
    expect(hidden.comments).toHaveLength(2);
    await moderate(owner, root.id, 'approved');
    expect((await (await read()).json() as any).comments[0].replies).toHaveLength(1);
  });
  it('bounds reply previews and paginates all replies without mixing apps or threads', async () => {
    const insert = env.DB.raw.prepare("INSERT INTO app_comments(id,app_id,visitor_hash,request_id,body,status,created_at,updated_at,parent_id,thread_id) VALUES(?,'aetherterm','hash',?,'hello','approved',123,123,?,?)");
    insert.run('root', 'root-request', null, null);
    insert.run('other', 'other-request', null, null);
    for (let i = 0; i < 45; i++) insert.run(`reply-${String(i).padStart(2,'0')}`, `req-${i}`, 'root', 'root');
    insert.run('other-reply', 'other-reply-request', 'other', 'other');
    const page = await (await read()).json() as any;
    const root = page.comments.find((c: any) => c.id === 'root');
    expect(root.replies).toHaveLength(3); expect(root.repliesNext).toBeTruthy();
    const ids = root.replies.map((c: any) => c.id); let next = root.repliesNext;
    while (next) {
      const data = await (await read('', `?thread=root&cursor=${encodeURIComponent(next)}`)).json() as any;
      ids.push(...data.comments.map((c: any) => c.id)); next = data.next;
    }
    expect(ids).toHaveLength(45); expect(new Set(ids).size).toBe(45);
    expect(ids).not.toContain('other-reply');
    expect((await read('', '?thread=root', 'aethernote')).status).toBe(404);
    expect((await read('', '?thread=bad/target')).status).toBe(400);
  });
  it('paginates approved comments deterministically even with identical timestamps', async () => {
    const stmt = env.DB.raw.prepare("INSERT INTO app_comments(id,app_id,visitor_hash,request_id,body,status,created_at,updated_at) VALUES(?,'aetherterm','hash',?,'hello','approved',123,123)");
    for (let i = 0; i < 45; i++) stmt.run(`id-${i}`, `req-${i}`);
    const ids: string[] = []; let next = '';
    do {
      const d = await (await read('', next ? `?cursor=${encodeURIComponent(next)}` : '')).json() as any;
      ids.push(...d.comments.map((c: any) => c.id)); next = d.next;
    } while (next);
    expect(ids.length).toBe(45); expect(new Set(ids).size).toBe(45);
  });
  it('enforces atomic visitor and network limits across apps and permits the next window', async () => {
    const req = new Request(origin, { headers: { 'CF-Connecting-IP': '192.0.2.42' } });
    const now = 3600_000;
    const attempts = await Promise.all(Array.from({ length: 8 }, () => allowWrite(env.DB, req, 'same-browser', true, now)));
    expect(attempts.filter(x => x === 0)).toHaveLength(3);
    for (let i = 0; i < 2; i++) expect(await allowWrite(env.DB, req, `fresh-${i}`, true, now)).toBe(0);
    expect(await allowWrite(env.DB, req, 'another-fresh', true, now)).toBeGreaterThan(0);
    expect(await allowWrite(env.DB, req, 'same-browser', true, now + 3600_001)).toBe(0);
    const rows = env.DB.raw.prepare('SELECT key FROM community_limits').all();
    expect(JSON.stringify(rows)).not.toContain('192.0.2.42');
  });
  it('returns Retry-After and pending admin count excludes hidden/approved comments', async () => {
    const a = await identity();
    for (let i = 0; i < 3; i++) expect((await write(a, { action: 'comment', body: `comment ${i}`, requestId: crypto.randomUUID() })).status).toBe(201);
    const limited = await write(a, { action: 'comment', body: 'fourth', requestId: crypto.randomUUID() });
    expect(limited.status).toBe(429); expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
  });
});
