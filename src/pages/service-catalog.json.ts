import type { APIRoute } from 'astro';
import { getApps, getReleases, latestStable } from '../lib/apps';
export const GET: APIRoute = async () => {
  const apps = await Promise.all((await getApps()).map(async app => {
    const release = latestStable(await getReleases(app.id));
    return { id: app.id, name: app.data.name, version: release?.version, download: release?.download,
      sha256: release?.sha256, length: release?.sparkle?.length, edSignature: release?.sparkle?.edSignature,
      appcast: app.data.sparklePublicKey ? `/apps/${app.id}/appcast.xml` : null };
  }));
  return new Response(JSON.stringify({ apps }), { headers: {'Content-Type':'application/json'} });
};
