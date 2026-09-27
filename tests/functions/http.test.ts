import { describe, expect, it } from 'vitest';
import { pkceChallenge, safeEqual } from '../../functions/_lib/crypto';
import { isSameOrigin, parseCookies, safeNext, serializeCookie, withAuthFlag } from '../../functions/_lib/http';

describe('safeNext：只允许站内路径', () => {
  it.each([
    ['/feedback/', '/feedback/'],
    ['/en/apps/aetherroute/?x=1#faq', '/en/apps/aetherroute/?x=1#faq'],
    ['/a/../b/', '/b/'],
  ])('%s → %s', (input, out) => expect(safeNext(input)).toBe(out));

  it.each([
    null, '', 'https://evil.com/', '//evil.com/', '/\\evil.com', '\\\\evil.com', 'javascript:alert(1)',
    '/foo\nbar', '/api/me', '/api/auth/google/login', 'feedback/', '/' + 'a'.repeat(600),
  ])('拒绝 %j', (input) => expect(safeNext(input as string)).toBe('/'));

  it('%0d%0a 这类编码后的换行只是普通路径字符', () => {
    // URL 解析后仍是编码形式，不会写进响应头成为真正的换行
    expect(safeNext('/%0d%0a')).toBe('/%0d%0a');
  });
});

it('withAuthFlag 替换已有 hash', () => {
  expect(withAuthFlag('/x/#faq', 'login-failed')).toBe('/x/#login-failed');
});

describe('Cookie', () => {
  it('序列化带安全属性', () => {
    expect(serializeCookie('__Host-sid', 'abc', { maxAge: 60 })).toBe('__Host-sid=abc; Path=/; Secure; SameSite=Lax; HttpOnly; Max-Age=60');
    expect(serializeCookie('hint', '1', { httpOnly: false })).not.toContain('HttpOnly');
  });
  it('解析时同名取第一个', () => {
    expect(parseCookies('a=1; b=x=y; a=2')).toEqual({ a: '1', b: 'x=y' });
    expect(parseCookies(null)).toEqual({});
  });
});

describe('isSameOrigin', () => {
  const req = (h: Record<string, string>) => new Request('https://aethernative.com/api/auth/logout', { method: 'POST', headers: h });
  it('同源 Origin 通过', () => expect(isSameOrigin(req({ Origin: 'https://aethernative.com' }))).toBe(true));
  it('跨站 Origin 拒绝', () => expect(isSameOrigin(req({ Origin: 'https://evil.com' }))).toBe(false));
  it('没有 Origin 时看 Referer', () => {
    expect(isSameOrigin(req({ Referer: 'https://aethernative.com/feedback/' }))).toBe(true);
    expect(isSameOrigin(req({ Referer: 'https://aethernative.com.evil.com/' }))).toBe(false);
  });
  it('两者都没有则拒绝', () => expect(isSameOrigin(req({}))).toBe(false));
});

it('PKCE S256 符合 RFC 7636 附录 B 示例', async () => {
  expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

it('safeEqual', () => {
  expect(safeEqual('abc', 'abc')).toBe(true);
  expect(safeEqual('abc', 'abd')).toBe(false);
  expect(safeEqual('abc', 'abcd')).toBe(false);
});
