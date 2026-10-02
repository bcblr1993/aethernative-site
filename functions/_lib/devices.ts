// iPhone App 推送设备：字段校验、注册 / 更新、按订阅查找推送目标。表结构见 migrations/0003_push.sql。
import { safeEqual, sha256Hex } from './crypto';

export const DEVICE_LIMITS = {
  /** 请求体上限（字节） */
  requestBytes: 8 * 1024,
  /** 单个设备最多订阅的软件数 */
  apps: 50,
  /** 超过这么久没有任何请求的设备会被清理 */
  inactiveMs: 180 * 86_400_000,
  /** 推送目标每页条数 */
  page: 500,
};

/** 安装 ID：App 生成的 UUID */
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 设备密钥：App 生成的 32 字节随机数（base64url 或十六进制） */
const SECRET = /^[A-Za-z0-9_-]{32,128}$/;
const TOKEN = /^[0-9a-f]{64,200}$/i;
/** 与 src/content/apps/<id>/ 目录名一致 */
const APP_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const VERSION = /^[\p{L}\p{N} .\-+_()]{1,40}$/u;

export type ApnsEnv = 'production' | 'sandbox';
export type Locale = 'zh' | 'en';

export interface Subscriptions {
  news: boolean;
  /** 接收全部软件的正式版（含以后新上线的） */
  allApps: boolean;
  /** allApps 为 false 时，接收这些软件的正式版 */
  apps: string[];
  /** 接收这些软件的测试版 */
  beta: string[];
}

export interface DeviceInput {
  token: string;
  env: ApnsEnv;
  locale: Locale;
  enabled: boolean;
  appVersion: string | null;
  subscriptions: Subscriptions;
}

export type DeviceField = 'token' | 'env' | 'locale' | 'enabled' | 'appVersion' | 'subscriptions';

export const isDeviceId = (id: unknown): id is string => typeof id === 'string' && DEVICE_ID.test(id);

/** 从 Authorization: Bearer 取设备密钥；格式不对返回 null。 */
export function bearer(request: Request) {
  const m = /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '');
  return m && SECRET.test(m[1]!) ? m[1]! : null;
}

const appList = (v: unknown) => {
  if (!Array.isArray(v) || v.length > DEVICE_LIMITS.apps || !v.every((x) => typeof x === 'string' && APP_ID.test(x))) return null;
  return [...new Set(v as string[])].sort();
};

export function validateDevice(raw: unknown): { ok: true; value: DeviceInput } | { ok: false; fields: DeviceField[] } {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const fields: DeviceField[] = [];

  const token = typeof o.token === 'string' ? o.token.toLowerCase() : '';
  if (!TOKEN.test(token)) fields.push('token');
  if (o.env !== 'production' && o.env !== 'sandbox') fields.push('env');
  if (o.locale !== 'zh' && o.locale !== 'en') fields.push('locale');
  if (typeof o.enabled !== 'boolean') fields.push('enabled');

  let appVersion: string | null = null;
  if (o.appVersion !== undefined && o.appVersion !== null) {
    if (typeof o.appVersion === 'string' && VERSION.test(o.appVersion)) appVersion = o.appVersion;
    else fields.push('appVersion');
  }

  const s = (o.subscriptions && typeof o.subscriptions === 'object' ? o.subscriptions : {}) as Record<string, unknown>;
  const apps = appList(s.apps ?? []);
  const beta = appList(s.beta ?? []);
  if (typeof s.news !== 'boolean' || typeof s.allApps !== 'boolean' || !apps || !beta) fields.push('subscriptions');

  if (fields.length) return { ok: false, fields };
  return {
    ok: true,
    value: {
      token,
      env: o.env as ApnsEnv,
      locale: o.locale as Locale,
      enabled: o.enabled as boolean,
      appVersion,
      subscriptions: { news: s.news as boolean, allApps: s.allApps as boolean, apps: s.allApps ? [] : apps!, beta: beta! },
    },
  };
}

interface DeviceRow {
  id: string;
  secret_hash: string;
  news: number;
  all_apps: number;
  enabled: number;
}

export type UpsertResult = { status: 'created' | 'updated'; subscriptions: Subscriptions } | { status: 'forbidden' };

/**
 * 注册或更新设备。已存在时必须提供相同的设备密钥。
 * 同一 token 若登记在别的安装 ID 下（重装、从备份恢复），旧记录会被删除——token 只属于当前这台设备。
 */
export async function upsertDevice(db: D1Database, id: string, secret: string, d: DeviceInput, now = Date.now()): Promise<UpsertResult> {
  const hash = await sha256Hex(secret);
  const found = await db.prepare('SELECT id, secret_hash FROM devices WHERE id = ?').bind(id).first<DeviceRow>();
  if (found && !safeEqual(found.secret_hash, hash)) return { status: 'forbidden' };

  const s = d.subscriptions;
  const rows = new Map<string, { stable: number; beta: number }>();
  for (const a of s.apps) rows.set(a, { stable: 1, beta: 0 });
  for (const a of s.beta) rows.set(a, { stable: rows.get(a)?.stable ?? 0, beta: 1 });

  await db.batch([
    // 新设备注册时顺带清理长期不活跃的设备（与清理过期会话的做法一致）
    ...(found ? [] : [db.prepare('DELETE FROM devices WHERE last_seen_at < ?').bind(now - DEVICE_LIMITS.inactiveMs)]),
    db.prepare('DELETE FROM devices WHERE token = ? AND id <> ?').bind(d.token, id),
    db
      .prepare(
        `INSERT INTO devices (id, secret_hash, token, env, locale, enabled, news, all_apps, app_version, created_at, updated_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           token = excluded.token, env = excluded.env, locale = excluded.locale, enabled = excluded.enabled,
           news = excluded.news, all_apps = excluded.all_apps, app_version = excluded.app_version,
           updated_at = excluded.updated_at, last_seen_at = excluded.last_seen_at
         WHERE devices.secret_hash = excluded.secret_hash`,
      )
      .bind(id, hash, d.token, d.env, d.locale, +d.enabled, +s.news, +s.allApps, d.appVersion, now, now, now),
    db.prepare('DELETE FROM device_apps WHERE device_id = ?').bind(id),
    ...[...rows].map(([app, r]) =>
      db.prepare('INSERT INTO device_apps (device_id, app_id, stable, beta) VALUES (?, ?, ?, ?)').bind(id, app, r.stable, r.beta),
    ),
  ]);
  return { status: found ? 'updated' : 'created', subscriptions: s };
}

export async function deleteDevice(db: D1Database, id: string, secret: string) {
  const found = await db.prepare('SELECT secret_hash FROM devices WHERE id = ?').bind(id).first<{ secret_hash: string }>();
  if (!found) return 'not_found' as const;
  if (!safeEqual(found.secret_hash, await sha256Hex(secret))) return 'forbidden' as const;
  await db.prepare('DELETE FROM devices WHERE id = ?').bind(id).run();
  return 'deleted' as const;
}

export type TargetQuery =
  | { kind: 'news' }
  | { kind: 'release'; app: string; channel: 'stable' | 'beta' };

export interface Target {
  token: string;
  env: ApnsEnv;
  locale: Locale;
}

export function parseTargetQuery(p: URLSearchParams): TargetQuery | null {
  const kind = p.get('kind');
  if (kind === 'news') return { kind };
  const app = p.get('app') ?? '';
  const channel = p.get('channel');
  if (kind === 'release' && APP_ID.test(app) && (channel === 'stable' || channel === 'beta')) return { kind, app, channel };
  return null;
}

/** 按订阅查找推送目标（只含开启了通知的设备），按 id 分页。 */
export async function findTargets(db: D1Database, q: TargetQuery, cursor = '', limit = DEVICE_LIMITS.page) {
  const where =
    q.kind === 'news'
      ? 'd.news = 1'
      : q.channel === 'stable'
        ? 'd.all_apps = 1 OR EXISTS (SELECT 1 FROM device_apps a WHERE a.device_id = d.id AND a.app_id = ?2 AND a.stable = 1)'
        : 'EXISTS (SELECT 1 FROM device_apps a WHERE a.device_id = d.id AND a.app_id = ?2 AND a.beta = 1)';
  const stmt = db.prepare(
    `SELECT d.id, d.token, d.env, d.locale FROM devices d
      WHERE d.enabled = 1 AND d.id > ?1 AND (${where})
      ORDER BY d.id LIMIT ?3`,
  );
  const { results } = await stmt.bind(cursor, q.kind === 'release' ? q.app : null, limit).all<Target & { id: string }>();
  return {
    targets: results.map(({ token, env, locale }) => ({ token, env, locale })),
    next: results.length === limit ? results.at(-1)!.id : null,
  };
}

/** 删除 APNs 报告失效的 token。D1 单条语句的参数有上限，分批删除。 */
export async function removeTokens(db: D1Database, tokens: string[]) {
  const valid = [...new Set(tokens.map((t) => t.toLowerCase()).filter((t) => TOKEN.test(t)))];
  let removed = 0;
  for (let i = 0; i < valid.length; i += 50) {
    const chunk = valid.slice(i, i + 50);
    const r = await db.prepare(`DELETE FROM devices WHERE token IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).run();
    removed += r.meta?.changes ?? 0;
  }
  return { removed, ignored: tokens.length - valid.length };
}
