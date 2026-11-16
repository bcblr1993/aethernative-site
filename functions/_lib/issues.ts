import type { Env } from './env';
import { knownApp } from './community';
import { boundedBody } from './feedback-screenshots';
import { error,isSameOrigin,json } from './http';
import { hasBearer,requireAdmin } from './session';
export const issueFields='id,app_id,title,title_en,description,description_en,workaround,workaround_en,status,resolved_version,updated_at';
export async function saveIssue(request:Request,env:Env,id?:string) {
 if(!hasBearer(request)&&!isSameOrigin(request))return error(403,'bad_origin');
 const user=await requireAdmin(env.DB,request);if('response' in user)return user.response;
 if(!request.headers.get('Content-Type')?.startsWith('application/json'))return error(415,'unsupported_media_type');
 const bytes=await boundedBody(request,24000);if(!bytes)return error(413,'too_large');
 let v:Record<string,unknown>;try{v=JSON.parse(new TextDecoder().decode(bytes));}catch{return error(400,'bad_json');}
 if(!v||typeof v!=='object'||Array.isArray(v))return error(400,'invalid');
 const limits:Record<string,number>={title:160,title_en:160,description:3000,description_en:3000,workaround:2000,workaround_en:2000,resolved_version:40};
 for(const [key,max]of Object.entries(limits)){if(typeof v[key]!=='string'||(v[key] as string).length>max)return error(400,'invalid');v[key]=(v[key] as string).trim();}
 if(!v.title||!v.description||!['investigating','in_progress','fixed'].includes(String(v.status))||typeof v.published!=='boolean'||(v.status==='fixed'&&!v.resolved_version))return error(400,'invalid');
 if(v.resolved_version&&!/^[A-Za-z0-9._+-]{1,40}$/.test(String(v.resolved_version)))return error(400,'invalid_version');
 if(!await knownApp(env,request,v.app_id))return error(400,'invalid_app');
 if(!Array.isArray(v.feedback_ids)||v.feedback_ids.length>50||v.feedback_ids.some(x=>typeof x!=='string'||x.length>64))return error(400,'invalid_feedback');
 const ids=[...new Set(v.feedback_ids as string[])];
 for(const f of ids){const found=await env.DB.prepare('SELECT app_id FROM feedback WHERE id=?').bind(f).first<{app_id:string}>();if(!found||found.app_id!==v.app_id)return error(400,'feedback_app_mismatch');}
 if(id&&!/^[a-f0-9-]{36}$/.test(id))return error(404,'not_found');
 const old=id?await env.DB.prepare('SELECT app_id FROM known_issues WHERE id=?').bind(id).first<{app_id:string}>():null;
 if(id&&!old)return error(404,'not_found');
 if(old&&old.app_id!==v.app_id)return error(400,'app_immutable');
 // A fixed version must exist in the published release catalog; never invent release links.
 if(v.status==='fixed'){
  const r=await env.ASSETS.fetch(new Request(new URL('/issue-catalog.json',request.url)));
  const versions=await r.json() as Record<string,string[]>;
  if(!r.ok||!versions[String(v.app_id)]?.includes(String(v.resolved_version)))return error(400,'unknown_release');
 }
 const key=id??crypto.randomUUID(),now=Date.now();
 const statements=[env.DB.prepare(`INSERT INTO known_issues(id,app_id,title,title_en,description,description_en,workaround,workaround_en,status,resolved_version,published,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,title_en=excluded.title_en,description=excluded.description,description_en=excluded.description_en,workaround=excluded.workaround,workaround_en=excluded.workaround_en,status=excluded.status,resolved_version=excluded.resolved_version,published=excluded.published,updated_at=excluded.updated_at`).bind(key,v.app_id,v.title,v.title_en,v.description,v.description_en,v.workaround,v.workaround_en,v.status,v.resolved_version,v.published?1:0,now),env.DB.prepare('DELETE FROM issue_feedback WHERE issue_id=?').bind(key)];
 for(const f of ids)statements.push(env.DB.prepare('INSERT INTO issue_feedback(feedback_id,issue_id) VALUES(?,?) ON CONFLICT(feedback_id) DO UPDATE SET issue_id=excluded.issue_id').bind(f,key));
 await env.DB.batch(statements);
 return json({id:key},id?200:201);
}
