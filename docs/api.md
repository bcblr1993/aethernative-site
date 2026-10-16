# App 数据接口（契约）

iPhone App 与推送服务读取的静态 JSON，由 `npm run build` 根据内容目录生成，生成逻辑在 `src/lib/feed.ts`。
所有文件都走 Cloudflare CDN，支持 `ETag` / `If-None-Match`（未变化时返回 304）。

**兼容规则**：顶层 `version` 目前为 `1`。只新增字段不改版本号，客户端必须忽略不认识的字段和枚举值；
删除字段、改变字段含义时把 `version` 加 1，客户端遇到不支持的版本时提示用户升级。

## 通用约定

| 类型 | 说明 |
|---|---|
| `Bi` | `{ "zh": string, "en": string }`。专有名词两种语言相同。客户端按系统语言选择，非中文一律用 `en` |
| 时间 | ISO 8601 UTC，例如 `2026-09-27T00:00:00.000Z`。只写了日期的内容为当天 00:00 UTC |
| 链接 | 绝对地址。站内页面以 `Bi` 给出（中文在根路径，英文加 `/en`） |

## `GET /feed.json` — 官方动态

公告和各软件版本合并，按时间倒序，最多 50 条。同一天里公告排在版本前面，同一天的多个版本按构建号倒序。技术预览（`preview`）不包含在内。

```jsonc
{
  "version": 1,
  "items": [
    {
      "id": "news:2026-10-02-iphone-app",   // 永久不变；推送服务用来去重
      "kind": "news",                       // news | release
      "date": "2026-10-02T00:00:00.000Z",
      "title": Bi, "summary": Bi, "url": Bi,
      "appIds": ["aetherroute"],            // 关联的软件，可以为空
      "pinned": false,                      // 置顶：客户端排在最前
      "push": true,                         // 是否应该推送
      // kind = news
      "body": [Bi],                         // 段落，\n 为换行
      "links": [{ "label": Bi, "url": Bi }],
      // kind = release
      "release": {
        "appId": "aetherroute", "version": "1.0.31", "build": "2026092702",
        "channel": "stable",                // stable | beta
        "platform": "mac",                  // mac | ios
        "badge": Bi                         // 可选
      }
    }
  ]
}
```

- `id` 的格式：`news:<文件名>`、`release:<软件 id>:<版本号>`。
- 版本的更新说明不放在 feed 里，详情页从 `/apps/<id>/app.json` 读取，用相同的 `id` 匹配。
- `summary` 可能和 `title` 相同（同步时 Release 正文没有写简介），相同时客户端不重复显示。

## `GET /apps.json` — 软件列表

```jsonc
{
  "version": 1,
  "apps": [AppSummary]                       // 按 order 排序
}
```

`AppSummary`：

```jsonc
{
  "id": "aetherroute", "name": "AetherRoute", "order": 1, "featured": true,
  "icon": "https://aethernative.com/_astro/….png",   // 256×256 PNG，文件名带内容哈希
  "tagline": Bi, "summary": Bi, "url": Bi,
  "platforms": [{ "id": "mac", "status": "available", "requirement": Bi, "appStore": "…?", "testFlight": "…?" }],
  // status: available | beta | coming | dev
  "latest": { "version": "1.0.31", "date": "…", "url": Bi }   // 最新正式版，没有时省略
}
```

## `GET /apps/<id>/app.json` — 软件详情

```jsonc
{
  "version": 1,
  "app": AppSummary,
  "releases": [{                             // 全部版本，最新的在前，包括 beta 和 preview
    "id": "release:aetherroute:1.0.31",
    "version": "1.0.31", "build": "2026092702", "date": "…",
    "channel": "stable", "platform": "mac", "badge": Bi,
    "summary": Bi,
    "notes": [{ "title": Bi, "items": [Bi] }],
    "download": "https://…?", "github": "https://…?", "sha256": "…?",
    "url": Bi
  }],
  "docs": [{ "id": "privacy", "title": Bi, "url": Bi }]   // 隐私政策、许可协议、使用帮助……
}
```

---

# 推送设备接口（iPhone App 调用）

不需要登录、不使用 Cookie。设备以 **安装 ID**（App 首次运行时生成的 UUID）标识，所有请求带 `Authorization: Bearer <设备密钥>`
（32 字节随机数，base64url 或十六进制，与安装 ID 一起存在 Keychain）。服务器只保存密钥的 SHA-256。

## `PUT /api/devices/<安装 ID>` — 注册或更新

首次请求即注册（201），之后需要相同的设备密钥（200，密钥不符 403）。App 在拿到新 token、启动、修改订阅、通知权限变化时调用。

```jsonc
{
  "token": "…",                 // APNs device token，十六进制
  "env": "production",          // production | sandbox（Xcode 调试包）
  "locale": "zh",               // zh | en，决定通知文案语言
  "enabled": true,              // 系统通知权限是否开启；false 时不推送但保留订阅
  "appVersion": "0.1.0 (1)",    // 可选
  "subscriptions": {
    "news": true,               // 官方公告
    "allApps": true,            // 全部软件的正式版（含以后新上线的）
    "apps": ["aetherroute"],    // allApps 为 false 时接收这些软件的正式版
    "beta": ["notchquota"]      // 接收这些软件的测试版（与上两项独立）
  }
}
```

响应：`{ "subscriptions": { … } }`（服务器规范化后的订阅：去重排序，allApps 时 apps 为空）。
错误：`400 { "error": "invalid", "fields": [...] }`、`401`（缺少或格式错误的密钥）、`403`（密钥不符）、`404`（安装 ID 不是 UUID）、`413`、`415`。

- 同一 token 出现在新的安装 ID 下（重装 App）时，旧记录被删除。
- 180 天没有任何请求的设备会被清理。

## `DELETE /api/devices/<安装 ID>` — 注销

204（已不存在也返回 204）；密钥不符 403。

# 推送服务接口（push-service 调用）

`Authorization: Bearer <PUSH_SERVICE_TOKEN>`。网站未配置该令牌时一律 503。

## `GET /api/admin/push-targets`

| 参数 | 说明 |
|---|---|
| `kind=news` | 订阅了公告的设备 |
| `kind=release&app=<id>&channel=stable` | 订阅了全部软件、或单独订阅了该软件正式版的设备 |
| `kind=release&app=<id>&channel=beta` | 单独开启了该软件测试版的设备 |
| `cursor` | 上一页返回的 `next` |

只返回 `enabled` 的设备，每页 500 条：`{ "targets": [{ "token", "env", "locale" }], "next": "…" | null }`。

## `POST /api/admin/push-report`

`{ "invalidTokens": ["…"], "status": { …本轮统计… } }` → 删除这些 token 对应的设备（APNs 判定失效），记录心跳到 `push_status`。
响应：`{ "removed": n, "ignored": n }`。

---

# App 登录与账号（iPhone App 调用）

登录成功后得到 App 令牌，之后的请求带 `Authorization: Bearer <令牌>`。令牌 90 天有效，剩余不足 30 天时使用即自动续期；
网页 Cookie 会话与 App 令牌互不通用。带 Bearer 的请求不受 CSRF 影响，不要求 `Origin`。

登录成功的响应（三种方式相同）：

```jsonc
{ "token": "…", "expiresAt": 1790000000000, "user": { "id", "name", "email", "avatarUrl", "providers": ["apple"] } }
```

## `POST /api/auth/apple` — 用 Apple 登录

```jsonc
{
  "identityToken": "…",        // ASAuthorizationAppleIDCredential.identityToken
  "authorizationCode": "…",    // .authorizationCode（服务器换取 refresh token，注销时撤销授权）
  "nonce": "…",                // 原始随机数；发起登录时交给 Apple 的是它的 SHA-256（十六进制）
  "name": { "givenName": "…", "familyName": "…" }   // 可选，Apple 只在首次授权时提供
}
```

错误：`400`、`401 invalid_token`、`502 apple_exchange_failed`、`503 apple_not_configured`。

## Google / GitHub（ASWebAuthenticationSession）

1. App 生成 PKCE verifier（43–128 字符）与 challenge（`base64url(SHA256(verifier))`），打开
   `/api/auth/<google|github>/login?app=1&challenge=<challenge>`；
2. 授权完成后网站跳转到 `aethernative://auth/callback?code=<一次性 code>`（取消：`?error=cancelled`，失败：`?error=failed`）；
3. `POST /api/auth/app/exchange` `{ "code", "verifier" }` → 登录成功响应。code 2 分钟内有效，只能使用一次。

## 账号

| 接口 | 说明 |
|---|---|
| `GET /api/me` | 当前用户 |
| `PATCH /api/me` | `{ "name" }` 修改昵称（1–40 个字符）；之后再登录不再用平台提供的名字覆盖 |
| `DELETE /api/me` | 注销账号：撤销 Apple 授权、解除设备关联、删除账号与全部反馈 |
| `POST /api/auth/logout` | 删除当前会话；可带 `{ "deviceId", "deviceSecret" }` 同时解除这台设备与账号的关联 |
| `POST /api/me/devices` | `{ "deviceId", "deviceSecret" }` 把推送设备关联到账号（用于“反馈有新回复”推送）。设备密钥错误 403，设备未注册 404 |
| `POST /api/feedback`、`GET /api/feedback/mine` | 提交 / 查看反馈，同网页 |

### 反馈截图与管理提醒

`POST /api/feedback` 继续接受原有 JSON（纯文字反馈），也接受 `multipart/form-data`：文本字段与 JSON 相同，可重复附加 `screenshots` 文件字段，最多 3 张。接口接受 PNG、JPEG、WebP，每张最多 512 KiB，并核对文件签名。网页可选每张不超过 10 MiB 的原图，先在本地压缩、去掉原始元数据，再提交；失败时保留表单和截图供重试。

提交结果、“我的反馈”和管理列表增加 `screenshots: [{ id, url }]`，旧反馈返回空数组。`GET /api/feedback/screenshots/:id` 仅允许提交者或管理员使用 Cookie / App Bearer 读取，未登录返回 401，无权限或图片不存在返回 404；响应禁止缓存。图片与正文在 D1 同一事务中保存，注销账号时一起清理。当前以小型附件保存于 D1，反馈量增长时需关注容量，后续可迁移到私有对象存储。

部署前需应用 `migrations/0008_feedback_screenshots.sql`（仅增加列和表，无已有内容回填）。不需要新增存储绑定或生产依赖。

管理员的 `GET /api/me` 响应中，`user.adminFeedback` 包含 `{ count, latestId }`，统计 `status = 'new'` 的待处理反馈；普通用户不返回此字段。网站登录后显示提醒卡片、账号角标和管理入口。同一浏览器标签页的会话中，相同待处理集合的提醒只出现一次，退出登录后重置；回到窗口或处理反馈后更新数量，不做后台轮询。“查看反馈”直达 `/admin/feedback/?status=new`。

---

# 管理后台（管理员账号，`users.is_admin = 1`）

统一导航：`/admin/users/` 用户管理、`/admin/feedback/` 反馈管理、`/admin/apps/` 软件与仓库、`/admin/downloads/` 下载统计。

用户管理需先应用 `migrations/0009_user_management.sql`。新增 `users.disabled_at`，现有账号默认正常。管理员账号及当前账号不能被禁用或强制退出；本界面不修改管理员权限，也不删除用户。

| 接口 | 说明 |
|---|---|
| `GET /api/admin/users?q=&status=&cursor=` | 昵称、邮箱或精确用户 ID 搜索；`status` 为 `active` / `disabled` / `admin` 或空。每页 50 人，`next` 作为下一页 `cursor`；返回账号资料、登录来源/时间、有效会话数、反馈数和账号总览，不返回身份凭据 |
| `PATCH /api/admin/users/:id` | `{ "action": "disable" / "enable" / "revoke_sessions" }`。禁用/恢复账号或清除全部网页与 App 会话及待兑换登录 code；保留反馈。恢复后须重新登录。普通用户 403，受保护管理员 409 |

禁用账号无法使用现有 Cookie / Bearer，OAuth 重新登录失败，App 登录返回 `account_disabled`。所有管理写操作要求同源 Cookie 或管理员 App Bearer。用户列表与图片等私有数据均不缓存。

软件仓库以 `src/content/apps/<id>/app.yaml` 的 `repo` 为唯一配置，构建时要求有效 GitHub 仓库根地址。反馈页随软件选择切换仓库/Issues；后台可按用户与软件组合筛选反馈。`/apps.json` 与 `/apps/:id/app.json` 的软件信息新增可选 `repo`、`issues` 字段，保持现有版本号与其余字段兼容。

页面：`/admin/feedback/`（不进入站点地图、不被搜索引擎收录）。写操作要求同源 Cookie 或 Bearer。

| 接口 | 说明 |
|---|---|
| `GET /api/admin/feedback?status=&before=&beforeId=&user=&app=` | 全部反馈（最新在前，每页 100 条），含提交者 ID、昵称与邮箱；可按用户 ID / 软件 ID 筛选；下一页同时传入返回的 `next` 与 `nextId`，分别作为 `before`、`beforeId`，避免同毫秒反馈遗漏。两者为 null 时已到末页；兼容仅传旧 `before` 的调用方 |
| `PATCH /api/admin/feedback/:id` | `{ "status"?, "reply"? }`。回复内容有变化且未指定状态时自动设为 `replied`；提交者有关联设备时排一条推送。响应 `{ feedback, notified }` |

# 待发推送队列（push-service 调用，`PUSH_SERVICE_TOKEN`）

| 接口 | 说明 |
|---|---|
| `POST /api/admin/push-outbox/claim` | 领取最多 50 个任务：`{ jobs: [{ id, kind, route: { kind: "feedback", id }, alert: { zh: { title, body }, en: … }, targets: [{ token, env, locale }] }] }`。领取后 5 分钟内未确认会被重新领取，最多尝试 5 次 |
| `POST /api/admin/push-outbox/ack` | `{ ids: [...], invalidTokens?: [...] }` 确认已发送并删除失效 token |

通知的 `route` 为 `{ "kind": "feedback", "id": "<反馈 id>" }` 时，App 打开“我的反馈”中的对应详情。

## 软件互动（2026-10-16）

- `GET /api/community`：所有软件的 `{appId, likes, ratings, average}` 聚合，无身份字段。
- `GET /api/community/:app`：已审核评论（每页 20 条）、summary、当前浏览器 mine；首次设置 `__Host-community` Secure/HttpOnly/SameSite=Lax Cookie，365 天。空评分的 average 为 null。
- `POST /api/community/:app`：必须同源 JSON，先 GET 建立浏览器身份。`{action:"like",liked:boolean}` 设置点赞，`{action:"rate",rating:1..5|null}` 设置/撤回评分，`{action:"comment",body,requestId}` 提交最长 1000 字的评论。requestId 为随机 UUID，重试使用原 UUID；重用 UUID 改正文/软件返回 409。评论默认 pending。
- 列表使用不透明 `next`，下一页传 `?cursor=...`。公开接口仅返回 approved，正文必须按纯文本渲染。
- `GET /api/admin/comments?status=pending|approved|hidden&app=...&cursor=...`：管理员评论队列和 pending 数量。
- `PATCH /api/admin/comments/:id`：管理员同源 JSON `{status:"approved"|"hidden"|"pending"}`。隐藏可恢复。所有互动和管理响应均 no-store。
- 管理员 `/api/me` 额外返回 `adminComments: {count,latestId}`，账号角标和提醒合并反馈/待审评论，普通用户不获得该信息。

匿名身份独立于账号；清理 Cookie 或换浏览器可以产生新身份，所以统计是浏览器参与量，不保证真实独立人数。服务器只存凭证哈希，IP 仅以服务端随机盐及时间窗口哈希进入短期限流表。每浏览器评论最多 3 条/小时，每网络 10 条/小时；点赞/评分写入分别限制 30/60 次/分钟。固定窗口计数采用原子 UPSERT，跨软件共用。无验证码，仍需关注分布式刷票。

上线先应用 `0010_app_community.sql`，只新增表和索引，不修改既有账号/反馈数据；再部署代码。不需新增密钥、绑定或依赖。回滚网站到上一部署即可停用入口和接口，新表应保留以免丢失已收集的互动。
