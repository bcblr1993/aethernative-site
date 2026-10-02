// 从环境变量读取配置。密钥文件由 Docker secrets 挂载，不进镜像和仓库。
import { readFileSync } from 'node:fs';
import type { ApnsEnv, ApnsOptions } from './apns.ts';

export interface ApnsConfig extends Pick<ApnsOptions, 'key' | 'keyId' | 'teamId' | 'topic'> {}

function need(env: NodeJS.ProcessEnv, name: string) {
  const v = env[name]?.trim();
  if (!v) throw new Error(`缺少环境变量 ${name}（参考 .env.example）`);
  return v;
}

export function loadApnsConfig(env = process.env): ApnsConfig {
  const file = need(env, 'APNS_KEY_FILE');
  let key: string;
  try {
    key = readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`无法读取 APNs 密钥 ${file}：${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  return {
    key,
    keyId: need(env, 'APNS_KEY_ID'),
    teamId: need(env, 'APNS_TEAM_ID'),
    topic: env.APNS_TOPIC?.trim() || 'com.aethernative.app',
  };
}

export function parseEnv(v: string | undefined): ApnsEnv {
  if (v === undefined || v === 'production') return 'production';
  if (v === 'sandbox') return 'sandbox';
  throw new Error(`APNs 环境应为 production 或 sandbox，收到 ${v}`);
}
