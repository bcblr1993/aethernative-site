// 浏览器端的登录状态（导航账号菜单和反馈页共用）。
// 同一页面内只请求一次 /api/me；退出或注销后通过 an:signed-out 事件通知其他组件。

export interface Me {
  id: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  providers: string[];
  adminFeedback?: { count: number; latestId: string | null };
}

/** 浏览器带着“可能已登录”标记时才值得请求 /api/me；没登录过的访客不产生接口请求。 */
export const maybeSignedIn = () => document.cookie.split(/;\s*/).includes('an_signed_in=1');

let current: Promise<Me | null> | null = null;
let generation = 0;
let signedOut = false;

export function getMe(refresh = false): Promise<Me | null> {
  if (!maybeSignedIn()) {
    if (current) markSignedOut();
    return Promise.resolve(null);
  }
  if (refresh) current = null;
  if (current) return current;
  const requestGeneration = ++generation;
  current = fetch('/api/me', { credentials: 'same-origin' })
    .then(async (r) => {
      if (requestGeneration !== generation) return null;
      if (r.status === 401) { markSignedOut(); return null; }
      if (!r.ok) throw new Error('session_unavailable');
      const d = await r.json();
      if (requestGeneration !== generation) return null;
      signedOut = false;
      return d?.user ?? null;
    })
    .catch(() => {
      // 网络故障允许重试，且不能覆盖退出后或较新请求的状态。
      if (requestGeneration === generation) current = null;
      return null;
    });
  return current;
}

const EVENT = 'an:signed-out';

/** 退出、注销，或接口返回 401 时调用。 */
export function markSignedOut() {
  generation++;
  current = Promise.resolve(null);
  document.cookie = 'an_signed_in=; Max-Age=0; Path=/; SameSite=Lax';
  if (!signedOut) document.dispatchEvent(new Event(EVENT));
  signedOut = true;
}

export const onSignedOut = (fn: () => void) => document.addEventListener(EVENT, fn);

/** 登录链接：登录完成后回到当前页面（含查询参数）。 */
export const loginHref = (provider: string) =>
  `/api/auth/${provider}/login?next=${encodeURIComponent(location.pathname + location.search)}`;
