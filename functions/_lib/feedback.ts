// 用户反馈：字段校验、频率限制与数据库操作。

export const CATEGORIES = ['bug', 'feature', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export const LIMITS = {
  title: 120,
  body: 5000,
  bodyMin: 10,
  version: 40,
  perHour: 5,
  perDay: 20,
  /** 请求体上限（字节），正文 5000 字按 UTF-8 最多约 20KB */
  requestBytes: 32 * 1024,
  /** “我的反馈”一次最多返回的条数 */
  list: 50,
};

/** 软件 ID 与 src/content/apps/<id>/ 目录名一致；'general' 表示网站或其他问题 */
const APP_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
/** 版本号只允许常见字符，例如 1.0.29、26.0.1 (25A354)、macOS 26 beta 3 */
const VERSION = /^[\p{L}\p{N} .\-+_()]+$/u;

export interface FeedbackInput {
  appId: string;
  category: Category;
  title: string;
  body: string;
  appVersion: string | null;
  osVersion: string | null;
}

export type FieldError = 'app' | 'category' | 'title' | 'body' | 'appVersion' | 'osVersion';

/** 统一换行、去掉控制字符（保留换行和制表符）、去掉首尾空白。 */
function clean(v: unknown, multiline: boolean) {
  if (typeof v !== 'string') return '';
  let s = v.replace(/\r\n?/g, '\n');
  s = multiline ? s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '') : s.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return s.trim();
}

/** 按字符（码点）计长度，中文、emoji 都算一个字。 */
const len = (s: string) => [...s].length;

export function validateFeedback(raw: unknown): { ok: true; value: FeedbackInput } | { ok: false; fields: FieldError[] } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const fields: FieldError[] = [];

  const appId = clean(o.appId, false);
  if (!APP_ID.test(appId)) fields.push('app');

  const category = clean(o.category, false) as Category;
  if (!CATEGORIES.includes(category)) fields.push('category');

  const title = clean(o.title, false).replace(/ {2,}/g, ' ');
  if (!title || len(title) > LIMITS.title) fields.push('title');

  const body = clean(o.body, true);
  if (len(body) < LIMITS.bodyMin || len(body) > LIMITS.body) fields.push('body');

  const version = (v: unknown, key: FieldError) => {
    const s = clean(v, false);
    if (!s) return null;
    if (len(s) > LIMITS.version || !VERSION.test(s)) fields.push(key);
    return s;
  };
  const appVersion = version(o.appVersion, 'appVersion');
  const osVersion = version(o.osVersion, 'osVersion');

  if (fields.length) return { ok: false, fields };
  return { ok: true, value: { appId, category, title, body, appVersion, osVersion } };
}

/** 频率限制：最近 1 小时 / 24 小时内的提交数。超限时返回需要等待的秒数。 */
export async function rateLimited(db: D1Database, userId: string, now = Date.now()): Promise<number | null> {
  const hour = now - 3600_000;
  const day = now - 86400_000;
  const r = await db
    .prepare(
      `SELECT SUM(created_at > ?) AS hour, COUNT(*) AS day, MIN(CASE WHEN created_at > ? THEN created_at END) AS oldest_hour, MIN(created_at) AS oldest_day
         FROM feedback WHERE user_id = ? AND created_at > ?`,
    )
    .bind(hour, hour, userId, day)
    .first<{ hour: number | null; day: number; oldest_hour: number | null; oldest_day: number | null }>();
  if (!r) return null;
  if (r.day >= LIMITS.perDay && r.oldest_day) return Math.ceil((r.oldest_day + 86400_000 - now) / 1000);
  if ((r.hour ?? 0) >= LIMITS.perHour && r.oldest_hour) return Math.ceil((r.oldest_hour + 3600_000 - now) / 1000);
  return null;
}

export interface FeedbackRow {
  id: string;
  app_id: string;
  category: Category;
  title: string;
  body: string;
  app_version: string | null;
  os_version: string | null;
  status: 'new' | 'triaged' | 'replied' | 'closed';
  admin_reply: string | null;
  created_at: number;
  updated_at: number;
}

const COLUMNS = 'id, app_id, category, title, body, app_version, os_version, status, admin_reply, created_at, updated_at';

export async function insertFeedback(db: D1Database, userId: string, f: FeedbackInput, now = Date.now()) {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO feedback (id, user_id, app_id, category, title, body, app_version, os_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, userId, f.appId, f.category, f.title, f.body, f.appVersion, f.osVersion, now, now)
    .run();
  return (await db.prepare(`SELECT ${COLUMNS} FROM feedback WHERE id = ?`).bind(id).first<FeedbackRow>())!;
}

export async function listFeedback(db: D1Database, userId: string) {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`)
    .bind(userId, LIMITS.list)
    .all<FeedbackRow>();
  return results;
}

/** 对外返回的字段（camelCase），不包含 user_id。 */
export const publicFeedback = (r: FeedbackRow) => ({
  id: r.id,
  appId: r.app_id,
  category: r.category,
  title: r.title,
  body: r.body,
  appVersion: r.app_version,
  osVersion: r.os_version,
  status: r.status,
  reply: r.admin_reply,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
