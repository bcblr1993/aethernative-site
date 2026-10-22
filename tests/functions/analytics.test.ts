import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createD1 } from './d1';
import { createSession, upsertUser } from '../../functions/_lib/session';
import { onRequestGet as analytics } from '../../functions/api/admin/analytics';
import { onRequestGet as aggregates } from '../../functions/api/community/index';
const now = Date.parse('2026-10-16T12:00:00+08:00');
let env: { DB: ReturnType<typeof createD1> };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); env = { DB: createD1() }; });
afterEach(() => vi.useRealTimers());
async function user(admin = true) {
  const u = await upsertUser(env.DB, { provider:'github',id:crypto.randomUUID(),name:'Private name',email:'private@example.test',avatarUrl:null });
  if (admin) env.DB.raw.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(u.id);
  return { ...u, cookie:(await createSession(env.DB,u.id,null)).map(c=>c.split(';')[0]).join('; ') };
}
const get = (cookie='', query='') => analytics({request:new Request(`https://aethernative.com/api/admin/analytics${query}`,{headers:{Cookie:cookie}}),env} as any);
it('requires administrator privileges and rejects unsupported ranges/filter syntax',async()=>{
  expect((await get()).status).toBe(401);
  expect((await get((await user(false)).cookie)).status).toBe(403);
  const a=await user();
  for(const q of ['?days=0','?days=365','?days=NaN','?days=7.5','?app=%27%20OR%201=1'])expect((await get(a.cookie,q)).status).toBe(400);
  env.DB.raw.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(now,a.id);
  expect((await get(a.cookie)).status).toBe(401);
});
it('returns empty, private aggregates with Beijing date bounds and no personal data',async()=>{
  const a=await user();const r=await get(a.cookie,'?days=7');const d=await r.json() as any;
  expect(r.headers.get('Cache-Control')).toBe('no-store');
  expect(d).toMatchObject({from:'2026-10-10',to:'2026-10-16',days:7,timezone:'Asia/Shanghai',users:{total:1,added:1,recentLogin:1},downloads:{rows:[]},community:{votes:[],stars:[]}});
  expect(JSON.stringify(d)).not.toContain('private@example.test');expect(JSON.stringify(d)).not.toContain(a.id);expect(JSON.stringify(d)).not.toContain('Private name');
});
it('filters date cohorts and app data while keeping account dimensions global and votes cumulative',async()=>{
  const a=await user();const start=Date.parse('2026-10-10T00:00:00+08:00');
  const download=env.DB.raw.prepare('INSERT INTO download_daily(day,app_id,version,requests) VALUES(?,?,?,?)');
  download.run('2026-10-09','aetherterm','1',100);download.run('2026-10-10','aetherterm','1',2);download.run('2026-10-16','aetherterm','2',3);download.run('2026-10-16','aethernote','1',9);
  const feedback=env.DB.raw.prepare("INSERT INTO feedback(id,user_id,app_id,category,title,body,status,created_at,updated_at) VALUES(?,?,?,'bug','private title','private body',?,?,?)");
  feedback.run('old',a.id,'aetherterm','new',start-1,start-1);feedback.run('boundary',a.id,'aetherterm','replied',start,start);feedback.run('other',a.id,'aethernote','new',now,now);
  env.DB.raw.prepare("INSERT INTO users(id,name,created_at,last_login_at) VALUES('boundary-user','Private',?,?)").run(start,start);
  env.DB.raw.prepare("INSERT INTO identities(provider,provider_user_id,user_id,created_at) VALUES('google','private-external-id',?,?)").run(a.id,now);
  env.DB.raw.prepare("INSERT INTO app_votes VALUES('aetherterm','private-hash',1,5)").run();
  env.DB.raw.prepare("INSERT INTO app_votes VALUES('aethernote','other-hash',1,2)").run();
  env.DB.raw.prepare("INSERT INTO app_comments (id,app_id,visitor_hash,request_id,body,status,created_at,updated_at) VALUES('c','aetherterm','private-hash','r','private comment','pending',?,?)").run(start,start);
  const d=await (await get(a.cookie,'?days=7&app=aetherterm')).json() as any;
  expect(d.downloads.rows.map((r:any)=>r.requests)).toEqual([2,3]);expect(d.downloads.versions[0]).toMatchObject({version:'2',requests:3});
  expect(d.feedback.daily).toEqual([{day:'2026-10-10',count:1}]);expect(d.feedback.statuses).toEqual([{label:'replied',count:1}]);
  expect(d.feedback.pending.count).toBe(1); // Current backlog includes older submissions.
  expect(d.users.added).toBe(2);expect(d.users.providers).toHaveLength(2);
  expect(d.community.votes).toEqual([{appId:'aetherterm',likes:1,ratings:1,average:5}]);
  expect(d.community.stars).toEqual([{label:5,count:1}]);expect(d.community.pending.count).toBe(1);
  expect(JSON.stringify(d)).not.toMatch(/private-hash|private comment|private body|private-external-id/);
});
it('caches only public aggregate statistics without cookies or per-visitor state',async()=>{
  const r=await aggregates({env} as any);expect(r.headers.get('Cache-Control')).toBe('public, max-age=30');
  expect(r.headers.get('Set-Cookie')).toBeNull();expect(await r.json()).toEqual({apps:[]});
});
