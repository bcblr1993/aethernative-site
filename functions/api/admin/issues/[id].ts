import type { Env } from '../../../_lib/env';
import { saveIssue } from '../../../_lib/issues';
import { error } from '../../../_lib/http';
export const onRequestPatch:PagesFunction<Env,'id'>=({request,env,params})=>typeof params.id==='string'?saveIssue(request,env,params.id):Promise.resolve(error(404,'not_found'));
