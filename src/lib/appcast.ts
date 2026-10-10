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

/**
 * Sparkle 在 WebView 里显示更新说明，没有任何默认样式。这里内联一套贴近 macOS
 * 原生发布说明的样式：系统字体与正文字号、自动深浅色、统一的左边距。
 * Sparkle 的说明区自带描边，所以分组不再画卡片与边框（框中框显得拥挤）；
 * 分组只用标题前的小圆点区分类别，配色取系统色：新功能蓝、修复绿、优化橙、其他灰。
 * 不加载任何外部资源（更新窗口可能离线打开）。
 */
const NOTES_STYLE = `<style>
:root{color-scheme:light dark;--text:#1d1d1f;--sub:#6e6e73;--line:rgba(0,0,0,.1);
--feature:#007aff;--fix:#28a745;--improve:#f08a00;--other:#8e8e93}
@media (prefers-color-scheme:dark){:root{--text:#f5f5f7;--sub:#a1a1a6;--line:rgba(255,255,255,.12);
--feature:#0a84ff;--fix:#32d74b;--improve:#ff9f0a;--other:#98989d}}
body{margin:0;padding:12px 16px 14px;font:13px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Helvetica Neue",sans-serif;color:var(--text);-webkit-font-smoothing:antialiased}
.summary{margin:0 0 14px;color:var(--text)}
.group{margin:0;padding:12px 0 0;border-top:1px solid var(--line)}
.group+.group{margin-top:12px}
.tag{display:flex;align-items:center;gap:7px;margin:0 0 6px;font-size:13px;font-weight:600;color:var(--text)}
.tag::before{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:var(--accent)}
.group ul{margin:0;padding:0 0 0 14px;list-style:none}
.group li{position:relative;margin:0 0 4px;color:var(--text)}
.group li:last-child{margin-bottom:0}
.group li::before{content:"";position:absolute;left:-11px;top:.62em;width:4px;height:4px;border-radius:50%;background:var(--sub);opacity:.7}
.feature{--accent:var(--feature)}
.fix{--accent:var(--fix)}
.improve{--accent:var(--improve)}
.other{--accent:var(--other)}
</style>`;

type NoteKind = 'feature' | 'fix' | 'improve' | 'other';

/** 按分组标题（中英文都看）决定配色；"修复与优化"这类混合标题按修复处理。 */
export function noteKind(title: Loc | string): NoteKind {
  const text = typeof title === 'string' ? title : `${title.zh ?? ''} ${title.en ?? ''}`;
  if (/新功能|新增|new|feature/i.test(text)) return 'feature';
  if (/修复|fix|bug/i.test(text)) return 'fix';
  if (/优化|改进|性能|体验|improve|performance|polish/i.test(text)) return 'improve';
  return 'other';
}

function notesHtml(r: Release, lang: Lang) {
  const parts = [NOTES_STYLE, `<p class="summary">${esc(t(r.summary as Loc, lang))}</p>`];
  for (const n of r.notes) {
    parts.push(
      `<section class="group ${noteKind(n.title as Loc)}">` +
        `<h3 class="tag">${esc(t(n.title as Loc, lang))}</h3>` +
        `<ul>${n.items.map((x) => `<li>${esc(t(x as Loc, lang))}</li>`).join('')}</ul>` +
        `</section>`,
    );
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
