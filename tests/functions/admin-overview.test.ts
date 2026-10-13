import { beforeEach, expect, it, vi } from 'vitest';
import { createD1 } from './d1';
import { createSession, upsertUser } from '../../functions/_lib/session';
import { onRequestGet as overview } from '../../functions/api/admin/overview';
import { onRequestGet as services } from '../../functions/api/admin/services';
import { onRequestGet as me } from '../../functions/api/me/index';
import { onRequestGet as stats } from '../../functions/api/admin/downloads';
import { beijingDay, recordDownload } from '../../functions/_lib/downloads';
let env:any;
beforeEach(()=>env={DB:createD1(),ASSETS:{fetch:vi.fn(async()=>new Response('{"apps":[]}'))}});
async function ctx(admin:boolean){
 const user=await upsertUser(env.DB,{provider:'google',id:'admin-test',name:'Test',email:null,avatarUrl:null});
 if(admin) env.DB.raw.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(user.id);
 const cookie=(await createSession(env.DB,user.id,'test')).map(c=>c.split(';')[0]).join('; ');
 return {env,request:new Request('https://aethernative.com/api/admin/',{headers:{Cookie:cookie}})} as any;
}
it('protects all new private APIs and exposes administrator flag only for the actual role',async()=>{
 for(const handler of [overview,services]){
  expect((await handler({env,request:new Request('https://aethernative.com/')} as any)).status).toBe(401);
  expect((await handler(await ctx(false))).status).toBe(403);
 }
 expect((await (await me(await ctx(false))).json()).user.isAdmin).toBe(false);
 expect((await (await me(await ctx(true))).json()).user.isAdmin).toBe(true);
});
it('returns real counters and separate version totals without caching',async()=>{
 await recordDownload(env.DB,'aetherroute','1');await recordDownload(env.DB,'aetherroute','2');await recordDownload(env.DB,'other','1',Date.now()-8*86400_000);
 const adminContext=await ctx(true);
 const userId=env.DB.raw.prepare('SELECT id FROM users LIMIT 1').get().id;
 for(const status of ['new','triaged','replied','closed']) env.DB.raw.prepare('INSERT INTO feedback(id,user_id,app_id,category,title,body,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(status,userId,'general','bug','test','test',status,Date.now(),Date.now());
 const response=await overview(adminContext);expect(response.headers.get('Cache-Control')).toBe('no-store');
 const summary=await response.json();expect(summary.downloads).toEqual({today:2,week:2});expect(summary.feedback.pending).toBe(2);
 const c=await ctx(true);c.request=new Request(`https://aethernative.com/api/admin/downloads?from=${beijingDay()}&to=${beijingDay()}&app=aetherroute`,{headers:c.request.headers});
 const data=await (await stats(c)).json();expect(data.rows).toHaveLength(1);expect(data.versions).toHaveLength(2);expect(data.versions.map((v:any)=>v.requests)).toEqual([1,1]);
});
it('does not return HTML as a health report when assets are missing',async()=>{
 const c=await ctx(true);env.ASSETS.fetch=async()=>new Response('',{status:404});
 expect((await services(c)).status).toBe(503);
});
