import { beforeEach, describe, expect, it } from 'vitest';
import { createD1 } from './d1';
import { onRequestGet as read, onRequestPost as write } from '../../functions/api/community/[app]';
import { onRequestGet as inbox, onRequestPost as markRead } from '../../functions/api/community/notifications';
import { createSession, upsertUser } from '../../functions/_lib/session';
const origin = 'https://aethernative.com';
let env: { DB: ReturnType<typeof createD1>; ASSETS: { fetch: () => Promise<Response> } };
beforeEach(() => { env = { DB: createD1(), ASSETS: { fetch: async () => Response.json(['aetherterm', 'aethernote']) } }; });
const get = (cookie = '', query = '', app = 'aetherterm') => read({ request: new Request(`${origin}/api/community/${app}${query}`, { headers: { Cookie: cookie } }), env, params: { app } } as any);
async function browser(session = '') { const r=await get(session); return [session, r.headers.get('Set-Cookie')!.split(';')[0]].filter(Boolean).join('; '); }
async function account(owner = false) {
 const user = await upsertUser(env.DB,{ provider:'github',id:crypto.randomUUID(),name:owner?'编程不良人':'小明',email:'private@example.test',avatarUrl:null });
 if(owner) env.DB.raw.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(user.id);
 return {id:user.id,session:(await createSession(env.DB,user.id,null)).map(c=>c.split(';')[0]).join('; ')};
}
const post = (cookie: string, body: unknown, app = 'aetherterm', site = origin) => write({ request: new Request(`${origin}/api/community/${app}`, { method:'POST',headers:{Cookie:cookie,Origin:site,'Content-Type':'application/json'},body:JSON.stringify(body) }),env,params:{app} } as any);
async function comment(cookie: string, text: string, parentId: string | null = null) { const r=await post(cookie,{action:'comment',body:text,parentId,requestId:crypto.randomUUID()});expect(r.status).toBe(201);return (await r.json() as any).id; }
const unread = async(cookie: string) => (await (await inbox({request:new Request(`${origin}/api/community/notifications`,{headers:{Cookie:cookie}}),env} as any)).json() as any);
const mark = (cookie:string, ids:string[]) => markRead({request:new Request(`${origin}/api/community/notifications`,{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({ids})}),env} as any);
const like = (cookie:string,id:string,liked:unknown=true,app='aetherterm')=>post(cookie,{action:'comment-like',commentId:id,liked},app);

describe('Account comment identity and per-comment likes',()=>{
 it('uses session identity and owner badges for new comments, while preventing role spoofing and preserving legacy anonymity',async()=>{
  const owner=await account(true),member=await account();const a=await browser(owner.session),b=await browser(member.session),anon=await browser();
  expect((await post(anon,{action:'comment',body:'Requires session',requestId:crypto.randomUUID(),requireLogin:true})).status).toBe(401);
  const guest=await comment(anon,'Guest comment');const official=await comment(a,'We can help',guest);
  const r=await post(b,{action:'comment',body:'Member answer',parentId:guest,requestId:crypto.randomUUID(),userId:owner.id,isAdmin:true,authorRole:'owner'});expect(r.status).toBe(201);
  const d=await (await get(a)).json() as any;const c=d.comments[0];
  expect(c.authorRole).toBe('guest');expect(c.replies.find((r:any)=>r.id===official)).toMatchObject({author:'编程不良人',authorRole:'owner'});
  expect(c.replies.find((r:any)=>r.author==='小明').authorRole).toBe('member');
  expect(JSON.stringify(d)).not.toContain('private@example.test');expect(JSON.stringify(d)).not.toContain(owner.id);expect(JSON.stringify(d)).not.toMatch(/user_id|visitor_hash|voter_hash/);
 });
 it('delivers and reads account notifications across browser sessions and excludes self replies across devices',async()=>{
  const owner=await account(true),member=await account();const a=await browser(owner.session),a2=await browser(owner.session),b=await browser(member.session);
  const root=await comment(a,'Question');const answer=await comment(b,'Answer',root);await comment(a2,'Self follow-up',root);
  expect((await unread(owner.session)).notifications.map((n:any)=>n.id)).toEqual([answer]);
  expect((await mark(owner.session,[answer])).status).toBe(200);expect((await unread(a)).count).toBe(0);
  const followup=await comment(a,'Thanks',answer);expect((await unread(member.session)).notifications[0].id).toBe(followup);
 });
 it('likes root comments and replies atomically, supports withdrawal, and preserves member votes across devices',async()=>{
  const owner=await account(true);const a=await browser(owner.session),a2=await browser(owner.session),b=await browser();
  const root=await comment(a,'Question'),reply=await comment(b,'Answer',root);
  const votes=await Promise.all([like(a,reply),like(a2,reply)]);for(const r of votes) expect(r.status).toBe(200);
  expect(await (await like(a,reply)).json()).toMatchObject({likeCount:1,likedByMe:true});
  expect(await (await like(b,reply)).json()).toMatchObject({likeCount:2,likedByMe:true});
  let data=await (await get(a2)).json() as any;expect(data.comments[0].replies[0]).toMatchObject({likeCount:2,likedByMe:true});
  expect(await (await like(a2,reply,false)).json()).toMatchObject({likeCount:1,likedByMe:false});
  data=await (await get(a)).json() as any;expect(data.comments[0].replies[0]).toMatchObject({likeCount:1,likedByMe:false});
  expect(await (await like(b,root)).json()).toMatchObject({likeCount:1,likedByMe:true});
  expect((await (await get(b,`?thread=${root}`)).json() as any).comments[0]).toMatchObject({id:reply,likeCount:1,likedByMe:true});
  expect((await (await get(b,`?focus=${reply}`)).json() as any).comments[0].replies[0]).toMatchObject({id:reply,likeCount:1,likedByMe:true});
 });
 it('rejects malformed, cross-app, hidden and cross-origin likes and hides thread like targets with their parent',async()=>{
  const a=await browser(),b=await browser();const root=await comment(a,'Question'),reply=await comment(b,'Answer',root);
  expect((await like('',reply)).status).toBe(428);expect((await like(a,reply,42)).status).toBe(400);expect((await like(a,'bad/id')).status).toBe(400);
  expect((await like(a,reply,true,'aethernote')).status).toBe(404);
  expect((await post(a,{action:'comment-like',commentId:reply,liked:true},'aetherterm','https://other.test')).status).toBe(403);
  await env.DB.prepare("UPDATE app_comments SET status='hidden' WHERE id=?").bind(root).run();expect((await like(a,reply)).status).toBe(404);
  await env.DB.prepare("UPDATE app_comments SET status='approved' WHERE id=?").bind(root).run();await env.DB.prepare("UPDATE app_comments SET status='hidden' WHERE id=?").bind(reply).run();expect((await like(a,reply)).status).toBe(404);
 });
});
