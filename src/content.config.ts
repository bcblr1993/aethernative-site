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
    const shot = z.object({ label: L, zh: image(), en: image().optional() });
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
      gallery: z.array(shot).default([]),
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
        requirement: L.default({ zh: 'Apple 芯片 · macOS 15.0+', en: 'Apple silicon · macOS 15.0+' }),
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

export const collections = { apps, releases, docs };
