import { describe, expect, it } from 'vitest';
import type { Release } from './apps';
import { buildAppDetail, buildAppList, buildFeed, localUrls, releaseId, type AppInput, type NewsInput } from './feed';

const site = new URL('https://aethernative.com');

const rel = (over: Partial<Release> = {}): Release => ({
  version: '1.0.0',
  build: '100',
  date: new Date('2026-09-24T00:00:00Z'),
  channel: 'stable',
  platform: 'mac',
  download: 'https://github.com/x/y/releases/download/v1.0.0/Y.dmg',
  summary: { zh: '中文摘要', en: 'English summary' },
  notes: [],
  ...over,
});

const app = (over: Partial<AppInput> = {}): AppInput => ({
  id: 'demo',
  name: 'Demo',
  order: 1,
  featured: false,
  icon: '/_astro/icon.png',
  tagline: { zh: '标语', en: 'Tagline' },
  summary: 'Same in both',
  platforms: [{ id: 'mac', status: 'available', requirement: 'macOS 15+' }],
  releases: [],
  docs: [],
  ...over,
});

const news = (over: Partial<NewsInput> = {}): NewsInput => ({
  id: 'hello',
  date: new Date('2026-09-24T00:00:00Z'),
  title: { zh: '标题', en: 'Title' },
  summary: { zh: '摘要', en: 'Summary' },
  body: [],
  links: [],
  apps: [],
  pinned: false,
  push: true,
  ...over,
});

describe('buildFeed', () => {
  it('合并公告与版本，按时间倒序；同一天公告在前，同一天的版本按构建号倒序', () => {
    const feed = buildFeed({
      site,
      apps: [
        app({ releases: [rel({ version: '1.1', build: '110' }), rel({ version: '1.0', build: '9', date: new Date('2026-09-20T00:00:00Z') })] }),
        app({ id: 'b', name: 'B', releases: [rel({ version: '2.0', build: '200' })] }),
      ],
      news: [news(), news({ id: 'older', date: new Date('2026-09-21T00:00:00Z') })],
    });
    expect(feed.version).toBe(1);
    expect(feed.items.map((i) => i.id)).toEqual([
      'news:hello',
      'release:b:2.0',
      'release:demo:1.1',
      'news:older',
      'release:demo:1.0',
    ]);
  });

  it('构建号按数值比较，而不是按字符串（9 < 110）', () => {
    const feed = buildFeed({ site, apps: [app({ releases: [rel({ version: 'a', build: '9' }), rel({ version: 'b', build: '110' })] })], news: [] });
    expect(feed.items.map((i) => i.release?.version)).toEqual(['b', 'a']);
  });

  it('技术预览不进入动态；beta 保留渠道信息', () => {
    const feed = buildFeed({
      site,
      apps: [app({ releases: [rel({ version: 'p', channel: 'preview' }), rel({ version: 'b', channel: 'beta' })] })],
      news: [],
    });
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]!.release).toMatchObject({ appId: 'demo', version: 'b', channel: 'beta', platform: 'mac' });
  });

  it('双语字段统一输出 { zh, en }，链接为绝对地址', () => {
    const feed = buildFeed({
      site,
      apps: [app({ releases: [rel({ summary: 'Plain', badge: '正式版' })] })],
      news: [news({ links: [{ label: '反馈', href: '/feedback/' }, { label: 'GitHub', href: 'https://github.com/x' }] })],
    });
    const [n, r] = feed.items;
    expect(n!.url).toEqual({ zh: 'https://aethernative.com/news/hello/', en: 'https://aethernative.com/en/news/hello/' });
    expect(n!.links).toEqual([
      { label: { zh: '反馈', en: '反馈' }, url: { zh: 'https://aethernative.com/feedback/', en: 'https://aethernative.com/en/feedback/' } },
      { label: { zh: 'GitHub', en: 'GitHub' }, url: { zh: 'https://github.com/x', en: 'https://github.com/x' } },
    ]);
    expect(r!.title).toEqual({ zh: 'Demo 1.0.0', en: 'Demo 1.0.0' });
    expect(r!.summary).toEqual({ zh: 'Plain', en: 'Plain' });
    expect(r!.release!.badge).toEqual({ zh: '正式版', en: '正式版' });
    expect(r!.url.en).toBe('https://aethernative.com/en/apps/demo/releases/1.0.0/');
  });

  it('保留公告的 push / pinned 标记；版本一律 push', () => {
    const feed = buildFeed({ site, apps: [app({ releases: [rel()] })], news: [news({ push: false, pinned: true })] });
    expect(feed.items.map((i) => [i.id, i.push, i.pinned])).toEqual([
      ['news:hello', false, true],
      ['release:demo:1.0.0', true, false],
    ]);
  });

  it('按 limit 截取', () => {
    const releases = Array.from({ length: 5 }, (_, i) => rel({ version: `1.${i}`, build: String(i) }));
    expect(buildFeed({ site, apps: [app({ releases })], news: [], limit: 3 }).items).toHaveLength(3);
  });

  it('输入错误时构建失败：重复版本、未知软件、非法文件名', () => {
    expect(() => buildFeed({ site, apps: [app({ releases: [rel(), rel()] })], news: [] })).toThrow(/id 重复/);
    expect(() => buildFeed({ site, apps: [app()], news: [news({ apps: ['nope'] })] })).toThrow(/不存在的软件 nope/);
    expect(() => buildFeed({ site, apps: [], news: [news({ id: 'Bad_Name' })] })).toThrow(/文件名/);
  });
});

describe('localUrls', () => {
  it('拒绝相对路径与非 http 协议', () => {
    expect(() => localUrls(site, 'feedback/')).toThrow();
    expect(() => localUrls(site, 'javascript:alert(1)')).toThrow();
    expect(() => localUrls(site, '//evil.com/x')).toThrow();
  });
});

describe('buildAppList / buildAppDetail', () => {
  const a = app({
    releases: [rel({ version: '2.0', channel: 'beta' }), rel({ version: '1.0', notes: [{ title: { zh: '修复', en: 'Fixes' }, items: ['x'] }] })],
    docs: [{ id: 'privacy', title: { zh: '隐私政策', en: 'Privacy' } }],
  });

  it('latest 取第一条带下载地址的正式版，跳过 beta', () => {
    const list = buildAppList({ site, apps: [a] });
    expect(list.apps[0]).toMatchObject({
      id: 'demo',
      icon: 'https://aethernative.com/_astro/icon.png',
      summary: { zh: 'Same in both', en: 'Same in both' },
      latest: { version: '1.0', date: '2026-09-24T00:00:00.000Z' },
    });
  });

  it('没有正式版时 latest 为空', () => {
    expect(buildAppList({ site, apps: [app({ releases: [rel({ channel: 'beta' })] })] }).apps[0]!.latest).toBeUndefined();
  });

  it('详情包含全部版本（含更新说明）与文档链接；版本 id 与动态一致', () => {
    const d = buildAppDetail({ site, app: a });
    expect(d.releases.map((r) => r.id)).toEqual(['release:demo:2.0', 'release:demo:1.0']);
    expect(d.releases[1]!.notes).toEqual([{ title: { zh: '修复', en: 'Fixes' }, items: [{ zh: 'x', en: 'x' }] }]);
    expect(d.docs).toEqual([
      { id: 'privacy', title: { zh: '隐私政策', en: 'Privacy' }, url: { zh: 'https://aethernative.com/apps/demo/privacy/', en: 'https://aethernative.com/en/apps/demo/privacy/' } },
    ]);
  });
});

describe('产品改名的历史通知兼容', () => {
  it('保留已发布版本的去重 id', () => {
    expect(releaseId('aetherterm', '1.6.1')).toBe(releaseId('apexterm', '1.6.1'));
    expect(releaseId('aetherterm', '1.6.2')).not.toBe(releaseId('aetherterm', '1.6.1'));
    expect(releaseId('aetherroute', '1.3.0')).toBe('release:aetherroute:1.3.0');
  });
});
