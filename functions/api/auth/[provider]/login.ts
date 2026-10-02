// GET /api/auth/:provider/login?next=/path/ —— 跳转到 Google / GitHub 授权页。
import { pkceChallenge, randomToken } from '../../../_lib/crypto';
import type { Env } from '../../../_lib/env';
import { PKCE_CHALLENGE } from '../../../_lib/app-auth';
import { error, redirect, safeNext, serializeCookie } from '../../../_lib/http';
import { authorizeUrl, callbackUrl, isConfigured, isProvider } from '../../../_lib/oauth';
import { OAUTH_COOKIE } from '../../../_lib/session';

export const OAUTH_TTL_S = 600;

export interface OAuthState {
  provider: string;
  state: string;
  verifier: string;
  next: string;
  /** App 内登录（?app=1&challenge=…）：App 的 PKCE challenge，回调后把一次性 code 交给 App 而不是建立网页会话 */
  app?: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env, params }) => {
  const provider = params.provider;
  if (!isProvider(provider)) return error(404, 'unknown_provider');
  if (!isConfigured(provider, env)) return error(503, 'provider_not_configured');

  const url = new URL(request.url);
  // OAuth 回调地址只登记了主域名：从 www 发起时先跳回主域名，会话 Cookie 也落在主域名上
  if (url.hostname.startsWith('www.')) {
    url.hostname = url.hostname.slice(4);
    return redirect(url.toString());
  }
  const pending: OAuthState = {
    provider,
    state: randomToken(),
    verifier: randomToken(48),
    next: safeNext(url.searchParams.get('next')),
  };
  if (url.searchParams.get('app') === '1') {
    const challenge = url.searchParams.get('challenge') ?? '';
    if (!PKCE_CHALLENGE.test(challenge)) return error(400, 'invalid_challenge');
    pending.app = challenge;
  }
  const location = authorizeUrl(provider, env, {
    redirectUri: callbackUrl(url.origin, provider),
    state: pending.state,
    codeChallenge: await pkceChallenge(pending.verifier),
  });
  const cookie = serializeCookie(OAUTH_COOKIE, encodeURIComponent(JSON.stringify(pending)), { maxAge: OAUTH_TTL_S });
  return redirect(location, [cookie]);
};
