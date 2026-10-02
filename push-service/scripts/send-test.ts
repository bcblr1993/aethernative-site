// 给一台设备发一条测试推送，用来验证 .p8 密钥、Team ID、Bundle ID 和网络是否正确。
//   node scripts/send-test.ts <device token> [--env sandbox] [--title 标题] [--body 正文] [--url aethernative://…]
// Xcode 直接安装的调试包用 --env sandbox；TestFlight / App Store 安装的用 production（默认）。
import { parseArgs } from 'node:util';
import { ApnsClient } from '../src/apns.ts';
import { loadApnsConfig, parseEnv } from '../src/config.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    env: { type: 'string' },
    title: { type: 'string', default: 'Aether Native' },
    body: { type: 'string', default: '推送测试成功 · Push test succeeded' },
    url: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || positionals.length !== 1) {
  console.log('用法：node scripts/send-test.ts <device token> [--env sandbox|production] [--title …] [--body …] [--url …]');
  process.exit(values.help ? 0 : 2);
}

let env, apns;
try {
  env = parseEnv(values.env);
  apns = new ApnsClient(loadApnsConfig());
} catch (e) {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(2);
}
const payload = {
  aps: { alert: { title: values.title, body: values.body }, sound: 'default' },
  ...(values.url && { url: values.url }),
};

const r = await apns.send(positionals[0].trim(), payload, { env });
apns.close();

if (r.ok) {
  console.log(`✓ 已发送（${env}），apns-id: ${r.apnsId}`);
} else {
  console.error(`✗ 发送失败（${env}）：HTTP ${r.status} ${r.reason ?? ''}`);
  const hints: Record<string, string> = {
    BadDeviceToken: 'token 与环境不匹配：Xcode 调试包用 --env sandbox，TestFlight 用 production',
    DeviceTokenNotForTopic: 'APNS_TOPIC 与 App 的 Bundle ID 不一致',
    InvalidProviderToken: 'APNS_KEY_ID / APNS_TEAM_ID 与 .p8 不匹配，或密钥已被吊销',
    TopicDisallowed: '该 Bundle ID 未开启 Push Notifications 能力',
  };
  if (r.reason && hints[r.reason]) console.error(`  提示：${hints[r.reason]}`);
  process.exit(1);
}
