// GET /api/auth/:provider/callback —— 校验 state，换取用户资料，建立会话后跳回原页面。
import { appRedirect, issueAuthCode, PKCE_CHALLENGE } from '../../../_lib/app-auth';
import { safeEqual } from '../../../_lib/crypto';
import type { Env } from '../../../_lib/env';
import { clearCookie, error, parseCookies, redirect, safeNext, withAuthFlag } from '../../../_lib/http';
import { callbackUrl, exchangeAndFetchProfile, isConfigured, isProvider } from '../../../_lib/oauth';
import { createSession, OAUTH_COOKIE, upsertUser } from '../../../_lib/session';
import type { OAuthState } from './login';

function readPending(request: Request): OAuthState | null {
  const raw = parseCookies(request.headers.get('Cookie'))[OAUTH_COOKIE];
  if (!raw) return null;
  try {
    const v = JSON.parse(decodeURIComponent(raw));
    return typeof v?.state === 'string' && typeof v?.verifier === 'string' && typeof v?.provider === 'string' ? v : null;
  } catch {
    return null;
  }
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env, params }) => {
  const provider = params.provider;
  if (!isProvider(provider)) return error(404, 'unknown_provider');
  if (!isConfigured(provider, env)) return error(503, 'provider_not_configured');

  const url = new URL(request.url);
  const pending = readPending(request);
  const next = safeNext(pending?.next);
  // 无论成功与否，临时状态都只能用一次
  const clearPending = clearCookie(OAUTH_COOKIE);

  // App 内登录：结果通过 aethernative://auth/callback 交给 App，不建立网页会话
  const app = pending?.app && PKCE_CHALLENGE.test(pending.app) ? pending.app : null;
  const fail = (flag: 'login-failed' | 'login-cancelled') =>
    redirect(app ? appRedirect({ error: flag === 'login-cancelled' ? 'cancelled' : 'failed' }) : withAuthFlag(next, flag), [clearPending]);

  // 用户在授权页点了“取消”
  if (url.searchParams.get('error')) return fail('login-cancelled');

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!pending || !code || !state || pending.provider !== provider || !safeEqual(state, pending.state)) {
    return fail('login-failed');
  }

  try {
    const profile = await exchangeAndFetchProfile(provider, env, {
      code,
      redirectUri: callbackUrl(url.origin, provider),
      codeVerifier: pending.verifier,
    });
    const user = await upsertUser(env.DB, profile);
    if (app) return redirect(appRedirect({ code: await issueAuthCode(env.DB, user.id, app) }), [clearPending]);
    const cookies = await createSession(env.DB, user.id, request.headers.get('User-Agent'));
    return redirect(next, [clearPending, ...cookies]);
  } catch (e) {
    console.error('OAuth 回调失败', provider, e instanceof Error ? e.message : e);
    return fail('login-failed');
  }
};
