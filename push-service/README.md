# 推送服务（push-service）

运行在自有服务器上，负责给 iPhone App 发 APNs 推送。Cloudflare Workers 的出站请求不支持 HTTP/2，无法直连 APNs，所以推送放在这里。

- Node 24 直接运行 TypeScript（类型擦除），**没有第三方依赖，也没有编译步骤**；
- 只有出站连接（APNs、aethernative.com），不需要开放端口；
- `.p8` 密钥只放在服务器上，通过 Docker secrets 挂载，不进镜像和仓库。

> 当前是 P0 阶段：只有发送器（`src/apns.ts`）和测试脚本。常驻服务（轮询 `feed.json`、推送队列）在 P2 加入。

## 准备 Apple 侧配置

1. [Identifiers](https://developer.apple.com/account/resources/identifiers/list) → 新建 App ID，Bundle ID 填 `com.aethernative.app`，勾选 **Push Notifications**。
2. [Keys](https://developer.apple.com/account/resources/authkeys/list) → 新建 Key，勾选 **Apple Push Notifications service (APNs)**，下载 `AuthKey_XXXXXXXXXX.p8`（**只能下载一次**，请备份）。文件名里的 10 位字符就是 Key ID。
3. Team ID 在 [Membership details](https://developer.apple.com/account#MembershipDetailsCard) 查看。

一个 `.p8` 可以给同一账号下所有 App 使用，sandbox 和 production 通用。

## 在服务器上部署

```bash
git clone https://github.com/bcblr1993/aethernative-site.git
cd aethernative-site/push-service
cp .env.example .env               # 填 APNS_KEY_ID、APNS_TEAM_ID
mkdir -p secrets && cp /path/to/AuthKey_XXXXXXXXXX.p8 secrets/AuthKey.p8
sudo chown 1000:1000 secrets/AuthKey.p8 && chmod 400 secrets/AuthKey.p8   # 容器内以 node 用户（uid 1000）运行
docker compose build
```

## 发一条测试推送

在 iPhone 上用 Xcode 运行 App，点"开启通知"，复制页面上的 device token，然后：

```bash
docker compose run --rm push scripts/send-test.ts <device token> --env sandbox
```

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
