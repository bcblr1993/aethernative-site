# 软件信息核对 · 2026-10-16

范围：官网当前收录的 11 款软件，中文与英文应用页、首页摘要、相关帮助和隐私说明。依据各项目 GitHub 发布记录与 README 核对；不把仓库主分支、草稿或组件包当作公开应用版本。

| 软件 | 核对的公开版本/状态 | 本轮更新 | 来源 |
| --- | --- | --- | --- |
| AetherRoute | 1.8.1 | LAN 共享、SOCKS5 IPv6、41 款菜单栏图标及连接帮助 | [Release](https://github.com/bcblr1993/AetherRoute/releases/tag/v1.8.1) |
| AetherNotchQuota | 0.1.28 | 三位伙伴、可选互动；撤下不再适用的旧伙伴展示，保留标注版本的额度界面图；补双语更新说明 | [Release](https://github.com/bcblr1993/AetherNotchQuota/releases/tag/v0.1.28) |
| AetherTerm | 1.9.0 | 密钥保险库、Linux 进程/systemd 状态、会话日志、隧道、命令面板和分屏快捷键；补帮助、隐私和双语更新说明 | [Release](https://github.com/bcblr1993/ApexTerm/releases/tag/v1.9.0) |
| AetherSwitch | 1.9.0 | 六类详情、接口选择、采样与历史范围，移除旧的 15 MB 通用内存描述 | [Release](https://github.com/bcblr1993/AetherSwitch/releases/tag/v1.9.0) |
| AetherNote | 0.1.5 | 编辑时晾衣绳让位、稳定日期窗口、中英日界面 | [Release](https://github.com/bcblr1993/AetherNote/releases/tag/v0.1.5) |
| Antigravity Multiplexer | 0.8.3 | 自动续跑、轮数与人工介入暂停、命令面板、批量操作、标签和菜单栏看板；补帮助、数据处理说明和双语更新记录 | [Release](https://github.com/bcblr1993/aether-antigravity-multiplexer/releases/tag/v0.8.3) / [0.8.2](https://github.com/bcblr1993/aether-antigravity-multiplexer/releases/tag/v0.8.2) |
| AetherGuard | 开发中；v0.2.0 为无附件的 BLE 里程碑 | 明确没有公开安装包/TestFlight 邀请，去掉“1.0 全部完成”表述，安装帮助改为开发说明 | [Release](https://github.com/chenpingan529/NearGuard/releases/tag/v0.2.0) |
| AetherScreens | 1.1.0 | Mac 应用内更新与 1.0.0 手动迁移说明，明确移动端开发安装状态 | [Release](https://github.com/bcblr1993/AetherScreens/releases/tag/v1.1.0) |
| AetherFilm | 0.1.0 | 明确 0.1.1 尚未公开，区分媒体组件与应用安装包 | [Release](https://github.com/bcblr1993/AetherFilm/releases/tag/v0.1.0) |
| AetherZip | 1.0.1 | 新版侧栏、任务记录 50 条上限与清理，修正首版/Beta 文案 | [Release](https://github.com/bcblr1993/AetherZip/releases/tag/v1.0.1) |
| AetherTransfer | 开发中，无 Release | 明确候选范围，新增中英文帮助页和获取方式 | [Repository](https://github.com/bcblr1993/AetherTransfer) |

同时修复 54 处双语 YAML 对象：未加引号的英文逗号曾被解析为额外键，导致页面静默丢失后半句。双语 schema 改为 strictObject，类似错误以后会阻止构建。

## 验证

- `npm run check`：64 个 Astro 文件零错误/警告/提示；Functions 与推送服务 TypeScript 通过。
- `npm run build`：218 项测试通过；507 个页面、16743 个站内链接、645 个 API 本站地址、3 个签名更新清单通过检查。
- 9 款可下载应用的最新版本、安装包地址和 SHA-256 与 GitHub 发布附件 digest 一致。未改动安装包、版本号、签名或签名清单。
- 真实浏览器检查 11 个中文桌面页、11 个英文手机页和 22 个中英文帮助页：每页一个主标题，无页面横向溢出。已加载有源图片无失败；未登录头像是无 src 的隐藏占位，不作为图片失败。
- 桌面和手机截图保存在本机 `/tmp/aethernative-catalog-20261016/`，并检查了页面截图。手机为响应式视口，不是真机验收。

## 边界与回滚

本轮核对官网资料和发布元数据，没有重新验收全部原生客户端功能。现有真实截图保留原有来源；未生成或伪造新版界面。额度助手移除不适用的旧伙伴图，其保留的额度界面标注为 0.1.24。

内容和 schema 均在同一提交，可通过反向提交回滚；没有数据库迁移或生产用户数据修改。工作区原有未跟踪的 `aetherscreens/media/icon-v1.png` 不包含在提交中。
