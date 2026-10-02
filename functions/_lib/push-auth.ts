// 推送服务（push-service）调用 /api/admin/push-* 的鉴权：Authorization: Bearer <PUSH_SERVICE_TOKEN>。
import { safeEqual, sha256Hex } from './crypto';
import type { Env } from './env';
import { error } from './http';

/** 通过返回 null；否则返回应直接返回的错误响应。没有配置令牌时一律 503，接口不会被意外打开。 */
export async function requirePushService(request: Request, env: Env): Promise<Response | null> {
  const expected = env.PUSH_SERVICE_TOKEN;
  if (!expected || expected.length < 32) return error(503, 'push_disabled');
  const m = /^Bearer (.{1,512})$/.exec(request.headers.get('Authorization') ?? '');
  // 比较两边的哈希：长度固定，常量时间比较不泄露令牌长度
  if (!m || !safeEqual(await sha256Hex(m[1]!), await sha256Hex(expected))) return error(401, 'unauthenticated');
  return null;
}

/** 读取 JSON 请求体，超过 maxBytes 或格式错误时返回错误响应。 */
export async function readJson(request: Request, maxBytes: number): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    return { ok: false, response: error(415, 'unsupported_media_type') };
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) return { ok: false, response: error(413, 'too_large') };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: error(400, 'bad_json') };
  }
}
