/** 官方动态：https://aethernative.com/feed.json —— iPhone App 首页与推送服务读取。结构见 docs/api.md */
import type { APIRoute } from 'astro';
import { buildFeed } from '../lib/feed';
import { getAppInputs, getNewsInputs, json } from '../lib/feed-data';

export const GET: APIRoute = async ({ site }) =>
  json(buildFeed({ site: site!, apps: await getAppInputs(), news: await getNewsInputs() }));
