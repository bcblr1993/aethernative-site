/** 从内容目录读取数据，转换成 feed.ts 的输入（feed.ts 本身不依赖 astro:content，便于单元测试）。 */
import { getCollection } from 'astro:content';
import { getImage } from 'astro:assets';
import { getApps, getNews, getReleases, type App } from './apps';
import type { AppInput, NewsInput } from './feed';

async function toAppInput(app: App, docs: Map<string, AppInput['docs']>): Promise<AppInput> {
  // App 图标：256px PNG（AsyncImage 直接可用，透明背景不丢）
  const icon = await getImage({ src: app.data.icon, width: 256, height: 256, format: 'png' });
  return {
    id: app.id,
    name: app.data.name,
    order: app.data.order,
    featured: app.data.featured,
    icon: icon.src,
    tagline: app.data.tagline,
    summary: app.data.summary,
    platforms: app.data.platforms,
    releases: await getReleases(app.id),
    docs: docs.get(app.id) ?? [],
  };
}

export async function getAppInputs() {
  const docs = new Map<string, AppInput['docs']>();
  for (const d of await getCollection('docs')) {
    const [appId, id] = d.id.split('/') as [string, string];
    docs.set(appId, [...(docs.get(appId) ?? []), { id, title: d.data.title }]);
  }
  return Promise.all((await getApps()).map((a) => toAppInput(a, docs)));
}

export async function getNewsInputs(): Promise<NewsInput[]> {
  return (await getNews()).map((n) => ({ id: n.id, ...n.data }));
}

export const json = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
