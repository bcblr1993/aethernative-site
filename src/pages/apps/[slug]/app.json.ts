/** 单个软件：https://aethernative.com/apps/<id>/app.json —— 介绍、全部版本与更新说明、文档链接。结构见 docs/api.md */
import type { APIRoute, GetStaticPaths } from 'astro';
import { buildAppDetail, type AppInput } from '../../../lib/feed';
import { getAppInputs, json } from '../../../lib/feed-data';

export const getStaticPaths = (async () =>
  (await getAppInputs()).map((app) => ({ params: { slug: app.id }, props: { app } }))) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ props, site }) => json(buildAppDetail({ site: site!, app: (props as { app: AppInput }).app }));
