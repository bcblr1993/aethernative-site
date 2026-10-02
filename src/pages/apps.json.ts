/** 软件列表：https://aethernative.com/apps.json。结构见 docs/api.md */
import type { APIRoute } from 'astro';
import { buildAppList } from '../lib/feed';
import { getAppInputs, json } from '../lib/feed-data';

export const GET: APIRoute = async ({ site }) => json(buildAppList({ site: site!, apps: await getAppInputs() }));
