# Aether Native 官网（aethernative.com）

用 [Astro](https://astro.build) 生成的纯静态网站，中英双语，部署在 Cloudflare Pages。

```bash
npm install
npm run dev      # 本地开发：http://localhost:4321
npm run build    # 构建到 dist/，并自动检查文件大小与站内链接
npm run preview  # 预览构建结果
npm run check    # TypeScript / 模板类型检查
npm test         # 单元测试（appcast 生成逻辑）
```

## 目录结构

```
src/
├─ content/apps/<软件id>/     ← 日常维护只需要改这里
│  ├─ app.yaml               软件介绍：首页卡片 + 详情页各区块
│  ├─ releases.yaml          版本记录（最新的写在最上面）
│  ├─ docs/*.yaml            文档页：privacy / license / support ……
│  └─ media/                 图标、截图（构建时自动压缩为 WebP）
├─ content.config.ts         以上文件的字段校验规则
├─ lib/                      多语言文案（i18n.ts）、数据读取（apps.ts）
├─ layouts/ components/      页面框架与组件
└─ pages/[...lang]/          页面模板；中文在根路径，英文在 /en/
public/                      favicon、分享图 og.png、robots.txt
scripts/check-dist.mjs       构建后检查
```

生成的网址：

| 页面 | 地址 |
|---|---|
| 首页 | `/`、`/en/` |
| 软件详情 | `/apps/<id>/` |
| 版本记录 / 单个版本 | `/apps/<id>/releases/`、`/apps/<id>/releases/<版本号>/` |
| 文档 | `/apps/<id>/privacy/`、`/license/`、`/support/`（docs 目录里有哪个文件就生成哪个页面） |
| 关于 / 支持 / 网站隐私 | `/about/`、`/support/`、`/privacy/` |

## 常见操作

### 发布新版本

在 `src/content/apps/<id>/releases.yaml` 的 `releases:` 下面**最上方**加一条：

```yaml
  - version: "1.0.28"
    build: "2026100101"
    date: 2026-10-01
    channel: stable            # stable / beta / preview
    download: "https://github.com/bcblr1993/AetherRoute/releases/download/v1.0.28/AetherRoute-1.0.28-arm64.dmg"
    github: "https://github.com/bcblr1993/AetherRoute/releases/tag/v1.0.28"
    sha256: "64 位小写十六进制"
    summary:
      zh: "一句话说明"
      en: "One-line summary"
    notes:                     # 可选：详情页的分段说明
      - title: { zh: 修复, en: Fixes }
        items:
          - { zh: ..., en: ... }
```

首页的下载按钮、"最近更新"和详情页的版本信息都会自动更新。**第一条带下载地址的 stable 记录**会被当作最新版本。

### 自动更新（Sparkle appcast）

每个 Mac 软件都有一个自动生成的更新清单：

```
https://aethernative.com/apps/<id>/appcast.xml
```

把软件 `Info.plist` 里的 `SUFeedURL` 设成这个地址即可。版本要出现在清单里，需要在 `releases.yaml` 对应版本下加上 `sparkle`（数据来自打包后运行的 `sign_update`）：

```yaml
    sparkle:
      edSignature: "sign_update 输出的 sparkle:edSignature"
      length: 24639275          # sign_update 输出的 length（安装包字节数）
      minimumSystemVersion: "15.0"   # 可选；不写则用 app.yaml 里的 minimumSystemVersion
```

规则：
- 只收录填了 `sparkle` 的版本（没签名的版本 Sparkle 会拒绝安装，所以不会放进去）；
- `channel: beta` 的版本带 `<sparkle:channel>beta</sparkle:channel>`，只推送给开启了测试版更新的用户；`preview` 不收录；
- 更新说明默认中文，另附英文（Sparkle 按系统语言显示），并链接到网站上的完整版本说明；
- 签名格式、`build` 缺失等错误会在构建时直接报出来。

### 安装包放在哪里

- **大于 25 MB**（DMG 基本都是）：放 **GitHub Releases**，`download` 填完整链接。Cloudflare Pages 单个文件上限是 25 MiB。
- **小文件**：可以放到 `public/downloads/`，`download` 写 `/downloads/文件名`。
- 如果不小心把超过 25 MiB 的文件放进了网站，`npm run build` 会报错并停止。

### 新增一款软件

1. 复制 `src/content/apps/aetherroute/` 目录，改名为新软件的 id（这个名字会出现在网址中，比如 `/apps/<id>/`，建议用全小写英文）。
2. 修改 `app.yaml`。必填字段只有 `name`、`icon`、`tagline`、`summary`、`platforms`、`hero`，其他区块（`ios`、`sync`、`protocols`、`features`、`benchmarks`、`faq`……）写了才会显示，不需要的整段删掉即可。
3. 替换 `media/` 里的图片，清空 `releases.yaml` 里的版本记录，按需修改 `docs/`。
4. 运行 `npm run build`。字段写错或漏填时，构建会直接指出是哪个文件的哪一项。

用 `order` 控制首页排序，`featured: true` 会让它显示为横跨整行的大卡片。只支持 iPhone 的软件，在 `platforms` 里只写 `ios`，有 App Store 链接就填 `appStore`。

### 双语写法

```yaml
title: { zh: 中文, en: English }   # 需要翻译
name: AetherRoute                  # 专有名词可以直接写字符串
lead: { zh: "第一行\n第二行", en: "Line one\nLine two" }   # \n 显示为换行
```

界面上固定的文字（导航、按钮等）在 `src/lib/i18n.ts` 里修改。

## 部署到 Cloudflare Pages

1. 把 `site/` 推送到一个 GitHub 仓库。
2. Cloudflare 后台 → Workers & Pages → Create → Pages → 连接这个仓库：
   - Framework preset：**Astro**
   - Build command：`npm run build`
   - Build output directory：`dist`
   - Root directory：如果 `site/` 是仓库的子目录，填 `site`
   - Environment variable：`NODE_VERSION = 22`（Astro 7 需要 Node 22.12 或更高版本）
3. 部署成功后进入 **Custom domains**，添加 `aethernative.com` 和 `www.aethernative.com`。域名就在 Cloudflare，DNS 和 HTTPS 证书会自动配置。
4. 设置 www 跳转：Rules → Redirect Rules，把 `www.aethernative.com/*` 301 跳转到 `https://aethernative.com/${1}`。

之后每次推送到 GitHub，网站都会自动重新部署。

## 以后迁移旧站 aetherroute.pages.dev 的注意事项

旧站的内容（介绍、29 个版本、隐私、许可、帮助）已经全部迁移到这里，但**旧站现在不要动**：

- AetherRoute 的 Sparkle 自动更新读取的是 `https://aetherroute.pages.dev/appcast.xml`。已经安装的用户只认这个地址，旧站一旦下线或跳转错误，他们就收不到更新。
- 迁移时的安全做法：
  1. 旧站只保留 `appcast.xml`，以后每次发版仍然更新这个文件（或者在新版 App 里把更新地址改成新域名，等大部分用户升级之后再处理旧地址）。
  2. 在旧站加一个 `_redirects` 文件，把其余页面 301 跳转到新站，例如：
     ```
     /releases/:v/        https://aethernative.com/apps/aetherroute/releases/:v/   301
     /releases/           https://aethernative.com/apps/aetherroute/releases/      301
     /privacy/            https://aethernative.com/apps/aetherroute/privacy/       301
     /license/            https://aethernative.com/apps/aetherroute/license/       301
     /support/            https://aethernative.com/apps/aetherroute/support/       301
     /                    https://aethernative.com/apps/aetherroute/               301
     ```
     这些规则都不匹配 `/appcast.xml`，它会继续由旧站正常提供。改完后用 `curl -I https://aetherroute.pages.dev/appcast.xml` 确认返回的是 200，而不是 301。
- App 内如果有指向旧站的链接（帮助、隐私政策等），下个版本改成新地址。
