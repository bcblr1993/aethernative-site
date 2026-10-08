import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

/**
 * 内容目录：src/content/apps/<软件 id>/
 *   app.yaml        软件介绍（首页卡片 + 详情页）
 *   releases.yaml   版本记录
 *   docs/*.yaml     隐私政策、许可协议、使用帮助等文档页
 *   media/          图标与截图（构建时自动压缩成 WebP）
 */

/** 双语文本：写成 { zh, en }；专有名词等不需要翻译的可以直接写字符串。 */
const L = z.union([z.string(), z.object({ zh: z.string(), en: z.string() })]);
const base = './src/content/apps';
const appId = ({ entry }: { entry: string }) => entry.split('/')[0];

const apps = defineCollection({
  loader: glob({ pattern: '*/app.yaml', base, generateId: appId }),
  schema: ({ image }) => {
    // 截图：zh 必填；en、深色版（zhDark / enDark）可选。有深色版时图集显示浅色/深色开关。
    const shot = z.object({
      label: L,
      zh: image(),
      en: image().optional(),
      zhDark: image().optional(),
      enDark: image().optional(),
    });
    return z.object({
      name: z.string(),
      order: z.number().default(100),
      featured: z.boolean().default(false),
      icon: image(),
      tagline: L,
      summary: L,
      tech: z.array(z.string()).default([]),
      repo: z.url().optional(),
      /** Mac 版最低系统版本，写进 appcast 的 sparkle:minimumSystemVersion（单个版本可覆盖） */
      minimumSystemVersion: z.string().regex(/^\d+(\.\d+)*$/).optional(),
      /** Sparkle 公钥（Info.plist 的 SUPublicEDKey）。同步发版时用它核对签名，防止写入错误签名 */
      sparklePublicKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/).optional(),
      /** 软件仓库中 appcast.xml 的路径；Release 正文没写签名时从这里读取（默认 appcast.xml） */
      appcastPath: z.string().optional(),
      /**
       * 更新清单来源：generate（默认）由官网根据版本记录生成；
       * mirror 原样转发软件自己签名的 appcast.xml（软件开启了 SURequireSignedFeed 时必须用这个）
       */
      appcastMode: z.enum(['generate', 'mirror']).default('generate'),
      platforms: z.array(
        z.object({
          id: z.enum(['mac', 'ios']),
          status: z.enum(['available', 'beta', 'coming', 'dev']),
          requirement: L,
          appStore: z.url().optional(),
          testFlight: z.url().optional(),
        }),
      ),
      cardStats: z.array(z.object({ value: L, label: L })).default([]),
      hero: z.object({ eyebrow: L, title: L, lead: L, requirements: L }),
      /** 显著位置的声明（如“非官方工具”），显示在首屏下载按钮下方 */
      notice: L.optional(),
      /** 界面展示：按原始尺寸展示的界面小图（适合菜单栏、浮窗等局部截图） */
      showcase: z
        .object({
          eyebrow: L,
          title: L,
          lead: L.optional(),
          note: L.optional(),
          items: z.array(z.object({ title: L, caption: L, image: image() })),
        })
        .optional(),
      gallery: z.array(shot).default([]),
      /** Screenshots captured in the app's actual named themes, independently selectable. */
      themeGallery: z.object({
        note: L,
        themes: z.array(z.object({
          id: z.string().regex(/^[a-z0-9-]+$/),
          name: L,
          appearance: z.enum(['light', 'dark']),
          shots: z.array(shot).min(1),
        })).min(2),
      }).superRefine((gallery, ctx) => {
        const ids = gallery.themes.map((theme) => theme.id);
        if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Theme ids must be unique' });
        const labels = gallery.themes[0].shots.map((shot) => JSON.stringify(shot.label));
        for (const theme of gallery.themes) {
          if (theme.shots.length !== labels.length || theme.shots.some((shot, i) => JSON.stringify(shot.label) !== labels[i])) {
            ctx.addIssue({ code: 'custom', message: 'Every theme must provide the same screens in the same order' });
          }
        }
      }).optional(),
      ios: z
        .object({
          badge: L,
          title: L,
          lead: L,
          chips: z.array(z.string()),
          image: image(),
          status: L,
          requirements: L,
          notice: L,
          features: z.array(z.object({ kicker: z.string(), title: L, body: L })),
          shotsTitle: L,
          shotsNote: L,
          shots: z.array(z.object({ title: L, caption: L, image: image() })),
        })
        .optional(),
      sync: z
        .object({
          eyebrow: L,
          title: L,
          lead: L,
          image: image(),
          imageAlt: L,
          points: z.array(z.object({ title: L, body: L })),
          note: L,
        })
        .optional(),
      experience: z
        .object({ eyebrow: L, title: L, cards: z.array(z.object({ title: L, body: L })) })
        .optional(),
      protocols: z
        .object({
          eyebrow: L,
          title: L,
          lead: L,
          items: z.array(z.object({ name: z.string(), tag: z.string(), body: L, chips: z.array(z.string()) })),
          tools: z.array(z.object({ title: L, body: L })).default([]),
        })
        .optional(),
      features: z
        .object({
          eyebrow: L,
          title: L,
          lead: L,
          items: z.array(z.object({ kicker: L, title: L, body: L, details: z.array(L).default([]) })),
        })
        .optional(),
      benchmarks: z
        .object({
          eyebrow: L,
          title: L,
          lead: L,
          stats: z.array(z.object({ value: L, label: L, note: L })),
          table: z
            .object({
              columns: z.array(L),
              rows: z.array(z.object({ metric: L, cells: z.array(z.object({ value: L, note: L })) })),
            })
            .optional(),
          footnote: L.optional(),
        })
        .optional(),
      faq: z
        .object({ eyebrow: L, title: L, lead: L, items: z.array(z.object({ q: L, a: L })) })
        .optional(),
      cta: z.object({ title: L, note: L }).optional(),
    });
  },
});

const releases = defineCollection({
  loader: glob({ pattern: '*/releases.yaml', base, generateId: appId }),
  schema: z.object({
    releases: z.array(
      z.object({
        version: z.string(),
        build: z.string().optional(),
        date: z.coerce.date(),
        channel: z.enum(['stable', 'beta', 'preview']).default('stable'),
        platform: z.enum(['mac', 'ios']).default('mac'),
        /** 系统要求；不写时使用 app.yaml 中对应平台的 requirement */
        requirement: L.optional(),
        /** 安装包地址。大于 25MB 的文件放 GitHub Releases；小文件可放 public/downloads/ 并写 /downloads/xxx */
        download: z.string().optional(),
        github: z.url().optional(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        badge: L.optional(),
        summary: L,
        notes: z.array(z.object({ title: L, items: z.array(L) })).default([]),
        /** Sparkle 自动更新信息（sign_update 的输出）。只有填了这项的版本才会出现在 appcast.xml 里 */
        sparkle: z
          .object({
            edSignature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/, 'edSignature 应为 sign_update 输出的 88 位 Base64'),
            length: z.number().int().positive(),
            minimumSystemVersion: z.string().regex(/^\d+(\.\d+)*$/).optional(),
          })
          .optional(),
      })
      .refine((r) => !r.sparkle || (r.build && r.download), {
        message: '填写了 sparkle 的版本必须同时有 build（对应 CFBundleVersion）和 download',
      }),
    ),
  }),
});

const docs = defineCollection({
  loader: glob({
    pattern: '*/docs/*.yaml',
    base,
    generateId: ({ entry }) => entry.replace('/docs/', '/').replace(/\.yaml$/, ''),
  }),
  schema: z.object({
    title: L,
    heading: L,
    meta: L.optional(),
    lead: L.optional(),
    sections: z.array(
      z.object({
        heading: L,
        body: z.array(L).default([]),
        steps: z.array(L).default([]),
        list: z.array(L).default([]),
        note: L.optional(),
        links: z.array(z.object({ label: L, href: z.string() })).default([]),
      }),
    ),
  }),
});

/**
 * 官方动态：src/content/news/<id>.yaml，文件名就是 id（会出现在网址 /news/<id>/ 和推送去重键里，发布后不要改名）。
 * 同时显示在网站“动态”页和 iPhone App 里；push: true 时由推送服务推送给订阅的设备。
 */
const news = defineCollection({
  loader: glob({ pattern: '*.yaml', base: './src/content/news' }),
  schema: z.object({
    /** 发布时间；只写日期即可，同一天有多条时可写完整时间（如 2026-10-02T09:00:00+08:00） */
    date: z.coerce.date(),
    title: L,
    /** 列表与推送正文里显示的一句话 */
    summary: L,
    /** 正文段落；\n 显示为换行 */
    body: z.array(L).default([]),
    links: z.array(z.object({ label: L, href: z.string() })).default([]),
    /** 关联的软件 id（可选），App 里按软件订阅推送时使用 */
    apps: z.array(z.string()).default([]),
    /** 置顶 */
    pinned: z.boolean().default(false),
    /** 是否推送；更正、补充说明之类的条目可以设为 false */
    push: z.boolean().default(true),
    /** 草稿：不生成页面、不进入动态、不推送 */
    draft: z.boolean().default(false),
  }),
});

export const collections = { apps, releases, docs, news };
