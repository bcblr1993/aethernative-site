// 推送服务的本地状态（node:sqlite，Docker 数据卷 /data/state.db）：
//   sent      已推送的条目（去重的依据）；
//   progress  正在推送的条目已完成到哪一页（中途失败时从这里继续，已发送的页不重复发送）；
//   meta      feed 的 ETag 与内容、是否已建立基线、最近一次成功轮询时间。
import { DatabaseSync } from 'node:sqlite';

export class State {
  #db: DatabaseSync;

  constructor(file: string) {
    this.#db = new DatabaseSync(file);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sent (id TEXT PRIMARY KEY, sent_at INTEGER NOT NULL, targets INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS progress (id TEXT PRIMARY KEY, cursor TEXT NOT NULL, targets INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  get(key: string): string | null {
    const r = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  set(key: string, value: string) {
    this.#db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  get initialized() {
    return this.get('initialized') === '1';
  }

  /** 首次运行：把当前已有的条目都记为已推送（不实际发送），只推送之后出现的新条目。 */
  baseline(ids: string[], now = Date.now()) {
    const insert = this.#db.prepare('INSERT OR IGNORE INTO sent (id, sent_at, targets) VALUES (?, ?, 0)');
    this.#tx(() => {
      for (const id of ids) insert.run(id, now);
      this.set('initialized', '1');
    });
  }

  isSent(id: string) {
    return this.#db.prepare('SELECT 1 FROM sent WHERE id = ?').get(id) !== undefined;
  }

  progress(id: string): { cursor: string; targets: number } {
    const r = this.#db.prepare('SELECT cursor, targets FROM progress WHERE id = ?').get(id) as { cursor: string; targets: number } | undefined;
    return r ?? { cursor: '', targets: 0 };
  }

  saveProgress(id: string, cursor: string, targets: number) {
    this.#db
      .prepare('INSERT INTO progress (id, cursor, targets) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET cursor = excluded.cursor, targets = excluded.targets')
      .run(id, cursor, targets);
  }

  markSent(id: string, targets: number, now = Date.now()) {
    this.#tx(() => {
      this.#db.prepare('INSERT OR REPLACE INTO sent (id, sent_at, targets) VALUES (?, ?, ?)').run(id, now, targets);
      this.#db.prepare('DELETE FROM progress WHERE id = ?').run(id);
    });
  }

  /** 清理很久以前的推送记录：早已滚出 feed，也超过了推送时限，不会再被选中。 */
  prune(now = Date.now(), keepMs = 90 * 86_400_000) {
    this.#db.prepare('DELETE FROM sent WHERE sent_at < ?').run(now - keepMs);
  }

  close() {
    this.#db.close();
  }

  #tx(fn: () => void) {
    this.#db.exec('BEGIN');
    try {
      fn();
      this.#db.exec('COMMIT');
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
  }
}
