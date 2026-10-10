import type { Env } from '../../_lib/env';
import { requireAdmin } from '../../_lib/session';
import { error, json } from '../../_lib/http';
export const onRequestGet: PagesFunction<Env> = async ({request,env}) => {
  const admin=await requireAdmin(env.DB,request);
  if('response' in admin) return admin.response;
  const response=await env.ASSETS.fetch(new URL('/service-health.json',request.url));
  if(!response.ok) return error(503,'report_unavailable');
  const catalog=await env.ASSETS.fetch(new URL('/service-catalog.json',request.url));
  if(!catalog.ok) return error(503,'catalog_unavailable');
  return json({report:await response.json(),catalog:await catalog.json()});
};
