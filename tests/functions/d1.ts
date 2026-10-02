// 测试用的 D1 替身：基于 Node 内置 node:sqlite，执行真实的迁移 SQL。
// 只实现代码里用到的 prepare/bind/first/all/run/batch。
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = new URL('../../migrations/', import.meta.url);

class Stmt {
  constructor(private db: DatabaseSync, private sql: string, private args: unknown[] = []) {}
  bind(...args: unknown[]) {
    return new Stmt(this.db, this.sql, args);
  }
  async first<T>() {
    return (this.db.prepare(this.sql).get(...(this.args as any[])) ?? null) as T | null;
  }
  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...(this.args as any[])) as T[], success: true };
  }
  async run() {
    const r = this.exec();
    return { success: true, meta: { changes: Number(r.changes) } };
  }
  exec() {
    return this.db.prepare(this.sql).run(...(this.args as any[]));
  }
}

export function createD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  }
  const d1 = {
    prepare: (sql: string) => new Stmt(db, sql),
    // 与 D1 一致：batch 是一个事务
    async batch(stmts: Stmt[]) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => (s.exec(), { success: true }));
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    raw: db,
  };
  return d1 as unknown as D1Database & { raw: DatabaseSync };
}
