import type { Env } from '../../_lib/env';
import { requireAdmin } from '../../_lib/session';
import { error,json } from '../../_lib/http';
import { traffic } from '../../_lib/traffic';
export const onRequestGet:PagesFunction<Env>=async({request,env})=>{
 const user=await requireAdmin(env.DB,request);if('response' in user)return user.response;
 const days=Number(new URL(request.url).searchParams.get('days')??7);
 if(![7,30].includes(days))return error(400,'invalid_range');
 return json(await traffic(env,days));
};
