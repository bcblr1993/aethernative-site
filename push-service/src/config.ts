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

export interface ServiceConfig {
  apns: ApnsConfig;
  siteUrl: string;
  serviceToken: string;
  dataDir: string;
  pollSeconds: number;
  concurrency: number;
}

function int(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number) {
  const raw = env[name]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} 应为 ${min}–${max} 之间的整数，收到 ${raw}`);
  return n;
}

export function loadServiceConfig(env = process.env): ServiceConfig {
  const serviceToken = need(env, 'PUSH_SERVICE_TOKEN');
  if (serviceToken.length < 32) throw new Error('PUSH_SERVICE_TOKEN 太短（至少 32 字符），用 openssl rand -hex 32 生成');
  const siteUrl = env.SITE_URL?.trim() || 'https://aethernative.com';
  if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(siteUrl)) throw new Error(`SITE_URL 必须是 https 地址（本机调试可用 http://localhost）：${siteUrl}`);
  return {
    apns: loadApnsConfig(env),
    siteUrl,
    serviceToken,
    dataDir: env.DATA_DIR?.trim() || '/data',
    pollSeconds: int(env, 'POLL_INTERVAL_SECONDS', 120, 30, 3600),
    concurrency: int(env, 'CONCURRENCY', 20, 1, 200),
  };
}
