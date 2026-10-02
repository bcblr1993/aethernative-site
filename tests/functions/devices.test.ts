// 推送设备与推送服务接口：注册 / 更新 / 注销、设备密钥、按订阅查找目标、失效 token 删除、服务令牌。数据库跑真实迁移。
import { beforeEach, describe, expect, it } from 'vitest';
import { validateDevice } from '../../functions/_lib/devices';
import { onRequestDelete as del, onRequestPut as put } from '../../functions/api/devices/[id]';
import { onRequestPost as report } from '../../functions/api/admin/push-report';
import { onRequestGet as targets } from '../../functions/api/admin/push-targets';
import { createD1 } from './d1';

const ORIGIN = 'https://aethernative.com';
const SERVICE = 's'.repeat(40);
const ID = '7d1a3b2c-0000-4000-8000-000000000001';
const SECRET = 'a'.repeat(43);
const tok = (n: number) => n.toString(16).padStart(64, '0');

let env: any;

const device = (over: Record<string, unknown> = {}) => ({
  token: tok(1),
  env: 'production',
  locale: 'zh',
  enabled: true,
  appVersion: '0.1.0 (1)',
  subscriptions: { news: true, allApps: true, apps: [], beta: [] },
  ...over,
});

function putReq(id: string, body: unknown, secret: string | null = SECRET, contentType = 'application/json') {
  const headers: Record<string, string> = { 'Content-Type': contentType };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  return put({
    request: new Request(`${ORIGIN}/api/devices/${id}`, { method: 'PUT', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }),
    env,
    params: { id },
  } as any) as Promise<Response>;
}

const delReq = (id: string, secret = SECRET) =>
  del({ request: new Request(`${ORIGIN}/api/devices/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${secret}` } }), env, params: { id } } as any) as Promise<Response>;

async function getTargets(query: string, auth = SERVICE) {
  const r: Response = await (targets as any)({
    request: new Request(`${ORIGIN}/api/admin/push-targets?${query}`, { headers: { Authorization: `Bearer ${auth}` } }),
    env,
  });
  return { status: r.status, body: (await r.json()) as any };
}

const tokensOf = async (query: string) => ((await getTargets(query)).body.targets as { token: string }[]).map((t) => t.token).sort();

/** 注册多台设备：n 号设备的 id 末尾和 token 都是 n */
async function register(n: number, over: Record<string, unknown> = {}) {
  const id = ID.slice(0, -1) + n.toString(16);
  const r = await putReq(id, device({ token: tok(n), ...over }));
  expect(r.status).toBe(201);
  return id;
}

beforeEach(() => {
  env = { DB: createD1(), PUSH_SERVICE_TOKEN: SERVICE };
});

describe('字段校验', () => {
  it('合法输入：token 统一小写，allApps 时忽略 apps，软件列表去重排序', () => {
    const r = validateDevice(device({ token: tok(1).toUpperCase(), subscriptions: { news: false, allApps: true, apps: ['x'], beta: ['b', 'a', 'b'] } }));
    expect(r).toEqual({
      ok: true,
      value: { ...device(), subscriptions: { news: false, allApps: true, apps: [], beta: ['a', 'b'] } },
    });
  });

  it('逐项报告不合法的字段', () => {
    const r = validateDevice({ token: 'xyz', env: 'dev', locale: 'fr', enabled: 'yes', appVersion: '<script>', subscriptions: { news: true, allApps: false, apps: ['../etc'], beta: [] } });
    expect(r).toEqual({ ok: false, fields: ['token', 'env', 'locale', 'enabled', 'appVersion', 'subscriptions'] });
  });

  it('非对象输入、软件过多都不会抛异常', () => {
    for (const raw of [null, 42, 'x', []]) expect(validateDevice(raw).ok).toBe(false);
    const many = Array.from({ length: 51 }, (_, i) => `app-${i}`);
    expect(validateDevice(device({ subscriptions: { news: true, allApps: false, apps: many, beta: [] } })).ok).toBe(false);
  });
});

describe('注册与更新', () => {
  it('首次注册 201，再次提交 200 并更新字段；数据库只存密钥哈希', async () => {
    expect((await putReq(ID, device())).status).toBe(201);
    const r = await putReq(ID, device({ locale: 'en', enabled: false }));
    expect(r.status).toBe(200);
    const row = env.DB.raw.prepare('SELECT * FROM devices').get();
    expect(row).toMatchObject({ id: ID, token: tok(1), locale: 'en', enabled: 0 });
    expect(row.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });

  it('设备密钥不一致时拒绝修改，原数据不变', async () => {
    await putReq(ID, device());
    const r = await putReq(ID, device({ token: tok(9) }), 'b'.repeat(43));
    expect(r.status).toBe(403);
    expect(env.DB.raw.prepare('SELECT token FROM devices').get().token).toBe(tok(1));
  });

  it('缺少或格式错误的密钥 401，安装 ID 不是 UUID 404，非 JSON 415', async () => {
    expect((await putReq(ID, device(), null)).status).toBe(401);
    expect((await putReq(ID, device(), 'short')).status).toBe(401);
    expect((await putReq('not-a-uuid', device())).status).toBe(404);
    expect((await putReq(ID, 'token=1', SECRET, 'application/x-www-form-urlencoded')).status).toBe(415);
    expect((await putReq(ID, '{bad')).status).toBe(400);
    expect((await putReq(ID, { ...device(), appVersion: 'x'.repeat(9000) })).status).toBe(413);
  });

  it('同一 token 换到新的安装 ID（重装 App）时，旧记录被删除', async () => {
    await register(1);
    const other = ID.slice(0, -1) + 'f';
    expect((await putReq(other, device({ token: tok(1) }), 'c'.repeat(43))).status).toBe(201);
    expect(env.DB.raw.prepare('SELECT id FROM devices').all()).toEqual([{ id: other }]);
  });

  it('注册新设备时清理 180 天未活跃的设备', async () => {
    await register(1);
    env.DB.raw.prepare('UPDATE devices SET last_seen_at = ?').run(Date.now() - 181 * 86_400_000);
    await register(2);
    expect(env.DB.raw.prepare('SELECT token FROM devices').all()).toEqual([{ token: tok(2) }]);
  });

  it('注销设备：密钥正确 204 并删除订阅；密钥错误 403；重复注销仍 204', async () => {
    await putReq(ID, device({ subscriptions: { news: true, allApps: false, apps: ['a'], beta: ['a'] } }));
    expect((await delReq(ID, 'b'.repeat(43))).status).toBe(403);
    expect((await delReq(ID)).status).toBe(204);
    expect(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM device_apps').get().n).toBe(0);
    expect((await delReq(ID)).status).toBe(204);
  });
});

describe('推送目标', () => {
  beforeEach(async () => {
    await register(1); // 默认：公告 + 全部软件正式版
    await register(2, { subscriptions: { news: false, allApps: false, apps: ['aetherroute'], beta: [] } });
    await register(3, { subscriptions: { news: true, allApps: false, apps: [], beta: ['aetherroute'] } }); // 只要测试版
    await register(4, { enabled: false }); // 系统通知已关闭
    await register(5, { env: 'sandbox', locale: 'en', subscriptions: { news: false, allApps: true, apps: [], beta: ['notchquota'] } });
  });

  it('公告：news 开启且通知已开启的设备', async () => {
    expect(await tokensOf('kind=news')).toEqual([tok(1), tok(3)]);
  });

  it('正式版：全部软件 + 单独订阅了该软件的设备', async () => {
    expect(await tokensOf('kind=release&app=aetherroute&channel=stable')).toEqual([tok(1), tok(2), tok(5)]);
    expect(await tokensOf('kind=release&app=notchquota&channel=stable')).toEqual([tok(1), tok(5)]);
  });

  it('测试版：只给单独开启了该软件测试版的设备，与是否订阅正式版无关', async () => {
    expect(await tokensOf('kind=release&app=aetherroute&channel=beta')).toEqual([tok(3)]);
    expect(await tokensOf('kind=release&app=notchquota&channel=beta')).toEqual([tok(5)]);
  });

  it('返回 token、环境与语言，不返回设备 id', async () => {
    const { body } = await getTargets('kind=release&app=notchquota&channel=beta');
    expect(body).toEqual({ targets: [{ token: tok(5), env: 'sandbox', locale: 'en' }], next: null });
  });

  it('参数错误 400', async () => {
    for (const q of ['', 'kind=video', 'kind=release&app=x', 'kind=release&app=../x&channel=stable', `kind=news&cursor=${'x'.repeat(65)}`]) {
      expect((await getTargets(q)).status).toBe(400);
    }
  });
});

describe('分页', () => {
  it('满一页时返回 next，用 cursor 取下一页，最后一页 next 为 null', async () => {
    for (let n = 1; n <= 1201; n++) {
      env.DB.raw
        .prepare(`INSERT INTO devices (id, secret_hash, token, env, locale, created_at, updated_at, last_seen_at) VALUES (?, 'h', ?, 'production', 'zh', 0, 0, 0)`)
        .run(`id-${String(n).padStart(5, '0')}`, tok(n));
    }
    const seen: string[] = [];
    let cursor = '';
    let pages = 0;
    do {
      const { body } = await getTargets(`kind=news&cursor=${cursor}`);
      seen.push(...body.targets.map((t: any) => t.token));
      cursor = body.next ?? '';
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(1201);
  });
});

describe('推送服务回报', () => {
  const post = (body: unknown, auth = SERVICE) =>
    (report as any)({
      request: new Request(`${ORIGIN}/api/admin/push-report`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
    }) as Promise<Response>;

  it('删除失效 token（大小写不敏感），忽略格式错误的值，记录心跳', async () => {
    await register(1);
    await register(2);
    const r = await post({ invalidTokens: [tok(1).toUpperCase(), 'nonsense'], status: { sent: 3 } });
    expect(await r.json()).toEqual({ removed: 1, ignored: 1 });
    expect(env.DB.raw.prepare('SELECT token FROM devices').all()).toEqual([{ token: tok(2) }]);
    const s = env.DB.raw.prepare('SELECT * FROM push_status').get();
    expect(JSON.parse(s.detail)).toEqual({ sent: 3 });
  });

  it('只发心跳时保留上一次的统计', async () => {
    await post({ status: { sent: 3 } });
    await post({});
    expect(JSON.parse(env.DB.raw.prepare('SELECT detail FROM push_status').get().detail)).toEqual({ sent: 3 });
  });

  it('超过 50 个 token 时分批删除', async () => {
    for (let n = 1; n <= 120; n++) {
      env.DB.raw
        .prepare(`INSERT INTO devices (id, secret_hash, token, env, locale, created_at, updated_at, last_seen_at) VALUES (?, 'h', ?, 'production', 'zh', 0, 0, 0)`)
        .run(`id-${n}`, tok(n));
    }
    const r = await post({ invalidTokens: Array.from({ length: 120 }, (_, i) => tok(i + 1)) });
    expect((await r.json()).removed).toBe(120);
  });

  it('格式错误 400', async () => {
    expect((await post({ invalidTokens: 'x' })).status).toBe(400);
    expect((await post({ invalidTokens: [1, 2] })).status).toBe(400);
  });
});

describe('服务令牌', () => {
  it('令牌错误 401；未配置或太短时 503（接口不会被意外打开）', async () => {
    expect((await getTargets('kind=news', 'wrong')).status).toBe(401);
    env.PUSH_SERVICE_TOKEN = undefined;
    expect((await getTargets('kind=news')).status).toBe(503);
    env.PUSH_SERVICE_TOKEN = 'short';
    expect((await getTargets('kind=news', 'short')).status).toBe(503);
  });

  it('设备密钥不能当作服务令牌使用', async () => {
    await register(1);
    expect((await getTargets('kind=news', SECRET)).status).toBe(401);
  });
});
