// PUT /api/devices/:id —— iPhone App 注册或更新推送设备与订阅；DELETE —— 注销设备。
// :id 是 App 生成的安装 ID，Authorization: Bearer <设备密钥>。不需要登录，也不使用 Cookie（因此不做同源校验）。
import { bearer, deleteDevice, DEVICE_LIMITS, isDeviceId, upsertDevice, validateDevice } from '../../_lib/devices';
import type { Env } from '../../_lib/env';
import { error, json } from '../../_lib/http';
import { readJson } from '../../_lib/push-auth';

export const onRequestPut: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  if (!isDeviceId(params.id)) return error(404, 'not_found');
  const secret = bearer(request);
  if (!secret) return error(401, 'unauthenticated');

  const body = await readJson(request, DEVICE_LIMITS.requestBytes);
  if (!body.ok) return body.response;
  const v = validateDevice(body.value);
  if (!v.ok) return json({ error: 'invalid', fields: v.fields }, 400);

  const r = await upsertDevice(env.DB, params.id.toLowerCase(), secret, v.value);
  if (r.status === 'forbidden') return error(403, 'forbidden');
  return json({ subscriptions: r.subscriptions }, r.status === 'created' ? 201 : 200);
};

export const onRequestDelete: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  if (!isDeviceId(params.id)) return error(404, 'not_found');
  const secret = bearer(request);
  if (!secret) return error(401, 'unauthenticated');
  const r = await deleteDevice(env.DB, params.id.toLowerCase(), secret);
  if (r === 'forbidden') return error(403, 'forbidden');
  // 已不存在也视为成功：重复注销是幂等的
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
};
