// 请求 / 响应的小工具：Cookie、JSON、重定向、同源校验、站内跳转地址清洗。

export interface CookieOptions {
  maxAge?: number;
  httpOnly?: boolean;
}

/** 生成 Set-Cookie。统一 Path=/、Secure、SameSite=Lax；名字以 __Host- 开头时浏览器会强制这些属性。 */
export function serializeCookie(name: string, value: string, { maxAge, httpOnly = true }: CookieOptions = {}) {
  const parts = [`${name}=${value}`, 'Path=/', 'Secure', 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  return parts.join('; ');
}

export const clearCookie = (name: string, httpOnly = true) => serializeCookie(name, '', { maxAge: 0, httpOnly });

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  const h = new Headers(headers);
  h.set('Content-Type', 'application/json; charset=utf-8');
  h.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { status, headers: h });
}

export const error = (status: number, code: string, headers: HeadersInit = {}) => json({ error: code }, status, headers);

/** 302 跳转，可同时设置多个 Cookie。 */
export function redirect(location: string, cookies: string[] = []) {
  const h = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const c of cookies) h.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers: h });
}

/**
 * 写操作的 CSRF 防护：要求 Origin（缺失时退回 Referer）与本站同源。
 * 配合 SameSite=Lax 的会话 Cookie，跨站表单和脚本都无法以用户身份发起写请求。
 */
export function isSameOrigin(request: Request) {
  const self = new URL(request.url).origin;
  const origin = request.headers.get('Origin');
  if (origin) return origin === self;
  const referer = request.headers.get('Referer');
  if (!referer) return false;
  try {
    return new URL(referer).origin === self;
  } catch {
    return false;
  }
}

/**
 * 登录完成后的跳转地址：只接受站内路径，防止被利用为开放重定向。
 * 拒绝 //evil.com、/\evil.com、带协议或控制字符的地址，以及 /api/ 下的接口地址。
 */
export function safeNext(raw: string | null | undefined, fallback = '/') {
  if (!raw || raw.length > 512) return fallback;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return fallback;
  try {
    const u = new URL(raw, 'https://placeholder.invalid');
    if (u.origin !== 'https://placeholder.invalid' || u.pathname.startsWith('/api/')) return fallback;
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}

/** 在跳转地址上附加登录结果标记（用 hash，不会发给服务器，也不影响页面缓存）。 */
export function withAuthFlag(next: string, flag: 'login-failed' | 'login-cancelled') {
  return next.replace(/#.*$/, '') + `#${flag}`;
}
