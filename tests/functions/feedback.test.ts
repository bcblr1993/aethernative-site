// 反馈接口：校验、频率限制、只能看到自己的反馈、注销时一并删除。数据库跑真实迁移。
import { beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, validateFeedback } from '../../functions/_lib/feedback';
import { onRequestPost as submit } from '../../functions/api/feedback/index';
import { onRequestGet as mine } from '../../functions/api/feedback/mine';
import { onRequestDelete as deleteMe, onRequestGet as me } from '../../functions/api/me/index';
import { onRequestGet as screenshot } from '../../functions/api/feedback/screenshots/[id]';
import { onRequestGet as adminList } from '../../functions/api/admin/feedback/index';
import { SCREENSHOT_LIMITS } from '../../functions/_lib/feedback-screenshots';
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

// 一张实际可解码的 1×1 PNG。
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=', 'base64');
function upload(cookie: string, images: Blob[] = [new Blob([png], { type: 'image/png' })]) {
  const data = new FormData();
  for (const [key, value] of Object.entries(valid)) data.set(key, value);
  images.forEach((image) => data.append('screenshots', image, 'screenshot.png'));
  return new Request(`${ORIGIN}/api/feedback`, { method: 'POST', headers: { Origin: ORIGIN, Cookie: cookie }, body: data });
}
const readImage = (id: string, cookie = '') => screenshot({
  request: new Request(`${ORIGIN}/api/feedback/screenshots/${id}`, { headers: { Cookie: cookie } }), env, params: { id },
} as any);

describe('反馈截图', () => {
  it('最多三张，列表只含地址；作者和管理员可读，匿名及其他用户不可读', async () => {
    const owner = await session();
    const other = await session('other');
    const admin = await session('admin');
    env.DB.raw.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin.user.id);
    const images = Array.from({ length: 3 }, () => new Blob([png], { type: 'image/png' }));
    const res = await call(submit, upload(owner.cookie, images));
    expect(res.status).toBe(201);
    const { feedback } = await res.json();
    expect(feedback.screenshots).toHaveLength(3);
    const id = feedback.screenshots[0].id;
    const mineResponse = await (await call(mine, get(owner.cookie))).json();
    expect(mineResponse.feedback[0].screenshots).toEqual(feedback.screenshots);
    const adminResponse = await (await call(adminList, get(admin.cookie))).json();
    expect(adminResponse.feedback[0].screenshots).toEqual(feedback.screenshots);
    const image = await readImage(id, owner.cookie);
    expect(image.status).toBe(200);
    expect(image.headers.get('Content-Type')).toBe('image/png');
    expect(image.headers.get('Cache-Control')).toContain('no-store');
    expect(image.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    expect((await readImage(id, admin.cookie)).status).toBe(200);
    expect((await readImage(id, other.cookie)).status).toBe(404);
    expect((await readImage(id)).status).toBe(401);
    expect((await readImage('missing', owner.cookie)).status).toBe(404);
  });

  it('拒绝超过三张、超大、空白、伪造类型和 SVG；不残留反馈或附件', async () => {
    const { cookie } = await session();
    const image = new Blob([png], { type: 'image/png' });
    for (const images of [
      [image, image, image, image],
      [new Blob([new Uint8Array(SCREENSHOT_LIMITS.bytes + 1)], { type: 'image/png' })],
      [new Blob([], { type: 'image/png' })],
      [new Blob(['not an image'], { type: 'image/png' })],
      [new Blob([png], { type: 'image/jpeg' })],
      [new Blob(['<svg/>'], { type: 'image/svg+xml' })],
    ]) {
      const res = await call(submit, upload(cookie, images));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid', fields: ['screenshots'] });
    }
    expect(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM feedback').get().n).toBe(0);
    expect(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM feedback_screenshots').get().n).toBe(0);
  });

  it('multipart 同样要求同源，缺少 Content-Length 的超大流仍被拒绝', async () => {
    const { cookie } = await session();
    const crossSite = upload(cookie);
    crossSite.headers.set('Origin', 'https://evil.example');
    expect((await call(submit, crossSite)).status).toBe(403);
    const huge = upload(cookie, [new Blob([new Uint8Array(2 * 1024 * 1024)], { type: 'image/png' })]);
    expect(huge.headers.has('Content-Length')).toBe(false);
    expect((await call(submit, huge)).status).toBe(413);
    expect(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM feedback').get().n).toBe(0);
  });

  it('附件写入失败会回滚正文，文本提交继续兼容', async () => {
    const { cookie } = await session();
    env.DB.raw.exec("CREATE TRIGGER fail_image BEFORE INSERT ON feedback_screenshots BEGIN SELECT RAISE(ABORT, 'storage failure'); END");
    await expect(call(submit, upload(cookie))).rejects.toThrow('storage failure');
    expect(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM feedback').get().n).toBe(0);
    expect((await call(submit, upload(cookie, []))).status).toBe(201);
    expect((await call(submit, post(valid, cookie))).status).toBe(201);
  });

  it('注销账号清除截图，同时保留其他账号的截图', async () => {
    const a = await session();
    const b = await session('b');
    const { feedback } = await (await call(submit, upload(a.cookie))).json();
    await call(submit, upload(b.cookie));
    await call(deleteMe, new Request(`${ORIGIN}/api/me`, { method: 'DELETE', headers: { Origin: ORIGIN, Cookie: a.cookie } }));
    expect(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM feedback_screenshots').get().n).toBe(1);
    expect((await readImage(feedback.screenshots[0].id, b.cookie)).status).toBe(404);
  });
});

describe('管理员登录提醒', () => {
  it('仅管理员得到新反馈数量，处理后减少，普通用户不暴露管理数据', async () => {
    const owner = await session();
    const admin = await session('admin');
    env.DB.raw.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin.user.id);
    const { feedback } = await (await call(submit, post(valid, owner.cookie))).json();
    await call(submit, post(valid, owner.cookie));
    const before = await (await call(me, get(admin.cookie))).json();
    expect(before.user.adminFeedback.count).toBe(2);
    expect(before.user.adminFeedback.latestId).toBeTruthy();
    const ordinary = await (await call(me, get(owner.cookie))).json();
    expect(ordinary.user).not.toHaveProperty('adminFeedback');
    env.DB.raw.prepare("UPDATE feedback SET status = 'triaged' WHERE id = ?").run(feedback.id);
    expect((await (await call(me, get(admin.cookie))).json()).user.adminFeedback.count).toBe(1);
    env.DB.raw.prepare("UPDATE feedback SET status = 'closed'").run();
    expect((await (await call(me, get(admin.cookie))).json()).user.adminFeedback).toEqual({ count: 0, latestId: null });
    expect((await call(me, get(''))).status).toBe(401);
  });
});
