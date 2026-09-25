export const langs = ['zh', 'en'] as const;
export type Lang = (typeof langs)[number];
export type Loc = string | { zh: string; en: string };

/** 取当前语言的文本。 */
export const t = (v: Loc | undefined, lang: Lang): string => (v === undefined ? '' : typeof v === 'string' ? v : v[lang]);

/** 站内链接：中文在根路径，英文加 /en 前缀。p 需以 / 开头并以 / 结尾。 */
export const href = (lang: Lang, p = '/') => (lang === 'zh' ? p : `/en${p}`);

/** 当前页面在另一种语言下的地址。 */
export function altHref(pathname: string, lang: Lang) {
  if (lang === 'en') return pathname.replace(/^\/en(?=\/|$)/, '') || '/';
  return `/en${pathname}`;
}

/** [...lang] 路由的两个语言版本：中文 lang 为 undefined（根路径），英文为 'en'。 */
export const langParams = () =>
  langs.map((lang) => ({ params: { lang: lang === 'zh' ? undefined : lang }, props: { lang } }));

export const fmtDate = (d: Date, lang: Lang) =>
  lang === 'zh'
    ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

export const site = {
  name: 'Aether Native',
  author: { zh: '编程不良人', en: 'BianChengBuLiangRen' },
  github: 'https://github.com/bcblr1993',
};

export const ui = {
  zh: {
    htmlLang: 'zh-CN',
    tagline: '为 Apple 芯片原生打造',
    description: '专为 Apple M 系列芯片深度优化的原生 Mac 与 iPhone 软件。',
    nav: { apps: '软件', why: '理念', updates: '更新', about: '关于', support: '支持' },
    switchLang: 'EN',
    switchLangLabel: 'Switch to English',
    theme: '切换深浅色',
    skip: '跳到正文',
    platform: { mac: 'Mac', ios: 'iPhone' },
    status: { available: '', beta: '测试版', coming: '即将上架', dev: '开发中' },
    filter: { all: '全部', mac: 'Mac', ios: 'iPhone' },
    download: (v: string) => `下载 ${v}`,
    macDownload: (v: string) => `Mac · 下载 ${v}`,
    learnMore: '了解更多',
    releaseNotes: '版本说明',
    allReleases: '全部版本记录',
    viewDetails: '查看详情',
    latest: '最新版本',
    previous: '历史版本',
    preview: '技术预览',
    beta: '测试版',
    build: '构建',
    sha: 'SHA-256',
    copy: '复制',
    copied: '已复制',
    github: 'GitHub',
    githubRelease: 'GitHub Release',
    noDownload: '该版本已归档，不再提供下载。',
    privacy: '隐私政策',
    license: '许可协议',
    help: '使用帮助',
    releases: '版本记录',
    footer: '为 Apple 芯片精心打造',
    madeBy: '由编程不良人用心打造',
    moreSoon: '更多原生软件正在开发中，完成后会第一时间出现在这里。',
    benchmarkNote: '* 数据来自 AetherRoute Mac 版实测',
    compare: '查看完整对比与测试说明',
    explore: '了解细节',
    screenshots: '真实软件界面',
    openFull: '查看原图 ↗',
    backTo: (n: string) => `← 返回 ${n}`,
  },
  en: {
    htmlLang: 'en',
    tagline: 'Built natively for Apple silicon',
    description: 'Native Mac and iPhone apps, deeply optimized for Apple M-series chips.',
    nav: { apps: 'Apps', why: 'Philosophy', updates: 'Updates', about: 'About', support: 'Support' },
    switchLang: '中文',
    switchLangLabel: '切换到中文',
    theme: 'Toggle appearance',
    skip: 'Skip to content',
    platform: { mac: 'Mac', ios: 'iPhone' },
    status: { available: '', beta: 'Beta', coming: 'Coming soon', dev: 'In development' },
    filter: { all: 'All', mac: 'Mac', ios: 'iPhone' },
    download: (v: string) => `Download ${v}`,
    macDownload: (v: string) => `Mac · Get ${v}`,
    learnMore: 'Learn more',
    releaseNotes: 'Release notes',
    allReleases: 'All releases',
    viewDetails: 'View details',
    latest: 'Latest release',
    previous: 'Previous release',
    preview: 'Technical preview',
    beta: 'Beta',
    build: 'Build',
    sha: 'SHA-256',
    copy: 'Copy',
    copied: 'Copied',
    github: 'GitHub',
    githubRelease: 'GitHub Release',
    noDownload: 'This release is archived and no longer available for download.',
    privacy: 'Privacy',
    license: 'License',
    help: 'Help',
    releases: 'Releases',
    footer: 'Crafted for Apple silicon',
    madeBy: 'Made with care by BianChengBuLiangRen',
    moreSoon: 'More native apps are in development and will appear here as soon as they are ready.',
    benchmarkNote: '* Measured with AetherRoute for Mac',
    compare: 'Explore the comparison & test notes',
    explore: 'Explore the details',
    screenshots: 'Real app screenshots',
    openFull: 'View full size ↗',
    backTo: (n: string) => `← Back to ${n}`,
  },
} as const;
