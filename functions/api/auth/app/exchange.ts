// POST /api/auth/app/exchange —— App 内用 Google / GitHub 登录的最后一步：{ code, verifier } → App 会话。
import { PKCE_VERIFIER, redeemAuthCode, signedInResponse } from '../../../_lib/app-auth';
import type { Env } from '../../../_lib/env';
import { error } from '../../../_lib/http';
import { readJson } from '../../../_lib/push-auth';
import { getUser } from '../../../_lib/session';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson(request, 4 * 1024);
  if (!body.ok) return body.response;
  const o = (body.value && typeof body.value === 'object' ? body.value : {}) as Record<string, unknown>;
  if (typeof o.code !== 'string' || o.code.length > 128 || typeof o.verifier !== 'string' || !PKCE_VERIFIER.test(o.verifier)) {
    return error(400, 'invalid');
  }
  const userId = await redeemAuthCode(env.DB, o.code, o.verifier);
  const user = userId && (await getUser(env.DB, userId));
  if (!user) return error(401, 'invalid_code');
  return signedInResponse(env.DB, user, request.headers.get('User-Agent'));
};
