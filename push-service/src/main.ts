// 推送服务常驻进程：每隔 POLL_INTERVAL_SECONDS 轮询一次；收到 SIGTERM / SIGINT（docker stop）时等当前一轮结束后退出。
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApnsClient } from './apns.ts';
import { loadServiceConfig } from './config.ts';
import { SiteClient } from './site.ts';
import { State } from './state.ts';
import { Worker } from './worker.ts';

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

/** fetch 失败时真正的原因在 cause 里（如 ECONNREFUSED、证书错误）。 */
const describe = (e: unknown) => {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  const cause = err.cause?.code ?? err.cause?.message;
  return cause ? `${err.message}（${cause}）` : err.message;
};

let config;
try {
  config = loadServiceConfig();
} catch (e) {
  console.error(`✗ 配置错误：${(e as Error).message}`);
  process.exit(2);
}

mkdirSync(config.dataDir, { recursive: true });
const state = new State(join(config.dataDir, 'state.db'));
const apns = new ApnsClient(config.apns);
const worker = new Worker({ site: new SiteClient(config.siteUrl, config.serviceToken), apns, state, concurrency: config.concurrency, log });

const stop = new AbortController();
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log(`收到 ${sig}，当前一轮结束后退出`);
    stop.abort();
  });
}

log(`推送服务启动：${config.siteUrl}，每 ${config.pollSeconds} 秒检查一次，Bundle ID ${config.apns.topic}`);
while (!stop.signal.aborted) {
  try {
    await worker.round();
  } catch (e) {
    // 网站或 APNs 暂时不可用：记录后等下一轮（未完成的条目会继续）
    log(`本轮失败：${describe(e)}`);
  }
  await sleep(config.pollSeconds * 1000, undefined, { signal: stop.signal }).catch(() => {});
}

apns.close();
state.close();
log('已退出');
