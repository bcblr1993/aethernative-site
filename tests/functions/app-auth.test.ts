// iPhone App 登录：Apple 原生登录、App 内 Google / GitHub（一次性 code + PKCE）、Bearer 会话、设备关联、注销撤销授权。
// Apple 与第三方接口用假的 fetch 代替（密钥在测试里现场生成），数据库跑真实迁移。
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appleConfig, clientSecret, decryptToken, encryptToken, resetAppleKeyCache, verifyIdentityToken,
} from '../../functions/_lib/apple';
import { base64url, pkceChallenge, sha256Hex } from '../../functions/_lib/crypto';
import { onRequestPost as apple } from '../../functions/api/auth/apple';
import { onRequestPost as exchange } from '../../functions/api/auth/app/exchange';
import { onRequestGet as callback } from '../../functions/api/auth/[provider]/callback';
import { onRequestGet as login } from '../../functions/api/auth/[provider]/login';
import { onRequestPost as logout } from '../../functions/api/auth/logout';
import { onRequestPost as submitFeedback } from '../../functions/api/feedback/index';
import { onRequestPost as linkDevice } from '../../functions/api/me/devices';
import { onRequestDelete as deleteMe, onRequestGet as me } from '../../functions/api/me/index';
import { onRequestPut as putDevice } from '../../functions/api/devices/[id]';
import { createSession } from '../../functions/_lib/session';
import { createD1 } from './d1';

const ORIGIN = 'https://aethernative.com';
const BUNDLE = 'com.aethernative.app';
const enc = new TextEncoder();
let env: any;

// ---------- 测试用密钥 ----------
let appleKeys: CryptoKeyPair;
let siwaKeys: CryptoKeyPair;
let siwaPem: string;
const KID = 'TESTKID01';

beforeAll(async () => {
  appleKeys = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  )) as CryptoKeyPair;
  siwaKeys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', siwaKeys.privateKey));
  siwaPem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der)).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----`;
});

/** 用测试密钥签发一个“Apple identity token” */
async function identityToken(claims: Record<string, unknown> = {}, opts: { kid?: string; nonce?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = base64url(enc.encode(JSON.stringify({ alg: 'RS256', kid: opts.kid ?? KID })));
  const body = base64url(enc.encode(JSON.stringify({
    iss: 'https://appleid.apple.com', aud: BUNDLE, iat: now, exp: now + 600, sub: 'apple-001',
    email: 'abc@privaterelay.appleid.com', email_verified: 'true', nonce: await sha256Hex(opts.nonce ?? 'raw-nonce'),
    ...claims,
  })));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', appleKeys.privateKey, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${base64url(sig)}`;
}

/** 假的 Apple / Google 接口；记录请求 */
function mockFetch(opts: { exchangeFails?: boolean; revokeFails?: boolean } = {}) {
  const calls: { url: string; body: string }[] = [];
  const ok = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { 'Content-Type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, body: init.body?.toString() ?? '' });
    if (url === 'https://appleid.apple.com/auth/keys') {
      const jwk = await crypto.subtle.exportKey('jwk', appleKeys.publicKey);
      return ok({ keys: [{ kty: 'RSA', kid: KID, alg: 'RS256', use: 'sig', n: jwk.n, e: jwk.e }] });
    }
    if (url === 'https://appleid.apple.com/auth/token') return opts.exchangeFails ? new Response('{"error":"invalid_grant"}', { status: 400 }) : ok({ refresh_token: 'apple-refresh-xyz', id_token: 'x' });
    if (url === 'https://appleid.apple.com/auth/revoke') return new Response('', { status: opts.revokeFails ? 500 : 200 });
    if (url === 'https://oauth2.googleapis.com/token') return ok({ access_token: 'tok' });
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return ok({ sub: 'g-1', name: 'Alice', email: 'a@example.com', email_verified: true });
    return new Response('not found', { status: 404 });
  }));
  return calls;
}

const call = (fn: any, req: Request, params: Record<string, string> = {}) => fn({ request: req, env, params }) as Promise<Response>;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'AetherNative/1', ...headers }, body: JSON.stringify(body) });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function appleSignIn(body: Record<string, unknown> = {}) {
  return call(apple, post('/api/auth/apple', { identityToken: await identityToken(), authorizationCode: 'code-1', nonce: 'raw-nonce', ...body }));
}

beforeEach(() => {
  resetAppleKeyCache();
  env = {
    DB: createD1(),
    GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret',
    APPLE_TEAM_ID: 'TEAM123456', APPLE_SIWA_KEY_ID: 'SIWAKEY123', APPLE_SIWA_KEY: siwaPem,
    APPLE_TOKEN_KEY: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  };
});
afterEach(() => vi.unstubAllGlobals());

describe('Apple identity token 校验', () => {
  const verify = async (token: string, rawNonce = 'raw-nonce') => verifyIdentityToken(token, { bundleId: BUNDLE, rawNonce });

  it('合法 token：返回 sub 与已验证邮箱', async () => {
    mockFetch();
    expect(await verify(await identityToken())).toEqual({ sub: 'apple-001', email: 'abc@privaterelay.appleid.com' });
  });

  it('邮箱未验证时不记录邮箱', async () => {
    mockFetch();
    expect((await verify(await identityToken({ email_verified: false }))).email).toBeNull();
  });

  it.each([
    ['受众不是本 App', { aud: 'com.other.app' }, /受众/],
    ['签发方错误', { iss: 'https://evil.example.com' }, /签发方/],
    ['已过期', { exp: Math.floor(Date.now() / 1000) - 10 }, /过期/],
    ['签发时间在未来', { iat: Math.floor(Date.now() / 1000) + 3600 }, /未来/],
  ])('拒绝：%s', async (_, claims, msg) => {
    mockFetch();
    await expect(verify(await identityToken(claims))).rejects.toThrow(msg);
  });

  it('拒绝：nonce 不匹配（防重放）', async () => {
    mockFetch();
    await expect(verify(await identityToken(), 'other-nonce')).rejects.toThrow(/nonce/);
  });

  it('拒绝：签名被篡改', async () => {
    mockFetch();
    const t = await identityToken();
    const [h, , s] = t.split('.');
    const forged = base64url(enc.encode(JSON.stringify({ iss: 'https://appleid.apple.com', aud: BUNDLE, exp: 9e9, sub: 'attacker', nonce: await sha256Hex('raw-nonce') })));
    await expect(verify(`${h}.${forged}.${s}`)).rejects.toThrow(/签名/);
  });

  it('拒绝：未知 kid（刷新公钥后仍找不到）与非 RS256 算法', async () => {
    const calls = mockFetch();
    await expect(verify(await identityToken({}, { kid: 'UNKNOWN' }))).rejects.toThrow(/kid/);
    expect(calls.filter((c) => c.url.endsWith('/auth/keys')).length).toBe(1);
    const none = `${base64url(enc.encode('{"alg":"none","kid":"x"}'))}.e30.`;
    await expect(verify(none)).rejects.toThrow(/算法/);
  });

  it('公钥缓存：连续校验只下载一次', async () => {
    const calls = mockFetch();
    await verify(await identityToken());
    await verify(await identityToken());
    expect(calls.filter((c) => c.url.endsWith('/auth/keys')).length).toBe(1);
  });
});

describe('client_secret 与 refresh token 加密', () => {
  it('client_secret 是用 Sign in with Apple 私钥签名的 ES256 JWT', async () => {
    const cfg = appleConfig(env)!;
    const jwt = await clientSecret(cfg, 1_700_000_000_000);
    const [h, b, s] = jwt.split('.');
    const dec = (x: string) => JSON.parse(atob(x!.replace(/-/g, '+').replace(/_/g, '/')));
    expect(dec(h!)).toEqual({ alg: 'ES256', kid: 'SIWAKEY123' });
    expect(dec(b!)).toEqual({ iss: 'TEAM123456', iat: 1_700_000_000, exp: 1_700_000_300, aud: 'https://appleid.apple.com', sub: BUNDLE });
    const sig = Uint8Array.from(atob(s!.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (s!.length % 4)) % 4)), (c) => c.charCodeAt(0));
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, siwaKeys.publicKey, sig, enc.encode(`${h}.${b}`))).toBe(true);
  });

  it('加密后可解密；密文不含原文；篡改后解密失败', async () => {
    const cfg = appleConfig(env)!;
    const stored = await encryptToken(cfg, 'apple-refresh-xyz');
    expect(stored).not.toContain('apple-refresh');
    expect(await decryptToken(cfg, stored)).toBe('apple-refresh-xyz');
    const tampered = stored.slice(0, -2) + (stored.endsWith('A') ? 'BB' : 'AA');
    await expect(decryptToken(cfg, tampered)).rejects.toThrow();
  });

  it('缺少任一配置时不启用 Apple 登录', () => {
    for (const k of ['APPLE_TEAM_ID', 'APPLE_SIWA_KEY_ID', 'APPLE_SIWA_KEY', 'APPLE_TOKEN_KEY']) {
      expect(appleConfig({ ...env, [k]: undefined })).toBeNull();
    }
  });
});

describe('POST /api/auth/apple', () => {
  it('登录成功：返回 App 令牌，可用于 /api/me；refresh token 加密保存', async () => {
    const calls = mockFetch();
    const res = await appleSignIn({ name: { givenName: '小明', familyName: '王' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.user).toMatchObject({ name: '王小明', email: 'abc@privaterelay.appleid.com', providers: ['apple'] });

    const meRes = await call(me, new Request(`${ORIGIN}/api/me`, { headers: bearer(body.token) }));
    expect(((await meRes.json()) as any).user.name).toBe('王小明');

    const exch = calls.find((c) => c.url.endsWith('/auth/token'))!;
    expect(new URLSearchParams(exch.body).get('code')).toBe('code-1');
    expect(new URLSearchParams(exch.body).get('client_id')).toBe(BUNDLE);
    const row = env.DB.raw.prepare("SELECT apple_refresh_token AS t FROM identities WHERE provider = 'apple'").get();
    expect(row.t).toMatch(/^v1\./);
    expect(row.t).not.toContain('apple-refresh-xyz');
    expect(env.DB.raw.prepare('SELECT client FROM sessions').get().client).toBe('ios');
  });

  it('再次登录不带姓名时保留原昵称', async () => {
    mockFetch();
    await appleSignIn({ name: { givenName: 'Tim', familyName: 'Cook' } });
    const res = await appleSignIn();
    expect(((await res.json()) as any).user.name).toBe('Tim Cook');
    expect(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM users').get().n).toBe(1);
  });

  it('token 无效 401；换取 refresh token 失败 502 且不建用户；未配置 503；缺字段 400', async () => {
    mockFetch();
    expect((await appleSignIn({ nonce: 'wrong' })).status).toBe(401);
    mockFetch({ exchangeFails: true });
    expect((await appleSignIn()).status).toBe(502);
    expect(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM users').get().n).toBe(0);
    env.APPLE_SIWA_KEY = undefined;
    expect((await appleSignIn()).status).toBe(503);
    env.APPLE_SIWA_KEY = siwaPem;
    expect((await call(apple, post('/api/auth/apple', { identityToken: 'x' }))).status).toBe(400);
  });
});

describe('App 内 Google / GitHub 登录（一次性 code + PKCE）', () => {
  const verifier = 'v'.repeat(64);

  async function webFlow(challenge?: string, cancel = false) {
    mockFetch();
    const ch = challenge ?? (await pkceChallenge(verifier));
    const r1 = await call(login, new Request(`${ORIGIN}/api/auth/google/login?app=1&challenge=${ch}`), { provider: 'google' });
    if (r1.status !== 302) return { r1 };
    const cookie = r1.headers.getSetCookie()[0]!.split(';')[0]!;
    const state = new URL(r1.headers.get('Location')!).searchParams.get('state');
    const q = cancel ? 'error=access_denied' : `code=c0de&state=${state}`;
    const r2 = await call(callback, new Request(`${ORIGIN}/api/auth/google/callback?${q}`, { headers: { Cookie: cookie } }), { provider: 'google' });
    return { r1, r2 };
  }

  it('回调跳回 App 并带上一次性 code，不建立网页会话；code + verifier 换得 App 令牌', async () => {
    const { r2 } = await webFlow();
    const loc = new URL(r2!.headers.get('Location')!);
    expect(`${loc.protocol}//${loc.host}${loc.pathname}`).toBe('aethernative://auth/callback');
    expect(r2!.headers.getSetCookie().some((c) => c.startsWith('__Host-sid='))).toBe(false);

    const res = await call(exchange, post('/api/auth/app/exchange', { code: loc.searchParams.get('code'), verifier }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).user).toMatchObject({ name: 'Alice', providers: ['google'] });
  });

  it('verifier 错误 401，且 code 已作废（不能再用正确的 verifier 重试）', async () => {
    const { r2 } = await webFlow();
    const code = new URL(r2!.headers.get('Location')!).searchParams.get('code');
    expect((await call(exchange, post('/api/auth/app/exchange', { code, verifier: 'w'.repeat(64) }))).status).toBe(401);
    expect((await call(exchange, post('/api/auth/app/exchange', { code, verifier }))).status).toBe(401);
  });

  it('code 只能用一次；过期后无效', async () => {
    const { r2 } = await webFlow();
    const code = new URL(r2!.headers.get('Location')!).searchParams.get('code');
    expect((await call(exchange, post('/api/auth/app/exchange', { code, verifier }))).status).toBe(200);
    expect((await call(exchange, post('/api/auth/app/exchange', { code, verifier }))).status).toBe(401);

    const { r2: again } = await webFlow();
    const code2 = new URL(again!.headers.get('Location')!).searchParams.get('code');
    env.DB.raw.prepare('UPDATE auth_codes SET expires_at = 0').run();
    expect((await call(exchange, post('/api/auth/app/exchange', { code: code2, verifier }))).status).toBe(401);
  });

  it('用户取消时跳回 App 并带 error=cancelled；challenge 格式错误 400', async () => {
    const { r2 } = await webFlow(undefined, true);
    expect(r2!.headers.get('Location')).toBe('aethernative://auth/callback?error=cancelled');
    const { r1 } = await webFlow('short');
    expect(r1.status).toBe(400);
  });
});

describe('Bearer 会话', () => {
  async function appToken() {
    mockFetch();
    return ((await (await appleSignIn()).json()) as any).token as string;
  }

  it('网页 Cookie 令牌不能当 Bearer 用，App 令牌也不能当 Cookie 用', async () => {
    const token = await appToken();
    const userId = env.DB.raw.prepare('SELECT id FROM users').get().id;
    const webCookie = (await createSession(env.DB, userId, 'vitest'))[0]!.split(';')[0]!;
    const webToken = webCookie.split('=')[1]!;
    expect((await call(me, new Request(`${ORIGIN}/api/me`, { headers: bearer(webToken) }))).status).toBe(401);
    expect((await call(me, new Request(`${ORIGIN}/api/me`, { headers: { Cookie: `__Host-sid=${token}` } }))).status).toBe(401);
    expect((await call(me, new Request(`${ORIGIN}/api/me`, { headers: { Cookie: webCookie } }))).status).toBe(200);
  });

  it('剩余有效期不足 30 天时，使用即续期到 90 天', async () => {
    const token = await appToken();
    env.DB.raw.prepare('UPDATE sessions SET expires_at = ?').run(Date.now() + 10 * 86_400_000);
    await call(me, new Request(`${ORIGIN}/api/me`, { headers: bearer(token) }));
    const left = env.DB.raw.prepare('SELECT expires_at FROM sessions').get().expires_at - Date.now();
    expect(left).toBeGreaterThan(89 * 86_400_000);
  });

  it('App 提交反馈不需要 Origin；网页 Cookie 请求仍要求同源', async () => {
    const token = await appToken();
    const fb = { appId: 'general', category: 'feature', title: '希望支持小组件', body: '在主屏幕显示最新版本信息。' };
    expect((await call(submitFeedback, post('/api/feedback', fb, bearer(token)))).status).toBe(201);
    const userId = env.DB.raw.prepare('SELECT id FROM users').get().id;
    const webCookie = (await createSession(env.DB, userId, 'vitest'))[0]!.split(';')[0]!;
    expect((await call(submitFeedback, post('/api/feedback', fb, { Cookie: webCookie }))).status).toBe(403);
  });

  it('退出登录删除会话', async () => {
    const token = await appToken();
    expect((await call(logout, post('/api/auth/logout', {}, bearer(token)))).status).toBe(204);
    expect((await call(me, new Request(`${ORIGIN}/api/me`, { headers: bearer(token) }))).status).toBe(401);
  });
});

describe('设备关联与注销账号', () => {
  const DEVICE = '7d1a3b2c-0000-4000-8000-0000000000aa';
  const SECRET = 'd'.repeat(64);

  async function setup() {
    mockFetch();
    const token = ((await (await appleSignIn()).json()) as any).token as string;
    const reg = await call(putDevice, new Request(`${ORIGIN}/api/devices/${DEVICE}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...bearer(SECRET) },
      body: JSON.stringify({ token: 'ab'.repeat(32), env: 'sandbox', locale: 'zh', enabled: true, subscriptions: { news: true, allApps: true, apps: [], beta: [] } }),
    }), { id: DEVICE });
    expect(reg.status).toBe(201);
    return token;
  }
  const deviceUser = () => env.DB.raw.prepare('SELECT user_id FROM devices WHERE id = ?').get(DEVICE)?.user_id;

  it('设备密钥正确才能关联；网页会话不能调用', async () => {
    const token = await setup();
    expect((await call(linkDevice, post('/api/me/devices', { deviceId: DEVICE, deviceSecret: 'x'.repeat(64) }, bearer(token)))).status).toBe(403);
    expect((await call(linkDevice, post('/api/me/devices', { deviceId: DEVICE.replace('aa', 'bb'), deviceSecret: SECRET }, bearer(token)))).status).toBe(404);
    expect((await call(linkDevice, post('/api/me/devices', { deviceId: DEVICE, deviceSecret: SECRET }))).status).toBe(401);
    expect((await call(linkDevice, post('/api/me/devices', { deviceId: DEVICE, deviceSecret: SECRET }, bearer(token)))).status).toBe(204);
    expect(deviceUser()).toBe(env.DB.raw.prepare('SELECT id FROM users').get().id);
  });

  it('退出登录时带上设备信息即解除关联，设备本身保留', async () => {
    const token = await setup();
    await call(linkDevice, post('/api/me/devices', { deviceId: DEVICE, deviceSecret: SECRET }, bearer(token)));
    await call(logout, post('/api/auth/logout', { deviceId: DEVICE, deviceSecret: SECRET }, bearer(token)));
    expect(deviceUser()).toBeNull();
  });

  it('注销账号：撤销 Apple 授权（使用解密后的 refresh token）、解除设备关联、删除用户', async () => {
    const token = await setup();
    await call(linkDevice, post('/api/me/devices', { deviceId: DEVICE, deviceSecret: SECRET }, bearer(token)));
    const calls = mockFetch();
    const res = await call(deleteMe, new Request(`${ORIGIN}/api/me`, { method: 'DELETE', headers: bearer(token) }));
    expect(res.status).toBe(204);
    const revoke = calls.find((c) => c.url.endsWith('/auth/revoke'))!;
    expect(new URLSearchParams(revoke.body).get('token')).toBe('apple-refresh-xyz');
    expect(new URLSearchParams(revoke.body).get('token_type_hint')).toBe('refresh_token');
    expect(deviceUser()).toBeNull();
    expect(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM users').get().n).toBe(0);
    expect(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM devices').get().n).toBe(1);
  });

  it('Apple 撤销失败时仍删除账号数据', async () => {
    const token = await setup();
    mockFetch({ revokeFails: true });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await call(deleteMe, new Request(`${ORIGIN}/api/me`, { method: 'DELETE', headers: bearer(token) }))).status).toBe(204);
    expect(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM users').get().n).toBe(0);
    expect(spy).toHaveBeenCalled();
  });
});
