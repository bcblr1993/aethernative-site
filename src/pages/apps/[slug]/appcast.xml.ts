/** Sparkle 更新清单：https://aethernative.com/apps/<id>/appcast.xml —— 软件里的 SUFeedURL 指向这里。 */
import type { APIRoute, GetStaticPaths } from 'astro';
import { getApps, getReleases } from '../../../lib/apps';
import { buildAppcast } from '../../../lib/appcast';

export const getStaticPaths = (async () => {
  const apps = await getApps();
  return Promise.all(
    apps
      .filter((app) => app.data.platforms.some((p) => p.id === 'mac'))
      .map(async (app) => ({ params: { slug: app.id }, props: { app, releases: await getReleases(app.id) } })),
  );
}) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props, site }) => {
  const { app, releases } = props as Awaited<ReturnType<typeof getStaticPaths>>[number]['props'];
  const xml = buildAppcast({
    appId: app.id,
    appName: app.data.name,
    site: site!,
    minimumSystemVersion: app.data.minimumSystemVersion,
    releases,
  });
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
