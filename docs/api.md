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
