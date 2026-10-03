// 待发推送队列（push_outbox）：写入、领取（带租约）、确认。表结构见 migrations/0006_push_outbox.sql。
import type { Target } from './devices';

/** 领取后多久未确认即可被重新领取 */
export const LEASE_MS = 5 * 60_000;
export const MAX_ATTEMPTS = 5;
export const CLAIM_LIMIT = 50;

export type Bi = { zh: string; en: string };
export interface Alert { zh: { title: string; body: string }; en: { title: string; body: string } }

const clip = (s: string, n = 120) => ([...s].length > n ? [...s].slice(0, n - 1).join('') + '…' : s);

/**
 * 管理员回复了反馈：给提交者关联的设备排一条推送。
 * 没有关联设备时不排（以后关联的设备也不会补推旧回复）；同一条反馈尚未发出的旧推送被替换为最新一次。
 */
export async function enqueueFeedbackReply(db: D1Database, f: { id: string; user_id: string; title: string }, now = Date.now()) {
  const has = await db.prepare('SELECT 1 FROM devices WHERE user_id = ? LIMIT 1').bind(f.user_id).first();
  if (!has) return false;
  const alert: Alert = {
    zh: { title: '你的反馈有新回复', body: clip(f.title) },
    en: { title: 'New reply to your feedback', body: clip(f.title) },
  };
  await db.batch([
    db.prepare("DELETE FROM push_outbox WHERE kind = 'feedback_reply' AND ref_id = ? AND sent_at IS NULL").bind(f.id),
    db.prepare("INSERT INTO push_outbox (id, kind, user_id, ref_id, alert, created_at) VALUES (?, 'feedback_reply', ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), f.user_id, f.id, JSON.stringify(alert), now),
  ]);
  return true;
}

export interface Job {
  id: string;
  kind: 'feedback_reply';
  /** 点开通知后的跳转（iOS NotificationRoute） */
  route: { kind: 'feedback'; id: string };
  alert: Alert;
  targets: Target[];
}

/** 领取待发任务：未发送、未超过尝试次数、未被领取或租约已过期。UPDATE … RETURNING 保证同一任务不会被同时领取两次。 */
export async function claimJobs(db: D1Database, now = Date.now(), limit = CLAIM_LIMIT): Promise<Job[]> {
  const { results } = await db
    .prepare(
      `UPDATE push_outbox SET claimed_at = ?1, attempts = attempts + 1
        WHERE id IN (SELECT id FROM push_outbox
                      WHERE sent_at IS NULL AND attempts < ?2 AND (claimed_at IS NULL OR claimed_at < ?3)
                      ORDER BY created_at LIMIT ?4)
        RETURNING id, kind, user_id, ref_id, alert`,
    )
    .bind(now, MAX_ATTEMPTS, now - LEASE_MS, limit)
    .all<{ id: string; kind: 'feedback_reply'; user_id: string; ref_id: string; alert: string }>();

  const jobs: Job[] = [];
  for (const r of results) {
    const { results: targets } = await db
      .prepare('SELECT token, env, locale FROM devices WHERE user_id = ? AND enabled = 1')
      .bind(r.user_id)
      .all<Target>();
    jobs.push({ id: r.id, kind: r.kind, route: { kind: 'feedback', id: r.ref_id }, alert: JSON.parse(r.alert), targets });
  }
  return jobs;
}

/** 确认已发送（包括没有可用设备的任务）。 */
export async function ackJobs(db: D1Database, ids: string[], now = Date.now()) {
  let done = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const r = await db.prepare(`UPDATE push_outbox SET sent_at = ? WHERE sent_at IS NULL AND id IN (${chunk.map(() => '?').join(',')})`).bind(now, ...chunk).run();
    done += r.meta?.changes ?? 0;
  }
  return done;
}
