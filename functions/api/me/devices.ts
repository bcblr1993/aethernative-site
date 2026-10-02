// POST /api/me/devices —— App 登录后把这台设备关联到账号（用于推送“反馈有新回复”）。
// Authorization: Bearer <App 会话>；{ deviceId, deviceSecret } 证明设备归属（与 /api/devices 使用的设备密钥相同）。
import { safeEqual, sha256Hex } from '../../_lib/crypto';
import { isDeviceId } from '../../_lib/devices';
import type { Env } from '../../_lib/env';
import { error } from '../../_lib/http';
import { readJson } from '../../_lib/push-auth';
import { authenticate } from '../../_lib/session';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await authenticate(env.DB, request);
  if (!auth || auth.via !== 'bearer') return error(401, 'unauthenticated');
  const body = await readJson(request, 2 * 1024);
  if (!body.ok) return body.response;
  const o = (body.value && typeof body.value === 'object' ? body.value : {}) as Record<string, unknown>;
  if (!isDeviceId(o.deviceId) || typeof o.deviceSecret !== 'string' || o.deviceSecret.length > 128) return error(400, 'invalid');

  const id = o.deviceId.toLowerCase();
  const found = await env.DB.prepare('SELECT secret_hash FROM devices WHERE id = ?').bind(id).first<{ secret_hash: string }>();
  if (!found) return error(404, 'device_not_found');
  if (!safeEqual(found.secret_hash, await sha256Hex(o.deviceSecret))) return error(403, 'forbidden');
  await env.DB.prepare('UPDATE devices SET user_id = ? WHERE id = ?').bind(auth.user.id, id).run();
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
};
