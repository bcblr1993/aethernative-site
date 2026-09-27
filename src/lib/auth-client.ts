// 浏览器端的登录状态（导航账号菜单和反馈页共用）。
// 同一页面内只请求一次 /api/me；退出或注销后通过 an:signed-out 事件通知其他组件。

export interface Me {
  id: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  providers: string[];
}

/** 浏览器带着“可能已登录”标记时才值得请求 /api/me；没登录过的访客不产生接口请求。 */
export const maybeSignedIn = () => document.cookie.split(/;\s*/).includes('an_signed_in=1');

let current: Promise<Me | null> | null = null;

export function getMe(): Promise<Me | null> {
  if (!maybeSignedIn()) return Promise.resolve(null);
  current ??= fetch('/api/me', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => d?.user ?? null)
    .catch(() => null);
  return current;
}

const EVENT = 'an:signed-out';

/** 退出、注销，或接口返回 401 时调用。 */
export function markSignedOut() {
  current = Promise.resolve(null);
  document.dispatchEvent(new Event(EVENT));
}

export const onSignedOut = (fn: () => void) => document.addEventListener(EVENT, fn);

/** 登录链接：登录完成后回到当前页面（含查询参数）。 */
export const loginHref = (provider: string) =>
  `/api/auth/${provider}/login?next=${encodeURIComponent(location.pathname + location.search)}`;
