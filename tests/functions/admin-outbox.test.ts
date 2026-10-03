// 管理员回复反馈 → push_outbox → 推送服务领取 / 确认。数据库跑真实迁移。
import { beforeEach, describe, expect, it } from 'vitest';
import { onRequestGet as listAdmin } from '../../functions/api/admin/feedback/index';
import { onRequestPatch as patchAdmin } from '../../functions/api/admin/feedback/[id]';
import { onRequestPost as ack } from '../../functions/api/admin/push-outbox/ack';
import { onRequestPost as claim } from '../../functions/api/admin/push-outbox/claim';
import { onRequestPost as submit } from '../../functions/api/feedback/index';
import { onRequestGet as mine } from '../../functions/api/feedback/mine';
import { onRequestDelete as deleteMe } from '../../functions/api/me/index';
import { claimJobs, LEASE_MS, MAX_ATTEMPTS } from '../../functions/_lib/outbox';
import { createSession, upsertUser } from '../../functions/_lib/session';
import { createD1 } from './d1';

const ORIGIN = 'https://aethernative.com';
const SERVICE = 's'.repeat(40);
const tok = (n: number) => n.toString(16).padStart(64, '0');
let env: any;

async function session(id: string, admin = false) {
  const user = await upsertUser(env.DB, { provider: 'github', id, name: `用户${id}`, email: `${id}@example.com`, avatarUrl: null });
  if (admin) env.DB.raw.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
  const cookie = (await createSession(env.DB, user.id, 'vitest')).map((c) => c.split(';')[0]).join('; ');
  return { user, cookie };
}

/** 给用户挂一台已开启通知的设备 */
function device(userId: string, n: number, opts: { enabled?: number; locale?: string } = {}) {
  env.DB.raw
    .prepare(`INSERT INTO devices (id, secret_hash, token, env, locale, enabled, user_id, created_at, updated_at, last_seen_at) VALUES (?, 'h', ?, 'sandbox', ?, ?, ?, 0, 0, 0)`)
    .run(`dev-${n}`, tok(n), opts.locale ?? 'zh', opts.enabled ?? 1, userId);
}

async function feedbackOf(cookie: string, title = '订阅更新失败') {
  const res: Response = await (submit as any)({
    request: new Request(`${ORIGIN}/api/feedback`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ appId: 'aetherroute', category: 'bug', title, body: '点击更新订阅后一直转圈，没有任何提示。' }),
    }),
    env,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as any).feedback.id as string;
}

const patch = (id: string, body: unknown, cookie: string, origin = ORIGIN) =>
  (patchAdmin as any)({
    request: new Request(`${ORIGIN}/api/admin/feedback/${id}`, {
      method: 'PATCH',
      headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    }),
    env,
    params: { id },
  }) as Promise<Response>;

const service = (fn: any, path: string, body: unknown = {}, token = SERVICE) =>
  fn({
    request: new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    env,
  }) as Promise<Response>;

const outbox = () => env.DB.raw.prepare('SELECT * FROM push_outbox').all() as any[];

beforeEach(() => {
  env = { DB: createD1(), PUSH_SERVICE_TOKEN: SERVICE };
});

describe('管理员权限', () => {
  it('非管理员 403，未登录 401；写操作要求同源', async () => {
    const alice = await session('alice');
    const admin = await session('boss', true);
    const id = await feedbackOf(alice.cookie);
    const get = (cookie?: string) => (listAdmin as any)({ request: new Request(`${ORIGIN}/api/admin/feedback`, { headers: cookie ? { Cookie: cookie } : {} }), env });
    expect((await get()).status).toBe(401);
    expect((await get(alice.cookie)).status).toBe(403);
    expect((await get(admin.cookie)).status).toBe(200);
    expect((await patch(id, { status: 'triaged' }, alice.cookie)).status).toBe(403);
    expect((await patch(id, { status: 'triaged' }, admin.cookie, 'https://evil.example.com')).status).toBe(403);
  });
});

describe('管理员查看与回复', () => {
  it('列表包含提交者昵称与邮箱，可按状态筛选', async () => {
    const alice = await session('alice');
    const admin = await session('boss', true);
    const a = await feedbackOf(alice.cookie, '第一条');
    await feedbackOf(alice.cookie, '第二条');
    await patch(a, { status: 'closed' }, admin.cookie);
    const list = async (q = '') => ((await (await (listAdmin as any)({ request: new Request(`${ORIGIN}/api/admin/feedback${q}`, { headers: { Cookie: admin.cookie } }), env })).json()) as any);
    const all = await list();
    expect(all.feedback).toHaveLength(2);
    expect(all.feedback[0].user).toEqual({ name: '用户alice', email: 'alice@example.com' });
    expect((await list('?status=closed')).feedback.map((f: any) => f.title)).toEqual(['第一条']);
    const bad = await (listAdmin as any)({ request: new Request(`${ORIGIN}/api/admin/feedback?status=spam`, { headers: { Cookie: admin.cookie } }), env });
    expect(bad.status).toBe(400);
  });

  it('回复后自动设为“已回复”，提交者在“我的反馈”中看到；有关联设备时排一条推送', async () => {
    const alice = await session('alice');
    const admin = await session('boss', true);
    device(alice.user.id, 1);
    const id = await feedbackOf(alice.cookie);
    const res = await patch(id, { reply: '  已在 1.1.1 修复，请更新。 ' }, admin.cookie);
    expect(await res.json()).toMatchObject({ feedback: { status: 'replied', reply: '已在 1.1.1 修复，请更新。' }, notified: true });

    const m = (await (await (mine as any)({ request: new Request(`${ORIGIN}/api/feedback/mine`, { headers: { Cookie: alice.cookie } }), env })).json()) as any;
    expect(m.feedback[0]).toMatchObject({ status: 'replied', reply: '已在 1.1.1 修复，请更新。' });
    const [job] = outbox();
    expect(job).toMatchObject({ kind: 'feedback_reply', user_id: alice.user.id, ref_id: id, sent_at: null, attempts: 0 });
    expect(JSON.parse(job.alert)).toEqual({
      zh: { title: '你的反馈有新回复', body: '订阅更新失败' },
      en: { title: 'New reply to your feedback', body: '订阅更新失败' },
    });
  });

  it('只改状态、回复内容未变化、没有关联设备时都不排推送；指定状态时以指定为准', async () => {
    const alice = await session('alice');
    const admin = await session('boss', true);
    const id = await feedbackOf(alice.cookie);
    expect(await (await patch(id, { reply: '收到' }, admin.cookie)).json()).toMatchObject({ notified: false });
    device(alice.user.id, 1);
    expect(await (await patch(id, { status: 'triaged' }, admin.cookie)).json()).toMatchObject({ feedback: { status: 'triaged' }, notified: false });
    expect(await (await patch(id, { reply: '收到' }, admin.cookie)).json()).toMatchObject({ notified: false });
    expect(await (await patch(id, { reply: '已修复', status: 'closed' }, admin.cookie)).json()).toMatchObject({ feedback: { status: 'closed' }, notified: true });
    expect(outbox()).toHaveLength(1);
  });

  it('同一反馈未发出的旧推送被最新回复替换', async () => {
    const alice = await session('alice');
    const admin = await session('boss', true);
    device(alice.user.id, 1);
    const id = await feedbackOf(alice.cookie);
    await patch(id, { reply: '第一次回复' }, admin.cookie);
    await patch(id, { reply: '第二次回复' }, admin.cookie);
    expect(outbox()).toHaveLength(1);
  });

  it('参数错误 400，反馈不存在 404', async () => {
    const admin = await session('boss', true);
    const alice = await session('alice');
    const id = await feedbackOf(alice.cookie);
    expect((await patch(id, {}, admin.cookie)).status).toBe(400);
    expect((await patch(id, { status: 'done' }, admin.cookie)).status).toBe(400);
    expect((await patch(id, { reply: 'x'.repeat(5001) }, admin.cookie)).status).toBe(400);
    expect((await patch('nope', { status: 'closed' }, admin.cookie)).status).toBe(404);
  });
});

describe('推送服务领取与确认', () => {
  async function queued(locale = 'zh') {
    const alice = await session('alice');
    const admin = await session('boss', true);
    device(alice.user.id, 1, { locale });
    device(alice.user.id, 2, { enabled: 0 });
    const id = await feedbackOf(alice.cookie);
    await patch(id, { reply: '已修复' }, admin.cookie);
    return { alice, id };
  }

  it('领取返回通知内容、跳转与开启了通知的设备；确认后不再被领取', async () => {
    const { id } = await queued('en');
    const r1 = (await (await service(claim, '/api/admin/push-outbox/claim')).json()) as any;
    expect(r1.jobs).toHaveLength(1);
    const job = r1.jobs[0];
    expect(job.route).toEqual({ kind: 'feedback', id });
    expect(job.targets).toEqual([{ token: tok(1), env: 'sandbox', locale: 'en' }]);
    expect(job.alert.en.title).toBe('New reply to your feedback');

    // 租约期内不会被重复领取
    expect(((await (await service(claim, '/api/admin/push-outbox/claim')).json()) as any).jobs).toHaveLength(0);
    const a = (await (await service(ack, '/api/admin/push-outbox/ack', { ids: [job.id], invalidTokens: [tok(1)] })).json()) as any;
    expect(a).toEqual({ acked: 1, removed: 1 });
    expect(outbox()[0].sent_at).not.toBeNull();
    expect(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM devices').get().n).toBe(1);
  });

  it('领取后未确认：租约过期可重新领取；最多尝试 5 次', async () => {
    await queued();
    let now = Date.now();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      expect(await claimJobs(env.DB, now)).toHaveLength(1);
      expect(await claimJobs(env.DB, now + 1000)).toHaveLength(0);
      now += LEASE_MS + 1;
    }
    expect(await claimJobs(env.DB, now)).toHaveLength(0);
    expect(outbox()[0].attempts).toBe(MAX_ATTEMPTS);
  });

  it('服务令牌错误 401、未配置 503；参数错误 400', async () => {
    expect((await service(claim, '/api/admin/push-outbox/claim', {}, 'wrong')).status).toBe(401);
    expect((await service(ack, '/api/admin/push-outbox/ack', { ids: 'x' })).status).toBe(400);
    env.PUSH_SERVICE_TOKEN = undefined;
    expect((await service(claim, '/api/admin/push-outbox/claim')).status).toBe(503);
  });

  it('注销账号时一并删除该用户待发的推送', async () => {
    const { alice } = await queued();
    const res = await (deleteMe as any)({ request: new Request(`${ORIGIN}/api/me`, { method: 'DELETE', headers: { Origin: ORIGIN, Cookie: alice.cookie } }), env });
    expect(res.status).toBe(204);
    expect(outbox()).toHaveLength(0);
  });
});
