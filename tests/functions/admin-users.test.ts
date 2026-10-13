import { beforeEach, describe, expect, it } from 'vitest';
import { createD1 } from './d1';
import { createAppSession, createSession, getSessionUser, getUser, upsertUser } from '../../functions/_lib/session';
import { onRequestGet as list } from '../../functions/api/admin/users/index';
import { onRequestPatch as patch } from '../../functions/api/admin/users/[id]';
import { onRequestGet as feedback } from '../../functions/api/admin/feedback/index';
import { insertFeedback } from '../../functions/_lib/feedback';
import { issueAuthCode, signedInResponse } from '../../functions/_lib/app-auth';

const ORIGIN = 'https://aethernative.com';
let env: ReturnType<typeof setup>;
const setup = () => ({ DB: createD1() });
beforeEach(() => { env = setup(); });
async function user(id: string, admin = false) {
  const u = await upsertUser(env.DB, { provider: 'github', id, name: `用户${id}`, email: `${id}@example.test`, avatarUrl: null });
  if (admin) env.DB.raw.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(u.id);
  const cookie = (await createSession(env.DB, u.id, 'test')).map((c) => c.split(';')[0]).join('; ');
  return { ...u, cookie };
}
const get = (cookie = '', query = '') => list({ request: new Request(`${ORIGIN}/api/admin/users${query}`, { headers: { Cookie: cookie } }), env } as any);
const update = (id: string, cookie: string, body: unknown, origin = ORIGIN) => patch({
  request: new Request(`${ORIGIN}/api/admin/users/${id}`, { method: 'PATCH', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env, params: { id },
} as any);

describe('管理员用户管理', () => {
  it('列表/操作都要求管理员，禁止跨站修改', async () => {
    const ordinary = await user('ordinary');
    const admin = await user('admin', true);
    expect((await get()).status).toBe(401);
    expect((await get(ordinary.cookie)).status).toBe(403);
    expect((await update(ordinary.id, '', { action: 'disable' })).status).toBe(401);
    expect((await update(ordinary.id, ordinary.cookie, { action: 'disable' })).status).toBe(403);
    expect((await update(ordinary.id, admin.cookie, { action: 'disable' }, 'https://evil.test')).status).toBe(403);
  });

  it('返回安全的账号资料、来源、反馈数和会话数，可搜索筛选', async () => {
    const admin = await user('admin', true);
    const a = await user('alice');
    await insertFeedback(env.DB, a.id, { appId: 'general', category: 'other', title: '标题', body: '这是足够长的测试反馈。', appVersion: null, osVersion: null });
    const result = await (await get(admin.cookie, '?q=alice')).json() as any;
    expect(result.total).toBe(1);
    expect(result.users[0]).toMatchObject({ id: a.id, providers: ['github'], feedbackCount: 1, sessions: 1, disabledAt: null });
    expect(Object.keys(result.users[0]).sort()).toEqual(['id', 'name', 'email', 'isAdmin', 'disabledAt', 'createdAt', 'lastLoginAt', 'providers', 'feedbackCount', 'sessions'].sort());
    expect(result.summary).toEqual({ total: 2, admins: 1, disabled: 0 });
    expect((await (await get(admin.cookie, '?status=admin')).json() as any).users.map((u: any) => u.id)).toEqual([admin.id]);
    expect((await (await get(admin.cookie, '?q=%25')).json() as any).total).toBe(0);
    expect((await get(admin.cookie, '?cursor=broken')).status).toBe(400);
    expect((await get(admin.cookie, '?status=invalid')).status).toBe(400);
  });

  it('同一毫秒创建的用户分页不丢失、不重复', async () => {
    const admin = await user('admin', true);
    const stmt = env.DB.raw.prepare('INSERT INTO users (id,name,created_at,last_login_at) VALUES (?, ?, 123, 123)');
    for (let i = 0; i < 55; i++) stmt.run(`same-${i}`, '同一时间');
    const first = await (await get(admin.cookie, '?q=同一时间')).json() as any;
    expect(first.users).toHaveLength(50);
    const second = await (await get(admin.cookie, `?q=同一时间&cursor=${encodeURIComponent(first.next)}`)).json() as any;
    expect(second.users).toHaveLength(5);
    expect(second.next).toBeNull();
    expect(new Set([...first.users, ...second.users].map((u: any) => u.id)).size).toBe(55);
  });

  it('禁用同时撤销网页/App/code；恢复后必须重新登录；保留反馈', async () => {
    const admin = await user('admin', true);
    const target = await user('target');
    const app = await createAppSession(env.DB, target.id, null);
    await issueAuthCode(env.DB, target.id, 'challenge');
    await insertFeedback(env.DB, target.id, { appId: 'general', category: 'other', title: '标题', body: '保留用户的测试反馈内容。', appVersion: null, osVersion: null });
    expect((await update(target.id, admin.cookie, { action: 'disable' })).status).toBe(200);
    expect((await getUser(env.DB, target.id))!.disabled_at).toBeTypeOf('number');
    expect(env.DB.raw.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id = ?').get(target.id)!.n).toBe(0);
    expect(env.DB.raw.prepare('SELECT COUNT(*) n FROM auth_codes WHERE user_id = ?').get(target.id)!.n).toBe(0);
    expect(env.DB.raw.prepare('SELECT COUNT(*) n FROM feedback WHERE user_id = ?').get(target.id)!.n).toBe(1);
    expect(await getSessionUser(env.DB, new Request(ORIGIN, { headers: { Authorization: `Bearer ${app.token}` } }))).toBeNull();
    expect((await signedInResponse(env.DB, (await getUser(env.DB, target.id))!, null)).status).toBe(403);
    // 即便存在一条禁用前并发创建的会话，鉴权仍然拒绝。
    const stray = await createAppSession(env.DB, target.id, null);
    expect(await getSessionUser(env.DB, new Request(ORIGIN, { headers: { Authorization: `Bearer ${stray.token}` } }))).toBeNull();
    expect((await update(target.id, admin.cookie, { action: 'enable' })).status).toBe(200);
    expect((await getUser(env.DB, target.id))!.disabled_at).toBeNull();
    expect(await getSessionUser(env.DB, new Request(ORIGIN, { headers: { Cookie: target.cookie } }))).toBeNull();
    expect(await getSessionUser(env.DB, new Request(ORIGIN, { headers: { Authorization: `Bearer ${stray.token}` } }))).toBeNull();
    expect((await signedInResponse(env.DB, (await getUser(env.DB, target.id))!, null)).status).toBe(200);
  });

  it('强制退出不禁用用户，管理员受保护，不接受角色变更或任意动作', async () => {
    const admin = await user('admin', true);
    const otherAdmin = await user('admin2', true);
    const target = await user('target');
    expect((await update(target.id, admin.cookie, { action: 'revoke_sessions' })).status).toBe(200);
    expect((await getUser(env.DB, target.id))!.disabled_at).toBeNull();
    for (const id of [admin.id, otherAdmin.id]) {
      expect((await update(id, admin.cookie, { action: 'disable' })).status).toBe(409);
      expect((await update(id, admin.cookie, { action: 'revoke_sessions' })).status).toBe(409);
    }
    expect((await update('missing', admin.cookie, { action: 'disable' })).status).toBe(404);
    for (const body of [{ action: 'delete' }, { action: 'enable', isAdmin: true }, null, []]) expect((await update(target.id, admin.cookie, body)).status).toBe(400);
  });

  it('反馈可按用户和软件联动筛选，普通用户仍不可读取', async () => {
    const admin = await user('admin', true);
    const a = await user('alice');
    const b = await user('bob');
    for (const [id, appId] of [[a.id, 'aetherroute'], [a.id, 'aetherterm'], [b.id, 'aetherroute']]) {
      await insertFeedback(env.DB, id, { appId, category: 'bug', title: '标题', body: '测试筛选反馈的足够长正文。', appVersion: null, osVersion: null });
    }
    const request = (cookie: string) => new Request(`${ORIGIN}/api/admin/feedback?user=${a.id}&app=aetherroute`, { headers: { Cookie: cookie } });
    const response = await feedback({ request: request(admin.cookie), env } as any);
    const data = await response.json() as any;
    expect(data.feedback).toHaveLength(1);
    expect(data.feedback[0].user.id).toBe(a.id);
    expect(data.feedback[0].appId).toBe('aetherroute');
    expect((await feedback({ request: request(a.cookie), env } as any)).status).toBe(403);
  });
});
