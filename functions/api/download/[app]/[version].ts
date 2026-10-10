import type { Env } from '../../../_lib/env';
import { recordDownload, safeDownloadTarget, shouldCountDownload, validApp, validVersion } from '../../../_lib/downloads';
import { error } from '../../../_lib/http';

export const onRequest: PagesFunction<Env> = async ({ request, params, env, waitUntil }) => {
  if (!['GET', 'HEAD'].includes(request.method)) return error(405, 'method_not_allowed', { Allow: 'GET, HEAD' });
  const app = String(params.app ?? '');
  const version = String(params.version ?? '');
  if (!validApp(app) || !validVersion(version)) return error(404, 'download_not_found');
  // Use Pages' asset binding, so this deployment's catalog and buttons always agree.
  let target: string | null = null;
  try {
    const response = await env.ASSETS.fetch(new Request(new URL('/download-catalog.json', request.url)));
    if (!response.ok) return error(503, 'download_catalog_unavailable');
    const catalog = await response.json() as Record<string, Record<string, unknown>>;
    const versions = Object.hasOwn(catalog, app) ? catalog[app] : undefined;
    target = safeDownloadTarget(versions && Object.hasOwn(versions, version) ? versions[version] : null);
  } catch { return error(503, 'download_catalog_unavailable'); }
  if (!target) return error(404, 'download_not_found');
  if (shouldCountDownload(request)) {
    // A statistics failure must not prevent the user from downloading the installer.
    waitUntil(recordDownload(env.DB, app, version).catch(() => console.warn('download_daily_write_failed')));
  }
  return new Response(null, { status: 302, headers: {
    Location: target, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
  } });
};
