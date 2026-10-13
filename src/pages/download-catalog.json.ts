import { getApps, getReleases } from '../lib/apps';

/** Public release URLs from this deployment, never a user-supplied redirect target. */
export async function GET() {
  const catalog: Record<string, Record<string, string>> = {};
  for (const app of await getApps()) {
    catalog[app.id] = Object.fromEntries((await getReleases(app.id))
      .filter((r) => r.download).map((r) => [r.version, r.download!]));
  }
  return new Response(JSON.stringify(catalog), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
