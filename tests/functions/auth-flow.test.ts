// 端到端：login → callback → /api/me → logout / 注销。第三方接口用假的 fetch 代替，数据库跑真实迁移。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequestGet as callback } from '../../functions/api/auth/[provider]/callback';
import { onRequestGet as login } from '../../functions/api/auth/[provider]/login';
import { onRequestPost as logout } from '../../functions/api/auth/logout';
import { onRequestDelete as deleteMe, onRequestGet as me } from '../../functions/api/me';
import { createD1 } from './d1';

const ORIGIN = 'https://aethernative.com';
let env: any;

const call = (fn: any, req: Request, params: Record<string, string> = {}) => fn({ request: req, env, params });

/** 把响应里的 Set-Cookie 合进一个简易 cookie jar */
function jar(res: Response, prev: Record<string, string> = {}) {
  const out = { ...prev };
  for (const c of res.headers.getSetCookie()) {
    const [pair, ...attrs] = c.split('; ');
    const [k, v] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
    if (attrs.includes('Max-Age=0')) delete out[k];
    else out[k] = v;
  }
  return out;
}
const cookieHeader = (j: Record<string, string>) => Object.entries(j).map(([k, v]) => `${k}=${v}`).join('; ');

/** 模拟 Google / GitHub 的令牌与用户接口 */
function mockProviders(opts: { tokenFails?: boolean; githubEmailPrivate?: boolean } = {}) {
  const calls: { url: string; body?: string }[] = [];
  const fetcher = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, body: init.body?.toString() });
    const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url === 'https://oauth2.googleapis.com/token' || url === 'https://github.com/login/oauth/access_token') {
      return opts.tokenFails ? ok({ error: 'bad_verification_code' }) : ok({ access_token: 'tok_123' });
    }
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
      return ok({ sub: 'g-42', name: 'Alice', email: 'alice@example.com', email_verified: true, picture: 'https://lh3.googleusercontent.com/a' });
    }
    if (url === 'https://api.github.com/user') return ok({ id: 7, login: 'octo', name: null, avatar_url: 'https://avatars.githubusercontent.com/u/7' });
    if (url === 'https://api.github.com/user/emails') {
      return opts.githubEmailPrivate ? new Response('', { status: 404 }) : ok([{ email: 'o@example.com', primary: true, verified: true }]);
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  return calls;
}

async function signIn(provider: 'google' | 'github', next = '/feedback/') {
  const res1: Response = await call(login, new Request(`${ORIGIN}/api/auth/${provider}/login?next=${encodeURIComponent(next)}`), { provider });
  expect(res1.status).toBe(302);
  const auth = new URL(res1.headers.get('Location')!);
  const cookies = jar(res1);
  const state = auth.searchParams.get('state')!;
  const res2: Response = await call(
    callback,
    new Request(`${ORIGIN}/api/auth/${provider}/callback?code=c0de&state=${state}`, { headers: { Cookie: cookieHeader(cookies), 'User-Agent': 'vitest' } }),
    { provider },
  );
  return { auth, res2, cookies: jar(res2, cookies) };
}

beforeEach(() => {
  env = {
    DB: createD1(),
    GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret',
    GITHUB_CLIENT_ID: 'hid', GITHUB_CLIENT_SECRET: 'hsecret',
  };
});
afterEach(() => vi.unstubAllGlobals());

describe('登录跳转', () => {
  it('带上 PKCE、state 和正确的回调地址', async () => {
    const res: Response = await call(login, new Request(`${ORIGIN}/api/auth/google/login?next=/en/support/`), { provider: 'google' });
    const u = new URL(res.headers.get('Location')!);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/google/callback`);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toBe('openid email profile');
    const setCookie = res.headers.getSetCookie()[0];
    expect(setCookie).toMatch(/^__Host-oauth=.+; Path=\/; Secure; SameSite=Lax; HttpOnly; Max-Age=600$/);
  });
  it('未知平台 404，未配置密钥 503', async () => {
    expect((await call(login, new Request(`${ORIGIN}/api/auth/x/login`), { provider: 'x' })).status).toBe(404);
    env.GITHUB_CLIENT_SECRET = undefined;
    expect((await call(login, new Request(`${ORIGIN}/api/auth/github/login`), { provider: 'github' })).status).toBe(503);
  });
  it('外站 next 被替换为首页', async () => {
    const res: Response = await call(login, new Request(`${ORIGIN}/api/auth/google/login?next=//evil.com`), { provider: 'google' });
    expect(decodeURIComponent(jar(res)['__Host-oauth'])).toContain('"next":"/"');
  });
});

describe('完整登录流程', () => {
  it('Google：建用户、建会话、跳回原页面，/api/me 返回资料', async () => {
    const calls = mockProviders();
    const { res2, cookies } = await signIn('google', '/feedback/?app=aetherroute');
    expect(res2.status).toBe(302);
    expect(res2.headers.get('Location')).toBe('/feedback/?app=aetherroute');
    expect(cookies['__Host-sid']).toMatch(/^[\w-]{43}$/);
    expect(cookies['an_signed_in']).toBe('1');
    expect(cookies['__Host-oauth']).toBeUndefined();
    // 换令牌时带上了 verifier 和密钥
    const tokenBody = new URLSearchParams(calls[0].body);
    expect(tokenBody.get('code_verifier')).toMatch(/^[\w-]{64}$/);
    expect(tokenBody.get('client_secret')).toBe('gsecret');

    const res3: Response = await call(me, new Request(`${ORIGIN}/api/me`, { headers: { Cookie: cookieHeader(cookies) } }));
    expect(res3.status).toBe(200);
    expect(res3.headers.get('Cache-Control')).toBe('no-store');
    const { user } = await res3.json() as any;
    expect(user).toMatchObject({ name: 'Alice', email: 'alice@example.com', providers: ['google'] });
    expect(user).not.toHaveProperty('is_admin');

    // 数据库只存令牌哈希
    const row = env.DB.raw.prepare('SELECT token_hash, user_agent FROM sessions').get();
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toBe(cookies['__Host-sid']);
    expect(row.user_agent).toBe('vitest');
  });

  it('GitHub：昵称为空时用 login，邮箱接口失败仍能登录', async () => {
    mockProviders({ githubEmailPrivate: true });
    const { res2 } = await signIn('github');
    expect(res2.headers.get('Location')).toBe('/feedback/');
    const u = env.DB.raw.prepare('SELECT name, email, avatar_url FROM users').get();
    expect(u).toEqual({ name: 'octo', email: null, avatar_url: 'https://avatars.githubusercontent.com/u/7' });
  });

  it('同一身份再次登录复用用户；Google 与 GitHub 同邮箱也不自动合并', async () => {
    mockProviders();
    await signIn('google');
    await signIn('google');
    await signIn('github');
    expect(env.DB.raw.prepare('SELECT COUNT(*) n FROM users').get().n).toBe(2);
    expect(env.DB.raw.prepare('SELECT COUNT(*) n FROM sessions').get().n).toBe(3);
  });

  it('state 不匹配、缺少临时 Cookie、平台不一致都拒绝', async () => {
    mockProviders();
    const r1: Response = await call(login, new Request(`${ORIGIN}/api/auth/google/login?next=/x/`), { provider: 'google' });
    const c = cookieHeader(jar(r1));
    const bad = async (url: string, cookie: string, provider = 'google') =>
      (await call(callback, new Request(url, { headers: { Cookie: cookie } }), { provider })) as Response;

    expect((await bad(`${ORIGIN}/api/auth/google/callback?code=c&state=forged`, c)).headers.get('Location')).toBe('/x/#login-failed');
    expect((await bad(`${ORIGIN}/api/auth/google/callback?code=c&state=forged`, '')).headers.get('Location')).toBe('/#login-failed');
    const state = new URL(r1.headers.get('Location')!).searchParams.get('state');
    expect((await bad(`${ORIGIN}/api/auth/github/callback?code=c&state=${state}`, c, 'github')).headers.get('Location')).toBe('/x/#login-failed');
    expect(env.DB.raw.prepare('SELECT COUNT(*) n FROM users').get().n).toBe(0);
  });

  it('用户取消授权', async () => {
    const r1: Response = await call(login, new Request(`${ORIGIN}/api/auth/github/login?next=/x/`), { provider: 'github' });
    const res: Response = await call(callback, new Request(`${ORIGIN}/api/auth/github/callback?error=access_denied`, { headers: { Cookie: cookieHeader(jar(r1)) } }), { provider: 'github' });
    expect(res.headers.get('Location')).toBe('/x/#login-cancelled');
    expect(jar(res, jar(r1))['__Host-oauth']).toBeUndefined();
  });

  it('换令牌失败不建会话', async () => {
    mockProviders({ tokenFails: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { res2, cookies } = await signIn('github');
    expect(res2.headers.get('Location')).toBe('/feedback/#login-failed');
    expect(cookies['__Host-sid']).toBeUndefined();
  });
});

describe('会话', () => {
  it('未登录 401 并清除提示 Cookie；伪造令牌无效', async () => {
    const res: Response = await call(me, new Request(`${ORIGIN}/api/me`, { headers: { Cookie: '__Host-sid=forged; an_signed_in=1' } }));
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('an_signed_in=;') && c.includes('Max-Age=0'))).toBe(true);
  });

  it('过期会话无效', async () => {
    mockProviders();
    const { cookies } = await signIn('google');
    env.DB.raw.exec(`UPDATE sessions SET expires_at = ${Date.now() - 1}`);
    expect((await call(me, new Request(`${ORIGIN}/api/me`, { headers: { Cookie: cookieHeader(cookies) } }))).status).toBe(401);
  });

  it('退出登录：跨站请求被拒绝，同源请求删除会话', async () => {
    mockProviders();
    const { cookies } = await signIn('google');
    const h = (origin: string) => ({ Cookie: cookieHeader(cookies), Origin: origin });
    expect((await call(logout, new Request(`${ORIGIN}/api/auth/logout`, { method: 'POST', headers: h('https://evil.com') }))).status).toBe(403);
    expect(env.DB.raw.prepare('SELECT COUNT(*) n FROM sessions').get().n).toBe(1);

    const res: Response = await call(logout, new Request(`${ORIGIN}/api/auth/logout`, { method: 'POST', headers: h(ORIGIN) }));
    expect(res.status).toBe(204);
    expect(env.DB.raw.prepare('SELECT COUNT(*) n FROM sessions').get().n).toBe(0);
    expect(jar(res, cookies)).toEqual({});
  });

  it('注销账号删除用户、身份和全部会话，不影响其他用户', async () => {
    mockProviders();
    const a = await signIn('google');
    await signIn('google'); // 同一用户的第二个会话
    await signIn('github'); // 另一个用户
    const res: Response = await call(deleteMe, new Request(`${ORIGIN}/api/me`, { method: 'DELETE', headers: { Cookie: cookieHeader(a.cookies), Origin: ORIGIN } }));
    expect(res.status).toBe(204);
    const count = (t: string) => env.DB.raw.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    expect([count('users'), count('identities'), count('sessions')]).toEqual([1, 1, 1]);
  });

  it('注销账号同样要求同源', async () => {
    mockProviders();
    const { cookies } = await signIn('google');
    const res: Response = await call(deleteMe, new Request(`${ORIGIN}/api/me`, { method: 'DELETE', headers: { Cookie: cookieHeader(cookies) } }));
    expect(res.status).toBe(403);
  });
});
