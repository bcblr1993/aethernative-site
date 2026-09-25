import { describe, expect, it } from 'vitest';
import { appcastReleases, buildAppcast } from './appcast';
import type { Release } from './apps';

const SIG = 'A'.repeat(86) + '==';
const site = new URL('https://aethernative.com');

const rel = (over: Partial<Release> = {}): Release => ({
  version: '1.0.0',
  build: '100',
  date: new Date('2026-09-24T00:00:00Z'),
  channel: 'stable',
  platform: 'mac',
  requirement: 'macOS 15+',
  download: 'https://github.com/x/y/releases/download/v1.0.0/Y.dmg',
  summary: { zh: '中文摘要', en: 'English summary' },
  notes: [],
  sparkle: { edSignature: SIG, length: 123 },
  ...over,
});

const build = (releases: Release[], extra: { limit?: number; minimumSystemVersion?: string } = {}) =>
  buildAppcast({ appId: 'demo', appName: 'Demo', site, releases, ...extra });

describe('appcastReleases', () => {
  it('只收录已签名、非预览、Mac 平台且有构建号和下载地址的版本', () => {
    const list = appcastReleases([
      rel({ version: 'ok' }),
      rel({ version: 'unsigned', sparkle: undefined }),
      rel({ version: 'preview', channel: 'preview' }),
      rel({ version: 'ios', platform: 'ios' }),
      rel({ version: 'nobuild', build: undefined }),
      rel({ version: 'nodownload', download: undefined }),
    ]);
    expect(list.map((r) => r.version)).toEqual(['ok']);
  });

  it('按 limit 截取最新的若干条', () => {
    const list = appcastReleases([rel({ version: '3' }), rel({ version: '2' }), rel({ version: '1' })], 2);
    expect(list.map((r) => r.version)).toEqual(['3', '2']);
  });
});

describe('buildAppcast', () => {
  it('输出 Sparkle 必需字段', () => {
    const xml = build([rel()], { minimumSystemVersion: '15.0' });
    expect(xml).toContain('<sparkle:version>100</sparkle:version>');
    expect(xml).toContain('<sparkle:shortVersionString>1.0.0</sparkle:shortVersionString>');
    expect(xml).toContain('<sparkle:minimumSystemVersion>15.0</sparkle:minimumSystemVersion>');
    expect(xml).toContain(`sparkle:edSignature="${SIG}" length="123"`);
    expect(xml).toContain('<atom:link href="https://aethernative.com/apps/demo/appcast.xml"');
    expect(xml).not.toContain('<sparkle:channel>');
  });

  it('单个版本的 minimumSystemVersion 覆盖软件级设置', () => {
    const xml = build([rel({ sparkle: { edSignature: SIG, length: 1, minimumSystemVersion: '26.0' } })], { minimumSystemVersion: '15.0' });
    expect(xml).toContain('<sparkle:minimumSystemVersion>26.0</sparkle:minimumSystemVersion>');
    expect(xml).not.toContain('>15.0<');
  });

  it('beta 版本带测试频道标记', () => {
    expect(build([rel({ channel: 'beta' })])).toContain('<sparkle:channel>beta</sparkle:channel>');
  });

  it('站内相对下载地址会补全为绝对地址', () => {
    expect(build([rel({ download: '/downloads/Y.zip' })])).toContain('url="https://aethernative.com/downloads/Y.zip"');
  });

  it('中英文说明分别输出，英文带 xml:lang', () => {
    const xml = build([rel({ notes: [{ title: { zh: '修复', en: 'Fixes' }, items: [{ zh: '甲', en: 'A' }] }] })]);
    expect(xml).toMatch(/<description><!\[CDATA\[<p>中文摘要<\/p>\n<h3>修复<\/h3>\n<ul><li>甲<\/li><\/ul>\]\]><\/description>/);
    expect(xml).toMatch(/<description xml:lang="en"><!\[CDATA\[<p>English summary<\/p>/);
    expect(xml).toContain('<sparkle:fullReleaseNotesLink xml:lang="en">https://aethernative.com/en/apps/demo/releases/1.0.0/</sparkle:fullReleaseNotesLink>');
  });

  it('转义 HTML 特殊字符，并安全处理 CDATA 结束符', () => {
    const xml = build([rel({ summary: 'a < b & c ]]> d', download: 'https://x.test/a.dmg?x=1&y=2' })]);
    // 先做 HTML 转义，"]]>" 变成 "]]&gt;"，不会提前结束 CDATA
    expect(xml).toContain('<p>a &lt; b &amp; c ]]&gt; d</p>');
    const body = xml.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1] ?? '';
    expect(body).not.toContain(']]>');
    expect(xml).toContain('url="https://x.test/a.dmg?x=1&amp;y=2"');
  });

  it('没有可发布版本时仍输出合法的空清单', () => {
    const xml = build([rel({ sparkle: undefined })]);
    expect(xml).not.toContain('<item>');
    expect(xml).toContain('</channel>');
  });
});
