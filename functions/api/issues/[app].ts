import type { Env } from '../../_lib/env';
import { knownApp } from '../../_lib/community';
import { issueFields } from '../../_lib/issues';
import { error,json } from '../../_lib/http';
export const onRequestGet:PagesFunction<Env,'app'>=async({request,env,params})=>{
 if(!await knownApp(env,request,params.app))return error(404,'not_found');
 const {results}=await env.DB.prepare(`SELECT ${issueFields} FROM known_issues WHERE app_id=? AND published=1 ORDER BY updated_at DESC LIMIT 100`).bind(params.app).all();
 const r=json({issues:results});r.headers.set('Cache-Control','public, max-age=60');return r;
};
