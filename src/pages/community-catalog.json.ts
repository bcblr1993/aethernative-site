import type { APIRoute } from 'astro';
import { getApps } from '../lib/apps';
export const GET: APIRoute = async () => new Response(JSON.stringify((await getApps()).map(app => app.id)), { headers: { 'Content-Type': 'application/json' } });
