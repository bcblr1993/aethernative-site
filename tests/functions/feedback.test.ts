// 反馈接口：校验、频率限制、只能看到自己的反馈、注销时一并删除。数据库跑真实迁移。
import { beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, validateFeedback } from '../../functions/_lib/feedback';
import { onRequestPost as submit } from '../../functions/api/feedback/index';
import { onRequestGet as mine } from '../../functions/api/feedback/mine';
import { onRequestDelete as deleteMe } from '../../functions/api/me';
import { createSession, upsertUser } from '../../functions/_lib/session';
import { createD1 } from './d1';

const ORIGIN = 'https://aethernative.com';
let env: any;
const call = (fn: any, req: Request) => fn({ request: req, env, params: {} });

/** 直接建用户和会话，返回可用的 Cookie 头 */
async function session(id = 'g-1', name = 'Alice') {
  const user = await upsertUser(env.DB, { provider: 'google', id, name, email: null, avatarUrl: null });
  const cookies = await createSession(env.DB, user.id, 'vitest');
  return { user, cookie: cookies.map((c) => c.split(';')[0]).join('; ') };
}

const valid = { appId: 'aetherroute', category: 'bug', title: '订阅更新失败', body: '点击更新订阅后一直转圈，没有任何提示。', appVersion: '1.0.29', osVersion: 'macOS 26.0' };

function post(body: unknown, cookie: string, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/feedback`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: cookie, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const get = (cookie: string) => new Request(`${ORIGIN}/api/feedback/mine`, { headers: { Cookie: cookie } });

beforeEach(() => {
  env = { DB: createD1() };
});

describe('字段校验', () => {
  it('合法输入：去掉首尾空白、统一换行、去掉控制字符', () => {
    const r = validateFeedback({ ...valid, title: '  标题\u0007  有空格 ', body: ' 第一行内容\r\n第二行内容\u0000 ', appVersion: '', osVersion: undefined });
    expect(r).toEqual({ ok: true, value: { ...valid, title: '标题 有空格', body: '第一行内容\n第二行内容', appVersion: null, osVersion: null } });
  });

  it('逐项报告不合法的字段', () => {
    const r = validateFeedback({ appId: '../etc', category: 'spam', title: '', body: '太短', appVersion: '1.0<script>', osVersion: 'x'.repeat(41) });
    expect(r).toEqual({ ok: false, fields: ['app', 'category', 'title', 'body', 'appVersion', 'osVersion'] });
  });

  it('长度按字符计算：中文和 emoji 都算一个字', () => {
    expect(validateFeedback({ ...valid, title: '字'.repeat(LIMITS.title) }).ok).toBe(true);
    expect(validateFeedback({ ...valid, title: '😀'.repeat(LIMITS.title) }).ok).toBe(true);
    expect(validateFeedback({ ...valid, title: '字'.repeat(LIMITS.title + 1) }).ok).toBe(false);
    expect(validateFeedback({ ...valid, body: '字'.repeat(LIMITS.body + 1) }).ok).toBe(false);
  });

  it('非对象输入不会抛异常', () => {
    for (const raw of [null, 42, 'x', []]) expect(validateFeedback(raw).ok).toBe(false);
  });
});

describe('提交与查看', () => {
  it('提交成功后出现在“我的反馈”，状态为 new，不暴露 user_id', async () => {
    const { cookie } = await session();
    const res: Response = await call(submit, post(valid, cookie));
    expect(res.status).toBe(201);
    const { feedback } = await res.json();
    expect(feedback).toMatchObject({ appId: 'aetherroute', category: 'bug', title: valid.title, status: 'new', reply: null });
    expect(feedback).not.toHaveProperty('user_id');

    const list = await (await call(mine, get(cookie))).json();
    expect(list.feedback.map((f: any) => f.id)).toEqual([feedback.id]);
  });

  it('只能看到自己的反馈', async () => {
    const a = await session('g-1', 'Alice');
    const b = await session('g-2', 'Bob');
    await call(submit, post(valid, a.cookie));
    const list = await (await call(mine, get(b.cookie))).json();
    expect(list.feedback).toEqual([]);
  });

  it('按时间倒序，并带上管理员回复', async () => {
    const { user, cookie } = await session();
    await call(submit, post({ ...valid, title: '第一条' }, cookie));
    await call(submit, post({ ...valid, title: '第二条' }, cookie));
    env.DB.raw.prepare("UPDATE feedback SET created_at = created_at - 1000, status = 'replied', admin_reply = '已修复' WHERE title = '第一条' AND user_id = ?").run(user.id);
    const list = await (await call(mine, get(cookie))).json();
    expect(list.feedback.map((f: any) => [f.title, f.status, f.reply])).toEqual([
      ['第二条', 'new', null],
      ['第一条', 'replied', '已修复'],
    ]);
  });
});

describe('安全与限制', () => {
  it('未登录 401', async () => {
    expect((await call(submit, post(valid, ''))).status).toBe(401);
    expect((await call(mine, get(''))).status).toBe(401);
  });

  it('跨站请求 403，非 JSON 415', async () => {
    const { cookie } = await session();
    expect((await call(submit, post(valid, cookie, { Origin: 'https://evil.example' }))).status).toBe(403);
    expect((await call(submit, post(valid, cookie, { 'Content-Type': 'text/plain' }))).status).toBe(415);
    expect(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM feedback').get().n).toBe(0);
  });

  it('坏 JSON 400，字段错误 400 并返回字段名，超大请求 413', async () => {
    const { cookie } = await session();
    expect((await call(submit, post('{oops', cookie))).status).toBe(400);
    const bad: Response = await call(submit, post({ ...valid, category: 'x' }, cookie));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid', fields: ['category'] });
    expect((await call(submit, post({ ...valid, body: 'x'.repeat(LIMITS.requestBytes) }, cookie))).status).toBe(413);
  });

  it('每小时最多 5 条，超出返回 429 和 Retry-After', async () => {
    const { cookie } = await session();
    for (let i = 0; i < LIMITS.perHour; i++) expect((await call(submit, post(valid, cookie))).status).toBe(201);
    const res: Response = await call(submit, post(valid, cookie));
    expect(res.status).toBe(429);
    const wait = Number(res.headers.get('Retry-After'));
    expect(wait).toBeGreaterThan(3500);
    expect(wait).toBeLessThanOrEqual(3600);
    // 另一个用户不受影响
    const other = await session('g-2', 'Bob');
    expect((await call(submit, post(valid, other.cookie))).status).toBe(201);
  });

  it('每天最多 20 条（按 24 小时滚动计算）', async () => {
    const { user, cookie } = await session();
    const now = Date.now();
    const ins = env.DB.raw.prepare(
      "INSERT INTO feedback (id, user_id, app_id, category, title, body, created_at, updated_at) VALUES (?, ?, 'general', 'other', 't', 'body body body', ?, ?)",
    );
    // 20 条都在 1~23 小时前：小时额度未满，但天额度已满
    for (let i = 0; i < LIMITS.perDay; i++) ins.run(`f${i}`, user.id, now - 3600_000 * (1 + i), now);
    const res: Response = await call(submit, post(valid, cookie));
    expect(res.status).toBe(429);
    // 最早一条在 20 小时前，还要等约 4 小时
    expect(Math.round(Number(res.headers.get('Retry-After')) / 3600)).toBe(4);
    // 最早的一条过了 24 小时后恢复
    env.DB.raw.prepare("UPDATE feedback SET created_at = ? WHERE id = 'f19'").run(now - 86400_000 - 1);
    expect((await call(submit, post(valid, cookie))).status).toBe(201);
  });

  it('注销账号一并删除反馈，不影响其他用户', async () => {
    const a = await session('g-1', 'Alice');
    const b = await session('g-2', 'Bob');
    await call(submit, post(valid, a.cookie));
    await call(submit, post(valid, b.cookie));
    const res: Response = await call(deleteMe, new Request(`${ORIGIN}/api/me`, { method: 'DELETE', headers: { Origin: ORIGIN, Cookie: a.cookie } }));
    expect(res.status).toBe(204);
    const rows = env.DB.raw.prepare('SELECT user_id FROM feedback').all();
    expect(rows).toEqual([{ user_id: b.user.id }]);
  });
});
