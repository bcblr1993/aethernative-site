import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { checkPackage, scan } from '../scripts/service-health.mjs';
const bytes=new TextEncoder().encode('test package');
const app={id:'test',name:'Test',version:'1.0',download:'https://github.com/test/test/releases/download/1.0/test.dmg',sha256:createHash('sha256').update(bytes).digest('hex'),length:bytes.length};
describe('service health',()=>{
 it('checks actual downloaded bytes and detects hash/size corruption',async()=>{
  const fetcher=async()=>new Response(bytes);
  expect((await checkPackage(app,fetcher)).every((c:{status:string})=>c.status==='ok')).toBe(true);
  const checks=await checkPackage({...app,sha256:'0'.repeat(64),length:1},fetcher);
  expect(checks.filter((c:{status:string})=>c.status==='failed')).toHaveLength(2);
 });
 it('distinguishes first failures, persistent failures, recovery and new versions',async()=>{
  const fail=async()=>new Response('',{status:503});
  const first=await scan({apps:[app]}, {},fail);expect(first.apps[0].status).toBe('suspect');
  const second=await scan({apps:[app]},first,fail);expect(second.apps[0].status).toBe('failed');
  const recovery=await scan({apps:[app]},second,async()=>new Response(bytes));expect(recovery.apps[0].failures).toBe(0);
  const changed=await scan({apps:[{...app,version:'2'}]},second,fail);expect(changed.apps[0].status).toBe('suspect');
 });
 it('rejects mismatched update feed and explicitly skips missing metadata',async()=>{
  const fetcher:typeof fetch=async(input)=>new Response(new URL(input instanceof Request?input.url:String(input)).pathname.endsWith('.xml')?'<rss><channel /></rss>':bytes);
  expect((await checkPackage({...app,appcast:'/feed.xml'},fetcher)).at(-1)?.status).toBe('failed');
  expect((await checkPackage({...app,sha256:undefined,length:undefined},fetcher)).filter((c:{status:string})=>c.status==='skipped')).toHaveLength(2);
 });
});
