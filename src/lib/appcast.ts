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
 * Sparkle 在 WebView 里显示更新说明，没有任何默认样式。这里内联一套与 App
 * 设计语言一致的样式：系统字体、自动深浅色；摘要作导语，左侧一条渐变细条；
 * 每个分组标题前是一个渐变圆角图标块（同 App 侧边栏的图标块），按类别取
 * 系统色：新功能蓝、修复绿、优化橙、其他灰。Sparkle 的说明区自带描边，所以
 * 分组不再画卡片（框中框显得拥挤）。图标是内联 SVG，不加载任何外部资源
 * （更新窗口可能离线打开）；HTML 结构不变，图标全部由 CSS 伪元素绘制。
 */
const NOTES_STYLE = `<style>
:root{color-scheme:light dark;--text:#1d1d1f;--sub:#6e6e73;
--feature-a:#4aa8ff;--feature-b:#0a6cff;--fix-a:#5ad66f;--fix-b:#22a845;
--improve-a:#ffbd4a;--improve-b:#ff8c00;--other-a:#aeaeb2;--other-b:#7c7c80}
@media (prefers-color-scheme:dark){:root{--text:#f5f5f7;--sub:#a1a1a6}}
body{margin:0;padding:14px 18px 16px;font:13px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Helvetica Neue",sans-serif;color:var(--text);-webkit-font-smoothing:antialiased}
.summary{position:relative;margin:0 0 18px;padding:1px 0 1px 13px;font-size:14px;line-height:1.55;font-weight:500;letter-spacing:.005em}
.summary::before{content:"";position:absolute;left:0;top:2px;bottom:2px;width:3px;border-radius:2px;background:linear-gradient(180deg,#4aa8ff,#30c6c0)}
.group{margin:0 0 16px}
.group:last-child{margin-bottom:0}
.tag{position:relative;display:flex;align-items:center;min-height:22px;margin:0 0 7px;padding-left:31px;font-size:13px;font-weight:600;letter-spacing:.01em;color:var(--text)}
.tag::before,.tag::after{content:"";position:absolute;left:0;top:50%;width:22px;height:22px;margin-top:-11px;border-radius:6px}
.tag::before{background:linear-gradient(160deg,var(--a),var(--b));box-shadow:inset 0 0 0 .5px rgba(0,0,0,.08)}
.tag::after{background:var(--glyph) center/15px 15px no-repeat}
.group ul{margin:0;padding:0 0 0 31px;list-style:none}
.group li{position:relative;margin:0 0 5px;color:var(--text)}
.group li:last-child{margin-bottom:0}
.group li::before{content:"";position:absolute;left:-14px;top:.66em;width:5px;height:5px;border-radius:50%;background:var(--a);opacity:.85}
.feature{--a:var(--feature-a);--b:var(--feature-b);--glyph:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%3E%3Cpath%20fill%3D%22white%22%20d%3D%22M11%203.5l1.7%205%205%201.7-5%201.7-1.7%205-1.7-5-5-1.7%205-1.7z%22%2F%3E%3Cpath%20fill%3D%22white%22%20d%3D%22M18%2013.5l.8%202.2%202.2.8-2.2.8-.8%202.2-.8-2.2-2.2-.8%202.2-.8z%22%2F%3E%3C%2Fsvg%3E")}
.fix{--a:var(--fix-a);--b:var(--fix-b);--glyph:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%3E%3Cpath%20fill%3D%22none%22%20stroke%3D%22white%22%20stroke-width%3D%222.8%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20d%3D%22M6%2012.6l4%204L18.2%208%22%2F%3E%3C%2Fsvg%3E")}
.improve{--a:var(--improve-a);--b:var(--improve-b);--glyph:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%3E%3Cpath%20fill%3D%22white%22%20d%3D%22M13.2%202.8%205.6%2013.2h5.6l-.9%208%207.6-10.4h-5.6z%22%2F%3E%3C%2Fsvg%3E")}
.other{--a:var(--other-a);--b:var(--other-b);--glyph:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%3E%3Ccircle%20cx%3D%2212%22%20cy%3D%227.2%22%20r%3D%221.7%22%20fill%3D%22white%22%2F%3E%3Cpath%20stroke%3D%22white%22%20stroke-width%3D%222.8%22%20stroke-linecap%3D%22round%22%20d%3D%22M12%2011.2v6.4%22%2F%3E%3C%2Fsvg%3E")}
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
