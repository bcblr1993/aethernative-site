/**
 * Sparkle 更新清单：https://aethernative.com/apps/<id>/appcast.xml —— 软件里的 SUFeedURL 指向这里。
 * - appcastMode: generate —— 根据 releases.yaml 生成；
 * - appcastMode: mirror   —— 原样返回 src/content/apps/<id>/appcast.xml（软件自己签名的清单，逐字节不改）。
 * 只为配置了 sparklePublicKey 的软件生成。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { APIRoute, GetStaticPaths } from 'astro';
import { getApps, getReleases } from '../../../lib/apps';
import { buildAppcast } from '../../../lib/appcast';

export const getStaticPaths = (async () => {
  const apps = await getApps();
  return Promise.all(
    apps
      .filter((app) => app.data.sparklePublicKey && app.data.platforms.some((p) => p.id === 'mac'))
      .map(async (app) => ({ params: { slug: app.id }, props: { app, releases: await getReleases(app.id) } })),
  );
}) satisfies GetStaticPaths;

const XML = { 'Content-Type': 'application/xml; charset=utf-8' };

export const GET: APIRoute = async ({ props, site }) => {
  const { app, releases } = props as Awaited<ReturnType<typeof getStaticPaths>>[number]['props'];
  if (app.data.appcastMode === 'mirror') {
    const file = join(process.cwd(), 'src/content/apps', app.id, 'appcast.xml');
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch {
      throw new Error(`${app.id} 使用原样转发模式，但缺少 ${file}：请先运行 scripts/sync-release.mjs 同步最新正式版`);
    }
    return new Response(new Uint8Array(bytes), { headers: XML });
  }
  const xml = buildAppcast({
    appId: app.id,
    appName: app.data.name,
    site: site!,
    minimumSystemVersion: app.data.minimumSystemVersion,
    releases,
  });
  return new Response(xml, { headers: XML });
};
