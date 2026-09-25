/**
 * 根据 releases.yaml 生成 Sparkle 2 更新清单（appcast.xml）。
 * 规则：
 * - 只收录填写了 sparkle 签名的 Mac 版本；技术预览（preview）不收录；
 * - beta 版本带 <sparkle:channel>beta</sparkle:channel>，只推送给开启了测试版更新的用户；
 * - 更新说明默认中文，另附 xml:lang="en" 的英文版，Sparkle 按系统语言选择；
 * - 附 sparkle:fullReleaseNotesLink，指向网站上的完整版本说明。
 */
import type { Release } from './apps';
import { t, type Lang, type Loc } from './i18n';

export interface AppcastInput {
  appId: string;
  appName: string;
  site: URL;
  minimumSystemVersion?: string;
  releases: Release[];
  /** 最多收录的版本数，默认 10 */
  limit?: number;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** CDATA 内不能出现 "]]>"，拆成两段。 */
const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

function notesHtml(r: Release, lang: Lang) {
  const parts = [`<p>${esc(t(r.summary as Loc, lang))}</p>`];
  for (const n of r.notes) {
    parts.push(`<h3>${esc(t(n.title as Loc, lang))}</h3>`);
    parts.push(`<ul>${n.items.map((x) => `<li>${esc(t(x as Loc, lang))}</li>`).join('')}</ul>`);
  }
  return parts.join('\n');
}

/** 可以进入 appcast 的版本。 */
export const appcastReleases = (releases: Release[], limit = 10) =>
  releases.filter((r) => r.platform === 'mac' && r.channel !== 'preview' && r.sparkle && r.build && r.download).slice(0, limit);

export function buildAppcast({ appId, appName, site, minimumSystemVersion, releases, limit = 10 }: AppcastInput) {
  const feed = new URL(`/apps/${appId}/appcast.xml`, site).href;
  const items = appcastReleases(releases, limit).map((r) => {
    const sp = r.sparkle!;
    const minSys = sp.minimumSystemVersion ?? minimumSystemVersion;
    const download = new URL(r.download!, site).href;
    const notesZh = new URL(`/apps/${appId}/releases/${r.version}/`, site).href;
    const notesEn = new URL(`/en/apps/${appId}/releases/${r.version}/`, site).href;
    return [
      '    <item>',
      `      <title>Version ${esc(r.version)} (Build ${esc(r.build!)})</title>`,
      `      <pubDate>${r.date.toUTCString()}</pubDate>`,
      `      <sparkle:version>${esc(r.build!)}</sparkle:version>`,
      `      <sparkle:shortVersionString>${esc(r.version)}</sparkle:shortVersionString>`,
      minSys && `      <sparkle:minimumSystemVersion>${esc(minSys)}</sparkle:minimumSystemVersion>`,
      r.channel === 'beta' && '      <sparkle:channel>beta</sparkle:channel>',
      `      <sparkle:fullReleaseNotesLink>${esc(notesZh)}</sparkle:fullReleaseNotesLink>`,
      `      <sparkle:fullReleaseNotesLink xml:lang="en">${esc(notesEn)}</sparkle:fullReleaseNotesLink>`,
      `      <description>${cdata(notesHtml(r, 'zh'))}</description>`,
      `      <description xml:lang="en">${cdata(notesHtml(r, 'en'))}</description>`,
      `      <enclosure url="${esc(download)}" sparkle:edSignature="${esc(sp.edSignature)}" length="${sp.length}" type="application/octet-stream" />`,
      '    </item>',
    ]
      .filter(Boolean)
      .join('\n');
  });

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${esc(appName)} Updates</title>`,
    `    <link>${esc(new URL(`/apps/${appId}/`, site).href)}</link>`,
    `    <atom:link href="${esc(feed)}" rel="self" type="application/rss+xml" />`,
    `    <description>${esc(appName)} release feed</description>`,
    '    <language>zh-CN</language>',
    ...items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}
