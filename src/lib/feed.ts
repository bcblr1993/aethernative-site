/**
 * App 与推送服务读取的 JSON 数据（契约见 docs/api.md，结构变化时提高 FEED_VERSION）：
 *   /feed.json            官方动态：公告 + 各软件版本，按时间倒序
 *   /apps.json            软件列表
 *   /apps/<id>/app.json   单个软件：介绍、全部版本（含更新说明）、文档链接
 * 规则：
 * - 双语字段一律输出 { zh, en }（专有名词两种语言相同），客户端按系统语言选择；
 * - 链接一律为绝对地址；
 * - 技术预览（preview）不进入动态；
 * - id 一经发布不能改变：推送服务用它去重，改了会重复推送。
 */
import type { Release } from './apps';
import type { Loc } from './i18n';

export const FEED_VERSION = 1;
export const FEED_LIMIT = 50;

export type Bi = { zh: string; en: string };
export const bi = (v: Loc): Bi => (typeof v === 'string' ? { zh: v, en: v } : { zh: v.zh, en: v.en });
const biOpt = (v: Loc | undefined) => (v === undefined ? undefined : bi(v));

/** 中文页面在根路径，英文页面加 /en 前缀。p 以 / 开头。 */
export const pageUrls = (site: URL, p: string): Bi => ({ zh: new URL(p, site).href, en: new URL(`/en${p}`, site).href });

export interface NewsInput {
  id: string;
  date: Date;
  title: Loc;
  summary: Loc;
  body: Loc[];
  links: { label: Loc; href: string }[];
  apps: string[];
  pinned: boolean;
  push: boolean;
}

export interface AppInput {
  id: string;
  name: string;
  order: number;
  featured: boolean;
  /** 构建后的图标地址（站内路径） */
  icon: string;
  tagline: Loc;
  summary: Loc;
  platforms: { id: 'mac' | 'ios'; status: string; requirement: Loc; appStore?: string; testFlight?: string }[];
  releases: Release[];
  docs: { id: string; title: Loc }[];
}

export interface FeedItem {
  id: string;
  kind: 'news' | 'release';
  date: string;
  title: Bi;
  summary: Bi;
  url: Bi;
  /** 关联的软件 */
  appIds: string[];
  pinned: boolean;
  /** 是否应该推送（推送服务还会按用户订阅过滤） */
  push: boolean;
  /** kind = news */
  body?: Bi[];
  links?: { label: Bi; url: Bi }[];
  /** kind = release */
  release?: { appId: string; version: string; build?: string; channel: 'stable' | 'beta'; platform: 'mac' | 'ios'; badge?: Bi };
}

export const releaseId = (appId: string, version: string) => `release:${appId}:${version}`;
export const newsId = (id: string) => `news:${id}`;

/** 新闻 id 来自文件名，只允许小写字母、数字和连字符，避免出现在网址和推送去重键里出问题。 */
const NEWS_ID = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

const abs = (site: URL, h: string) => new URL(h, site).href;

/** 站内路径（/ 开头）按语言生成两个地址；外部链接两种语言相同。 */
export function localUrls(site: URL, h: string): Bi {
  if (h.startsWith('/') && !h.startsWith('//')) return pageUrls(site, h);
  if (!/^https?:\/\//.test(h)) throw new Error(`链接应为站内路径（/ 开头）或 http(s) 地址：${h}`);
  return { zh: h, en: h };
}

export function buildFeed({ site, apps, news, limit = FEED_LIMIT }: { site: URL; apps: AppInput[]; news: NewsInput[]; limit?: number }) {
  const appIds = new Set(apps.map((a) => a.id));
  const items: (FeedItem & { sortKey: string })[] = [];

  for (const n of news) {
    if (!NEWS_ID.test(n.id)) throw new Error(`news/${n.id}.yaml：文件名只能包含小写字母、数字和连字符`);
    const unknown = n.apps.filter((a) => !appIds.has(a));
    if (unknown.length) throw new Error(`news/${n.id}.yaml：apps 里有不存在的软件 ${unknown.join(', ')}`);
    items.push({
      id: newsId(n.id),
      kind: 'news',
      date: n.date.toISOString(),
      title: bi(n.title),
      summary: bi(n.summary),
      url: pageUrls(site, `/news/${n.id}/`),
      appIds: n.apps,
      pinned: n.pinned,
      push: n.push,
      body: n.body.map(bi),
      links: n.links.map((l) => ({ label: bi(l.label), url: localUrls(site, l.href) })),
      // 同一天里公告排在版本前面
      sortKey: `${n.date.toISOString()}|1`,
    });
  }

  for (const app of apps) {
    for (const r of app.releases) {
      if (r.channel === 'preview') continue;
      items.push({
        id: releaseId(app.id, r.version),
        kind: 'release',
        date: r.date.toISOString(),
        title: bi(`${app.name} ${r.version}`),
        summary: bi(r.summary),
        url: pageUrls(site, `/apps/${app.id}/releases/${r.version}/`),
        appIds: [app.id],
        pinned: false,
        push: true,
        release: {
          appId: app.id,
          version: r.version,
          build: r.build,
          channel: r.channel,
          platform: r.platform,
          badge: biOpt(r.badge),
        },
        sortKey: `${r.date.toISOString()}|0|${(r.build ?? '').padStart(20, '0')}`,
      });
    }
  }

  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.id)) throw new Error(`动态条目 id 重复：${it.id}（同一软件不能有两个相同版本号）`);
    seen.add(it.id);
  }

  return {
    version: FEED_VERSION,
    items: items
      .sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0))
      .slice(0, limit)
      .map(({ sortKey: _, ...it }) => it),
  };
}

/** 最新的正式版：第一条带下载地址的 stable 记录（与网站首页一致）。 */
const latest = (rs: Release[]) => rs.find((r) => r.channel === 'stable' && r.download);

function appSummary(site: URL, a: AppInput) {
  const l = latest(a.releases);
  return {
    id: a.id,
    name: a.name,
    order: a.order,
    featured: a.featured,
    icon: abs(site, a.icon),
    tagline: bi(a.tagline),
    summary: bi(a.summary),
    url: pageUrls(site, `/apps/${a.id}/`),
    platforms: a.platforms.map((p) => ({
      id: p.id,
      status: p.status,
      requirement: bi(p.requirement),
      appStore: p.appStore,
      testFlight: p.testFlight,
    })),
    latest: l && { version: l.version, date: l.date.toISOString(), url: pageUrls(site, `/apps/${a.id}/releases/${l.version}/`) },
  };
}

export function buildAppList({ site, apps }: { site: URL; apps: AppInput[] }) {
  return { version: FEED_VERSION, apps: apps.map((a) => appSummary(site, a)) };
}

export function buildAppDetail({ site, app }: { site: URL; app: AppInput }) {
  return {
    version: FEED_VERSION,
    app: appSummary(site, app),
    releases: app.releases.map((r) => ({
      id: releaseId(app.id, r.version),
      version: r.version,
      build: r.build,
      date: r.date.toISOString(),
      channel: r.channel,
      platform: r.platform,
      badge: biOpt(r.badge),
      summary: bi(r.summary),
      notes: r.notes.map((n) => ({ title: bi(n.title), items: n.items.map(bi) })),
      download: r.download && abs(site, r.download),
      github: r.github,
      sha256: r.sha256,
      url: pageUrls(site, `/apps/${app.id}/releases/${r.version}/`),
    })),
    docs: app.docs.map((d) => ({ id: d.id, title: bi(d.title), url: pageUrls(site, `/apps/${app.id}/${d.id}/`) })),
  };
}
