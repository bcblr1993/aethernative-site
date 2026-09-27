// GET /api/feedback/mine —— 当前用户提交过的反馈（最新在前），含处理状态与官方回复。
import type { Env } from '../../_lib/env';
import { listFeedback, publicFeedback } from '../../_lib/feedback';
import { error, json } from '../../_lib/http';
import { getSessionUser } from '../../_lib/session';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const user = await getSessionUser(env.DB, request);
  if (!user) return error(401, 'unauthenticated');
  return json({ feedback: (await listFeedback(env.DB, user.id)).map(publicFeedback) });
};
