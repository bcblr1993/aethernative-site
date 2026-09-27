// GET /api/auth/:provider/login?next=/path/ —— 跳转到 Google / GitHub 授权页。
import { pkceChallenge, randomToken } from '../../../_lib/crypto';
import type { Env } from '../../../_lib/env';
import { error, redirect, safeNext, serializeCookie } from '../../../_lib/http';
import { authorizeUrl, callbackUrl, isConfigured, isProvider } from '../../../_lib/oauth';
import { OAUTH_COOKIE } from '../../../_lib/session';

export const OAUTH_TTL_S = 600;

export interface OAuthState {
  provider: string;
  state: string;
  verifier: string;
  next: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env, params }) => {
  const provider = params.provider;
  if (!isProvider(provider)) return error(404, 'unknown_provider');
  if (!isConfigured(provider, env)) return error(503, 'provider_not_configured');

  const url = new URL(request.url);
  const pending: OAuthState = {
    provider,
    state: randomToken(),
    verifier: randomToken(48),
    next: safeNext(url.searchParams.get('next')),
  };
  const location = authorizeUrl(provider, env, {
    redirectUri: callbackUrl(url.origin, provider),
    state: pending.state,
    codeChallenge: await pkceChallenge(pending.verifier),
  });
  const cookie = serializeCookie(OAUTH_COOKIE, encodeURIComponent(JSON.stringify(pending)), { maxAge: OAUTH_TTL_S });
  return redirect(location, [cookie]);
};
