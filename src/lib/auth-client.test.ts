import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let doc: EventTarget & { cookie: string };
beforeEach(() => {
  vi.resetModules();
  doc = Object.assign(new EventTarget(), { cookie: 'an_signed_in=1' });
  vi.stubGlobal('document', doc);
});
afterEach(() => vi.unstubAllGlobals());
const me = { id: 'admin', name: 'Admin', providers: ['github'], email: null, avatarUrl: null };

describe('浏览器会话状态', () => {
  it('辅助标记缺失仍向服务器确认 HttpOnly 会话', async () => {
    doc.cookie = '';
    const fetch = vi.fn().mockResolvedValue(Response.json({ user: me }));
    vi.stubGlobal('fetch', fetch);
    const { getMe } = await import('./auth-client');
    expect(await getMe()).toEqual(me);
    expect(fetch).toHaveBeenCalledWith('/api/me', { credentials: 'same-origin', cache: 'no-store' });
  });
  it('只接受已知的上次成功登录方式', async () => {
    const { lastLoginProvider } = await import('./auth-client');
    for (const [cookie, expected] of [['', null], ['an_last_login=github', 'github'], ['an_last_login=google', 'google'], ['an_last_login=forged', null]] as const) {
      doc.cookie = cookie; expect(lastLoginProvider()).toBe(expected);
    }
  });
  it('共享请求，网络错误后允许重试', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(Response.json({ user: me }));
    vi.stubGlobal('fetch', fetch);
    const { getMe } = await import('./auth-client');
    const a = getMe();
    expect(getMe()).toBe(a);
    expect(await a).toBeNull();
    expect(await getMe()).toEqual(me);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('退出后，较晚返回的用户数据不能恢复登录状态', async () => {
    let finish!: (r: Response) => void;
    vi.stubGlobal('fetch', () => new Promise<Response>((r) => { finish = r; }));
    const { getMe, markSignedOut, onSignedOut } = await import('./auth-client');
    const signedOut = vi.fn(); onSignedOut(signedOut);
    const pending = getMe();
    markSignedOut();
    finish(Response.json({ user: me }));
    expect(await pending).toBeNull();
    expect(await getMe()).toBeNull();
    expect(signedOut).toHaveBeenCalledTimes(1);
  });
  it('401 清理所有组件并取消登录提示 cookie，临时服务器故障不退出', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response('', { status: 401 })));
    const { getMe, onSignedOut } = await import('./auth-client');
    const signedOut = vi.fn(); onSignedOut(signedOut);
    expect(await getMe()).toBeNull(); expect(signedOut).not.toHaveBeenCalled();
    expect(await getMe()).toBeNull(); expect(signedOut).toHaveBeenCalledTimes(1);
    expect(doc.cookie).toContain('Max-Age=0');
  });
  it('其他标签页退出后，刷新会清理当前页面；旧请求不能覆盖新请求', async () => {
    let finish!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise<Response>((r) => { finish = r; })).mockResolvedValueOnce(Response.json({ user: me })).mockResolvedValueOnce(new Response('', { status: 401 })));
    const { getMe, onSignedOut } = await import('./auth-client');
    const signedOut = vi.fn(); onSignedOut(signedOut);
    const old = getMe(); expect(await getMe(true)).toEqual(me);
    finish(Response.json({ user: { ...me, id: 'stale' } })); expect(await old).toBeNull();
    doc.cookie = ''; expect(await getMe(true)).toBeNull(); expect(signedOut).toHaveBeenCalledTimes(1);
  });
});
