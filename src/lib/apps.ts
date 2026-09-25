import { getCollection, getEntry, type CollectionEntry } from 'astro:content';

export type App = CollectionEntry<'apps'>;
export type Release = CollectionEntry<'releases'>['data']['releases'][number];

/** 按 order 排序的全部软件。 */
export async function getApps() {
  const apps = await getCollection('apps');
  return apps.sort((a, b) => a.data.order - b.data.order || a.data.name.localeCompare(b.data.name));
}

/** 某款软件的版本记录（按文件顺序，最新的在最上面）。 */
export async function getReleases(appId: string): Promise<Release[]> {
  return (await getEntry('releases', appId))?.data.releases ?? [];
}

/** 最新的正式版：第一条带下载地址的 stable 记录。 */
export const latestStable = (rs: Release[]) => rs.find((r) => r.channel === 'stable' && r.download);

/** 所有软件的最近更新，按日期倒序。 */
export async function getRecentReleases(limit = 5) {
  const apps = await getApps();
  const all = await Promise.all(
    apps.map(async (app) => (await getReleases(app.id)).map((release) => ({ app, release }))),
  );
  return all
    .flat()
    .sort((a, b) => b.release.date.getTime() - a.release.date.getTime() || (b.release.build ?? '').localeCompare(a.release.build ?? ''))
    .slice(0, limit);
}

/** 版本在 URL 中使用的片段，例如 1.0.27、0.1.0-preview。 */
export const versionSlug = (r: Release) => r.version;
