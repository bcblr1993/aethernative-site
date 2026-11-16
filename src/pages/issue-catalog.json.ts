import type { APIRoute } from 'astro';
import { getApps,getReleases } from '../lib/apps';
export const GET:APIRoute=async()=>new Response(JSON.stringify(Object.fromEntries(await Promise.all((await getApps()).map(async a=>[a.id,(await getReleases(a.id)).map(r=>r.version)])))),{headers:{'Content-Type':'application/json'}});
