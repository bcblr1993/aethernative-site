// 用 Apple 登录（iPhone App 原生流程）：校验 identity token、生成 client_secret、换取与撤销 refresh token。
// 文档：https://developer.apple.com/documentation/sign_in_with_apple/sign_in_with_apple_rest_api
// 全部基于 Web Crypto，Workers 与 Node 都可用。
import { base64url, sha256Hex } from './crypto';
import type { Env } from './env';

export const APPLE_ISSUER = 'https://appleid.apple.com';
const KEYS_URL = 'https://appleid.apple.com/auth/keys';
const TOKEN_URL = 'https://appleid.apple.com/auth/token';
const REVOKE_URL = 'https://appleid.apple.com/auth/revoke';

export interface AppleConfig {
  teamId: string;
  bundleId: string;
  keyId: string;
  /** Sign in with Apple 私钥（.p8，PEM） */
  privateKey: string;
  /** 加密 refresh token 的 AES-256 密钥（base64，32 字节） */
  tokenKey: string;
}

/** 四项都配置了才启用 Apple 登录：注销账号时必须能撤销授权，缺一不可。 */
export function appleConfig(env: Env): AppleConfig | null {
  const teamId = env.APPLE_TEAM_ID?.trim();
  const keyId = env.APPLE_SIWA_KEY_ID?.trim();
  const privateKey = env.APPLE_SIWA_KEY?.trim();
  const tokenKey = env.APPLE_TOKEN_KEY?.trim();
  if (!teamId || !keyId || !privateKey || !tokenKey) return null;
  return { teamId, keyId, privateKey, tokenKey, bundleId: env.APPLE_BUNDLE_ID?.trim() || 'com.aethernative.app' };
}

const b64urlDecode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const enc = new TextEncoder();

// ---------- identity token ----------

interface Jwk { kid: string; kty: string; alg: string; n: string; e: string; use?: string }
let keyCache: { keys: Jwk[]; at: number } | null = null;
const KEY_TTL_MS = 3600_000;

/** Apple 的公钥（JWKS），缓存 1 小时；遇到不认识的 kid（Apple 轮换了密钥）时强制刷新一次。 */
async function appleKey(kid: string, fetcher: typeof fetch, now: number) {
  const find = () => keyCache?.keys.find((k) => k.kid === kid);
  if (!find() || !keyCache || now - keyCache.at > KEY_TTL_MS) {
    const res = await fetcher(KEYS_URL);
    if (!res.ok) throw new Error(`读取 Apple 公钥失败：HTTP ${res.status}`);
    keyCache = { keys: ((await res.json()) as { keys: Jwk[] }).keys, at: now };
  }
  const jwk = find();
  if (!jwk) throw new Error('identity token 的 kid 不在 Apple 公钥中');
  return crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}

/** 测试用：清空公钥缓存 */
export const resetAppleKeyCache = () => (keyCache = null);

export interface AppleIdentity {
  /** Apple 用户 ID（同一开发者团队下不变） */
  sub: string;
  email: string | null;
}

/**
 * 校验 App 传来的 identity token：签名（RS256，Apple 公钥）、签发方、受众（Bundle ID）、有效期，
 * 以及 nonce——App 发起登录时把 SHA256(随机数) 交给 Apple，再把原始随机数交给我们，防止 token 被截获后重放。
 */
export async function verifyIdentityToken(
  token: string,
  opts: { bundleId: string; rawNonce: string },
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<AppleIdentity> {
  const parts = token.split('.');
  if (parts.length !== 3 || token.length > 4096) throw new Error('identity token 格式错误');
  const [h, p, s] = parts as [string, string, string];
  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('identity token 算法不受支持');

  const key = await appleKey(header.kid, fetcher, now);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(s), enc.encode(`${h}.${p}`));
  if (!ok) throw new Error('identity token 签名无效');

  const c = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  const sec = Math.floor(now / 1000);
  if (c.iss !== APPLE_ISSUER) throw new Error('identity token 签发方错误');
  if (c.aud !== opts.bundleId) throw new Error('identity token 受众不是本 App');
  if (typeof c.exp !== 'number' || c.exp < sec) throw new Error('identity token 已过期');
  if (typeof c.iat === 'number' && c.iat > sec + 300) throw new Error('identity token 签发时间在未来');
  if (!opts.rawNonce || c.nonce !== (await sha256Hex(opts.rawNonce))) throw new Error('nonce 不匹配');
  if (typeof c.sub !== 'string' || !c.sub) throw new Error('identity token 缺少 sub');

  const verified = c.email_verified === true || c.email_verified === 'true';
  const email = verified && typeof c.email === 'string' && c.email.length <= 320 ? c.email : null;
  return { sub: c.sub, email };
}

// ---------- client_secret / refresh token ----------

function pemToDer(pem: string) {
  const b64 = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** 调用 Apple REST API 用的 client_secret：用 Sign in with Apple 私钥签名的 ES256 JWT，5 分钟有效。 */
export async function clientSecret(cfg: AppleConfig, now = Date.now()) {
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(cfg.privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const iat = Math.floor(now / 1000);
  const head = base64url(enc.encode(JSON.stringify({ alg: 'ES256', kid: cfg.keyId })));
  const body = base64url(enc.encode(JSON.stringify({ iss: cfg.teamId, iat, exp: iat + 300, aud: APPLE_ISSUER, sub: cfg.bundleId })));
  // Web Crypto 的 ECDSA 签名本身就是 JWS 要求的 r||s 格式
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${base64url(sig)}`;
}

/** 用 App 传来的 authorization code 换取 refresh token（之后用于撤销授权）。 */
export async function exchangeCode(cfg: AppleConfig, code: string, fetcher: typeof fetch = fetch) {
  const res = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.bundleId, client_secret: await clientSecret(cfg), code, grant_type: 'authorization_code' }),
  });
  const body = (await res.json().catch(() => ({}))) as { refresh_token?: string; error?: string };
  if (!res.ok || !body.refresh_token) throw new Error(`Apple 换取令牌失败：HTTP ${res.status} ${body.error ?? ''}`.trim());
  return body.refresh_token;
}

/** 撤销授权：用户在“设置 → Apple ID → 使用 Apple 登录”中会看到本 App 被移除。 */
export async function revokeToken(cfg: AppleConfig, refreshToken: string, fetcher: typeof fetch = fetch) {
  const res = await fetcher(REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.bundleId, client_secret: await clientSecret(cfg), token: refreshToken, token_type_hint: 'refresh_token' }),
  });
  if (!res.ok) throw new Error(`Apple 撤销授权失败：HTTP ${res.status}`);
}

// ---------- refresh token 加密存储 ----------

async function aesKey(b64: string) {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error('APPLE_TOKEN_KEY 应为 32 字节（base64）');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptToken(cfg: AppleConfig, plain: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(cfg.tokenKey), enc.encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return `v1.${base64url(out)}`;
}

export async function decryptToken(cfg: AppleConfig, stored: string) {
  if (!stored.startsWith('v1.')) throw new Error('无法识别的加密格式');
  const data = b64urlDecode(stored.slice(3));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, await aesKey(cfg.tokenKey), data.slice(12));
  return new TextDecoder().decode(plain);
}
