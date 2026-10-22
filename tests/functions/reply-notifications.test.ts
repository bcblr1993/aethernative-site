import { beforeEach, describe, expect, it } from 'vitest';
import { createD1 } from './d1';
import { onRequestGet as read, onRequestPost as write } from '../../functions/api/community/[app]';
import { onRequestGet as inbox, onRequestPost as markRead } from '../../functions/api/community/notifications';

const origin = 'https://aethernative.com';
let env: { DB: ReturnType<typeof createD1>; ASSETS: { fetch: () => Promise<Response> } };
beforeEach(() => { env = { DB: createD1(), ASSETS: { fetch: async () => Response.json(['aetherterm', 'aethernote']) } }; });
const community = (cookie = '', query = '', app = 'aetherterm') => read({ request: new Request(`${origin}/api/community/${app}${query}`, { headers: { Cookie: cookie } }), env, params: { app } } as any);
const identity = async () => (await community()).headers.get('Set-Cookie')!.split(';')[0];
const notifications = (cookie = '') => inbox({ request: new Request(`${origin}/api/community/notifications`, { headers: { Cookie: cookie } }), env } as any);
const mark = (cookie: string, ids: unknown, site = origin) => markRead({ request: new Request(`${origin}/api/community/notifications`, { method: 'POST', headers: { Cookie: cookie, Origin: site, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }), env } as any);
async function comment(cookie: string, body: string, parentId: string | null = null, app = 'aetherterm') {
  const response = await write({ request: new Request(`${origin}/api/community/${app}`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'comment', body, parentId, requestId: crypto.randomUUID() }) }), env, params: { app } } as any);
  expect(response.status).toBe(201); return (await response.json() as { id: string }).id;
}
const hide = (id: string, status = 'hidden') => env.DB.prepare('UPDATE app_comments SET status = ? WHERE id = ?').bind(status, id).run();

describe('Replies to my anonymous comments', () => {
  it('keeps the inbox private to the browser credential and ignores self replies', async () => {
    const a = await identity(), b = await identity(), stranger = await identity();
    const root = await comment(a, 'Question');
    await comment(a, 'My own follow-up', root);
    const reply = await comment(b, '<img src=x onerror=alert(1)> Answer', root);
    expect(await (await notifications()).json()).toEqual({ count: 0, notifications: [] });
    expect(await (await notifications(stranger)).json()).toEqual({ count: 0, notifications: [] });
    expect(await (await notifications(b)).json()).toEqual({ count: 0, notifications: [] });
    const response = await notifications(a); expect(response.headers.get('Cache-Control')).toBe('no-store');
    const data = await response.json() as any;
    expect(data.count).toBe(1); expect(data.notifications[0]).toMatchObject({ id: reply, parentBody: 'Question', body: '<img src=x onerror=alert(1)> Answer', href: `/apps/aetherterm/?focus=${reply}#reviews` });
    expect(JSON.stringify(data)).not.toMatch(/visitor_hash|request_id|parent_hash/);
    const replyToReply = await comment(a, 'Thanks', reply);
    expect((await (await notifications(b)).json() as any).notifications[0].id).toBe(replyToReply);
    expect((await (await notifications(a)).json() as any).count).toBe(1);
  });
  it('marks only the recipient snapshot read, is idempotent, and retains later replies', async () => {
    const a = await identity(), b = await identity(), stranger = await identity();
    const root = await comment(a, 'Question'); const reply = await comment(b, 'Answer', root);
    expect((await mark(stranger, [reply])).status).toBe(200);
    expect((await (await notifications(a)).json() as any).count).toBe(1);
    expect((await mark(a, [reply])).status).toBe(200); expect((await mark(a, [reply])).status).toBe(200);
    expect((await (await notifications(a)).json() as any).count).toBe(0);
    const later = await comment(b, 'Another answer', root);
    await mark(a, [reply]);
    expect((await (await notifications(a)).json() as any).notifications.map((n: any) => n.id)).toEqual([later]);
    expect(env.DB.raw.prepare('SELECT COUNT(*) n FROM app_reply_reads').get()!.n).toBe(1);
  });
  it('filters hidden replies, parents and whole threads, including historical pending comments', async () => {
    const a = await identity(), b = await identity();
    const root = await comment(a, 'Question'); const reply = await comment(b, 'Answer', root);
    for (const [id, status] of [[reply,'hidden'], [reply,'pending'], [root,'hidden'], [root,'pending']]) {
      await hide(root,'approved'); await hide(reply,'approved'); await hide(id,status);
      expect((await (await notifications(a)).json() as any).count).toBe(0);
      await mark(a,[reply]); expect(env.DB.raw.prepare('SELECT COUNT(*) n FROM app_reply_reads').get()!.n).toBe(0);
    }
    await hide(root,'approved'); await hide(reply,'approved');
    const nested = await comment(a,'Follow up',reply); await hide(reply);
    expect((await (await notifications(b)).json() as any).count).toBe(0);
    await hide(reply,'approved');
    expect((await (await notifications(b)).json() as any).notifications[0].id).toBe(nested);
  });
  it('rejects missing credentials, bad origins and malformed read requests', async () => {
    const a = await identity();
    expect((await mark('', ['id'])).status).toBe(428);
    expect((await mark(a, ['id'], 'https://other.test')).status).toBe(403);
    for (const ids of [null, [], [42], ['bad/id'], Array(21).fill('id')]) expect((await mark(a, ids)).status).toBe(400);
  });
  it('bounds the inbox, reports total unread count and serves older unread replies after reading a page', async () => {
    const a = await identity(), b = await identity(); const root = await comment(a,'Question');
    const hash = env.DB.raw.prepare('SELECT visitor_hash FROM app_comments WHERE id = ?').get(root)!.visitor_hash;
    const insert = env.DB.raw.prepare("INSERT INTO app_comments(id,app_id,visitor_hash,request_id,body,status,created_at,updated_at,parent_id,thread_id) VALUES(?,'aetherterm','other-hash',?,'Answer','approved',123,123,?,?)");
    for(let i=0;i<45;i++) insert.run(`reply-${String(i).padStart(2,'0')}`,`request-${i}`,root,root);
    const data = await (await notifications(a)).json() as any;
    expect(data.count).toBe(45); expect(data.notifications).toHaveLength(20);
    await mark(a,data.notifications.map((n: any)=>n.id));
    const next = await (await notifications(a)).json() as any;
    expect(next.count).toBe(25); expect(next.notifications).toHaveLength(20);
    expect(next.notifications.some((n: any)=>data.notifications.some((prior: any)=>prior.id===n.id))).toBe(false);
    expect(hash).toBeTruthy(); expect((await (await notifications(b)).json() as any).count).toBe(0);
  });
  it('links to older threads and replies outside previews without disclosing hidden or cross-app content', async () => {
    const a = await identity(), b = await identity(); const root = await comment(a,'Older thread'); const reply = await comment(b,'Older reply',root);
    env.DB.raw.prepare('UPDATE app_comments SET created_at = 1 WHERE id = ?').run(reply);
    env.DB.raw.prepare('UPDATE app_comments SET created_at = 0 WHERE id = ?').run(root);
    const insert = env.DB.raw.prepare("INSERT INTO app_comments(id,app_id,visitor_hash,request_id,body,status,created_at,updated_at,parent_id,thread_id) VALUES(?,'aetherterm','other-hash',?,'Newer','approved',123,123,?,?)");
    for(let i=0;i<30;i++) { insert.run(`reply-${i}`,`req-${i}`,root,root); insert.run(`root-${i}`,`rootreq-${i}`,null,null); }
    expect((await (await community(a)).json() as any).comments.some((c: any)=>c.id===root)).toBe(false);
    const focus = await (await community(a,`?focus=${reply}`)).json() as any;
    expect(focus.comments).toHaveLength(1); expect(focus.comments[0].id).toBe(root);
    expect(focus.comments[0].replies.some((r: any)=>r.id===reply)).toBe(true);
    expect(focus.comments[0].replies).toHaveLength(4); expect(focus.comments[0].repliesNext).toBeTruthy();
    expect((await community(a,`?focus=${reply}`,'aethernote')).status).toBe(404);
    expect((await community(a,'?focus=bad/id')).status).toBe(400);
    await hide(root); expect((await community(a,`?focus=${reply}`)).status).toBe(404);
    await hide(root,'approved'); await hide(reply); expect((await community(a,`?focus=${reply}`)).status).toBe(404);
  });
});
