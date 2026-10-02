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
