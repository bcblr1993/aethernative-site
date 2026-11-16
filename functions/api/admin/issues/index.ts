import type { Env } from '../../../_lib/env';
import { requireAdmin } from '../../../_lib/session';
import { json } from '../../../_lib/http';
import { saveIssue } from '../../../_lib/issues';
export const onRequestGet:PagesFunction<Env>=async({request,env})=>{
 const user=await requireAdmin(env.DB,request);if('response'in user)return user.response;
 const [issues,links]=await Promise.all([env.DB.prepare('SELECT * FROM known_issues ORDER BY updated_at DESC LIMIT 500').all(),env.DB.prepare('SELECT feedback_id,issue_id FROM issue_feedback').all()]);
 return json({issues:issues.results,links:links.results});
};
export const onRequestPost:PagesFunction<Env>=({request,env})=>saveIssue(request,env);
