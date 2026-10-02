// POST /api/auth/logout —— 删除当前会话。
// App（Bearer）可在请求体中带上 { deviceId, deviceSecret }，同时解除这台设备与账号的关联。
import { safeEqual, sha256Hex } from '../../_lib/crypto';
import { isDeviceId } from '../../_lib/devices';
import type { Env } from '../../_lib/env';
import { error, isSameOrigin } from '../../_lib/http';
import { authenticate, clearSessionCookies, deleteSession, hasBearer } from '../../_lib/session';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!hasBearer(request) && !isSameOrigin(request)) return error(403, 'bad_origin');
  if (hasBearer(request)) await unlinkDevice(request, env);
  await deleteSession(env.DB, request);
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  for (const c of clearSessionCookies()) headers.append('Set-Cookie', c);
  return new Response(null, { status: 204, headers });
};

async function unlinkDevice(request: Request, env: Env) {
  const auth = await authenticate(env.DB, request);
  if (!auth) return;
  let o: Record<string, unknown> = {};
  try {
    const text = await request.text();
    if (text && text.length <= 2048) o = JSON.parse(text);
  } catch {
    return;
  }
  if (!isDeviceId(o.deviceId) || typeof o.deviceSecret !== 'string' || o.deviceSecret.length > 128) return;
  const id = o.deviceId.toLowerCase();
  const found = await env.DB.prepare('SELECT secret_hash FROM devices WHERE id = ? AND user_id = ?').bind(id, auth.user.id).first<{ secret_hash: string }>();
  if (found && safeEqual(found.secret_hash, await sha256Hex(o.deviceSecret))) {
    await env.DB.prepare('UPDATE devices SET user_id = NULL WHERE id = ?').bind(id).run();
  }
}
