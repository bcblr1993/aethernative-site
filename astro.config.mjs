// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://aethernative.com',
  trailingSlash: 'always',
  integrations: [
    sitemap({
      // 管理后台不进入站点地图
      filter: (page) => !page.includes('/admin/'),
      i18n: { defaultLocale: 'zh', locales: { zh: 'zh-CN', en: 'en' } },
    }),
  ],
});
