// Docker 健康检查：最近一次成功轮询在 3 个轮询周期（至少 10 分钟）以内即为健康。
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const poll = Number(process.env.POLL_INTERVAL_SECONDS || 120);
const limit = Math.max(600, poll * 3) * 1000;
try {
  const db = new DatabaseSync(join(process.env.DATA_DIR || '/data', 'state.db'), { readOnly: true });
  const row = db.prepare("SELECT value FROM meta WHERE key = 'last_ok'").get() as { value: string } | undefined;
  const age = row ? Date.now() - Number(row.value) : Infinity;
  if (age > limit) {
    console.error(`最近一次成功轮询：${row ? `${Math.round(age / 1000)} 秒前` : '从未'}`);
    process.exit(1);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
