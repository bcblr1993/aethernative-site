// Google / GitHub OAuth 2.0（授权码 + PKCE）。只申请读取基本资料和邮箱的权限。
import type { Env } from './env';

export type ProviderId = 'google' | 'github';

export interface Profile {
  provider: ProviderId;
  /** 平台内不变的用户 ID（Google sub / GitHub 数字 id），不用邮箱或用户名，因为它们可以修改 */
  id: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
}

interface Provider {
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  extraParams?: Record<string, string>;
  clientId(env: Env): string | undefined;
  clientSecret(env: Env): string | undefined;
  fetchProfile(accessToken: string, fetcher: typeof fetch): Promise<Profile>;
}

const UA = 'aethernative-site';

async function getJson(fetcher: typeof fetch, url: string, token: string, extra: Record<string, string> = {}) {
  const res = await fetcher(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': UA, ...extra } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json() as Promise<any>;
}

const clip = (s: unknown, n: number) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, n) : null);
const httpsUrl = (s: unknown) => (typeof s === 'string' && s.startsWith('https://') && s.length <= 1024 ? s : null);

export const providers: Record<ProviderId, Provider> = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    extraParams: { prompt: 'select_account' },
    clientId: (env) => env.GOOGLE_CLIENT_ID,
    clientSecret: (env) => env.GOOGLE_CLIENT_SECRET,
    async fetchProfile(token, fetcher) {
      const u = await getJson(fetcher, 'https://openidconnect.googleapis.com/v1/userinfo', token);
      if (!u.sub) throw new Error('Google 用户信息缺少 sub');
      const email = u.email_verified ? clip(u.email, 320) : null;
      return { provider: 'google', id: String(u.sub), name: clip(u.name, 100) ?? email ?? 'Google 用户', email, avatarUrl: httpsUrl(u.picture) };
    },
  },
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
    extraParams: { allow_signup: 'true' },
    clientId: (env) => env.GITHUB_CLIENT_ID,
    clientSecret: (env) => env.GITHUB_CLIENT_SECRET,
    async fetchProfile(token, fetcher) {
      const gh = { 'X-GitHub-Api-Version': '2022-11-28' };
      const u = await getJson(fetcher, 'https://api.github.com/user', token, gh);
      if (typeof u.id !== 'number' && typeof u.id !== 'string') throw new Error('GitHub 用户信息缺少 id');
      // 公开资料里的邮箱可能为空（用户设为私密），此时从 /user/emails 取已验证的主邮箱
      let email: string | null = null;
      try {
        const list = (await getJson(fetcher, 'https://api.github.com/user/emails', token, gh)) as { email: string; primary: boolean; verified: boolean }[];
        const pick = list.find((e) => e.primary && e.verified) ?? list.find((e) => e.verified);
        email = clip(pick?.email, 320);
      } catch {
        // 没有授予邮箱权限也能登录，只是不记录邮箱
      }
      return { provider: 'github', id: String(u.id), name: clip(u.name, 100) ?? clip(u.login, 100) ?? 'GitHub 用户', email, avatarUrl: httpsUrl(u.avatar_url) };
    },
  },
};

export const isProvider = (p: unknown): p is ProviderId => p === 'google' || p === 'github';

export const isConfigured = (id: ProviderId, env: Env) => Boolean(providers[id].clientId(env) && providers[id].clientSecret(env));

export const callbackUrl = (origin: string, id: ProviderId) => `${origin}/api/auth/${id}/callback`;

export function authorizeUrl(id: ProviderId, env: Env, opts: { redirectUri: string; state: string; codeChallenge: string }) {
  const p = providers[id];
  const url = new URL(p.authorizeUrl);
  const params: Record<string, string> = {
    client_id: p.clientId(env)!,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: p.scope,
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
    ...p.extraParams,
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/** 用授权码换 access token，再读取用户资料。 */
export async function exchangeAndFetchProfile(
  id: ProviderId,
  env: Env,
  opts: { code: string; redirectUri: string; codeVerifier: string },
  fetcher: typeof fetch = fetch,
): Promise<Profile> {
  const p = providers[id];
  const res = await fetcher(p.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': UA },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: opts.redirectUri,
      code_verifier: opts.codeVerifier,
      client_id: p.clientId(env)!,
      client_secret: p.clientSecret(env)!,
    }),
  });
  // GitHub 出错时也返回 200，只能看 body 里有没有 access_token
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token) throw new Error(`${id} 换取令牌失败：HTTP ${res.status} ${body.error ?? ''}`.trim());
  return p.fetchProfile(body.access_token, fetcher);
}
