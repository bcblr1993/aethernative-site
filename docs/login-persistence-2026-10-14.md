# 网页登录保持与上次登录方式 · 2026-10-14

## 已确认的问题

- 浏览器代码把 `an_signed_in` 缺失直接视为未登录，甚至不会向 `/api/me` 验证仍可能有效的 HttpOnly 会话。
- 网页会话固定 30 天到期，没有续期；App 会话已有单独的续期规则。
- 生产 `www.aethernative.com/feedback/` 直接返回 200，而 OAuth 登录和 `__Host-sid` Cookie 落在 `aethernative.com`。两种入口的登录状态不同。未取得用户浏览器的 Cookie，不能断言其每次退出只有一个原因。

## 修改

- 页面共享一次无缓存 `/api/me` 请求，以服务器鉴权结果为准。临时网络失败不会清理会话；重新聚焦或展开登录入口时允许重试。
- 有效网页会话剩余不足 7 天时续期至 30 天，并同步更新数据库及 Secure / HttpOnly / SameSite=Lax Cookie；缺失辅助标记时修复它。过期、禁用、删除或强制退出的会话仍无效。
- 浏览器访问 www 页面时，在页面头部跳到主域名，保留路径、参数和锚点。不改变 Cookie 安全属性或开放子域共享。
- OAuth 成功后记住 Google / GitHub 登录方式，保留 180 天；退出后保留提示，失败/取消不覆盖。只有单一登录身份的旧会话可准确补回提示。
- 导航菜单与反馈页共用“上次使用 / Last used”徽标，隐私说明同步更新。

## 验证

- `npm run check`：零错误、警告、提示；Functions 和推送服务 TypeScript 通过。
- `npm run build`：218 项测试通过，447 页与 14981 个站内链接通过。
- 真实迁移数据库上的认证回归覆盖辅助标记缺失、旧会话补回方式、临近到期续期、未到续期阈值、到期拒绝、退出/禁用、OAuth 失败及跨站请求拒绝；第三方 OAuth API 使用测试响应。
- 浏览器验证 Google / GitHub 徽标、中英文、桌面与 320px 手机布局、深浅色、刷新及关闭标签后重新打开。UI 使用本地仅设置非敏感平台提示 Cookie 的测试入口，未冒充真实 OAuth 登录。
- 本机日志和截图：`/tmp/aethernative-login-20261014/`。

浏览器主动清除 Cookie、无痕窗口或换设备后仍需要重新登录；平台提示仅对当前浏览器有效。

参考：[Cookie 属性](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)、[Cloudflare Pages 重定向支持范围](https://developers.cloudflare.com/pages/configuration/redirects/)。www 跳转使用页面脚本，不宣称是服务端 301。
