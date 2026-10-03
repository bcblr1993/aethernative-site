# 推送服务（push-service）

运行在自有服务器上，负责给 iPhone App 发 APNs 推送。Cloudflare Workers 的出站请求不支持 HTTP/2，无法直连 APNs，所以推送放在这里。

- Node 24 直接运行 TypeScript（类型擦除），**没有第三方依赖，也没有编译步骤**；
- 只有出站连接（APNs、aethernative.com），不需要开放端口；
- `.p8` 密钥只放在服务器上，通过 Docker secrets 挂载，不进镜像和仓库。

## 工作方式

```
每 2 分钟：GET /feed.json（带 ETag，未变化时 304）
  → 选出未推送过、7 天以内、push 为 true 的条目（技术预览不推送）
  → GET /api/admin/push-targets 分页查询订阅了该条目的设备
  → 按设备语言生成中文 / 英文通知，并发发送（默认 20 路）
  → POST /api/admin/push-report 回报失效 token（网站删除对应设备）与心跳
  → 记为已推送（data/state.db）
```

另外每 30 秒（`OUTBOX_INTERVAL_SECONDS`）领取一次待发队列（管理员回复反馈等），发送后确认；
某个任务的全部设备都因整体性原因失败时不确认，5 分钟后由网站重新派发（最多 5 次）。

- **首次启动**只把当前已有的条目记为已推送，不发送——不会把历史内容推给所有人。
- **中途失败**（网站或 APNs 暂时不可用）：已完成的页不重复，下一轮从未完成的页继续。整页都因密钥错误、APNs 故障等整体性原因失败时，该条目不会被记为已推送。
- **重复送达**：同一条目使用相同的 `apns-collapse-id`，即使重发，设备上也只保留一条通知。
- **健康检查**：最近一次成功轮询超过 10 分钟，容器变为 `unhealthy`（`docker ps` 可见）。
- 删除 `data/` 等于重新开始：会重新建立基线，不会补推旧内容。

## 准备 Apple 侧配置

1. [Identifiers](https://developer.apple.com/account/resources/identifiers/list) → 新建 App ID，Bundle ID 填 `com.aethernative.app`，勾选 **Push Notifications**。
2. [Keys](https://developer.apple.com/account/resources/authkeys/list) → 新建 Key，勾选 **Apple Push Notifications service (APNs)**，下载 `AuthKey_XXXXXXXXXX.p8`（**只能下载一次**，请备份）。文件名里的 10 位字符就是 Key ID。
3. Team ID 在 [Membership details](https://developer.apple.com/account#MembershipDetailsCard) 查看。

一个 `.p8` 可以给同一账号下所有 App 使用，sandbox 和 production 通用。

## 在服务器上部署

```bash
git clone https://github.com/bcblr1993/aethernative-site.git
cd aethernative-site/push-service
cp .env.example .env               # 填 APNS_KEY_ID、APNS_TEAM_ID、PUSH_SERVICE_TOKEN
mkdir -p secrets data && cp /path/to/AuthKey_XXXXXXXXXX.p8 secrets/AuthKey.p8
# 容器内以 node 用户（uid 1000）运行，需要能读密钥、写 data/
sudo chown 1000:1000 secrets/AuthKey.p8 data && chmod 400 secrets/AuthKey.p8
docker compose up -d --build
docker compose logs -f             # 首次启动应看到“首次运行：已有 N 条记为已推送”
```

`PUSH_SERVICE_TOKEN` 必须与 Cloudflare Pages 中的同名变量一致：

```bash
# 在网站仓库目录：生成令牌写入 push-service/.env，并设置为 Pages 加密变量（令牌不会显示在终端）
printf 'PUSH_SERVICE_TOKEN=%s\n' "$(openssl rand -hex 32)" >> push-service/.env
grep '^PUSH_SERVICE_TOKEN=' push-service/.env | cut -d= -f2 | npx wrangler pages secret put PUSH_SERVICE_TOKEN --project-name aethernative
```

更新：`git pull && docker compose up -d --build`。

## 发一条测试推送

在 iPhone 上用 Xcode 运行 App，点"开启通知"，复制页面上的 device token，然后：

```bash
docker compose run --rm push scripts/send-test.ts <device token> --env sandbox
```

（`docker compose run` 会临时启动一个新容器执行脚本，不影响正在运行的服务。）

- Xcode 直接安装的调试包用 `--env sandbox`；TestFlight / App Store 安装的用 `production`（默认）。App 页面上会显示当前环境。
- 失败时脚本会给出原因和提示，常见的有：
  - `BadDeviceToken`：环境选错了；
  - `DeviceTokenNotForTopic`：`APNS_TOPIC` 和 Bundle ID 不一致；
  - `InvalidProviderToken`：Key ID、Team ID 和 `.p8` 对不上。

## 开发

```bash
npm test                       # node:test 单元测试（用本地 HTTP/2 服务器模拟 APNs）
cd .. && npm run check         # 类型检查（包含 push-service）
```
