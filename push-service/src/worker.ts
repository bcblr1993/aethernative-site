// 一轮轮询：读 feed → 选出新条目 → 分页查目标 → 并发发送 → 回报失效 token 与心跳 → 记录已推送。
import type { ApnsClient, SendResult } from './apns.ts';
import { collapseId, EXPIRE_SECONDS, outboxPayload, payload, selectNew, targetQuery, type FeedItem, type Locale } from './notify.ts';
import { parseFeed, type SiteClient, type Target } from './site.ts';
import type { State } from './state.ts';

export interface WorkerOptions {
  site: SiteClient;
  apns: Pick<ApnsClient, 'send'>;
  state: State;
  /** 同时进行的 APNs 请求数 */
  concurrency?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface RoundResult {
  /** 首次运行建立了基线 */
  baseline?: number;
  items: { id: string; targets: number; sent: number; failed: number; invalid: number }[];
  removed: number;
  /** 未完成的条目（下一轮继续） */
  errors: string[];
}

export class Worker {
  #o: Required<WorkerOptions>;
  /** 回报失败的失效 token 留到下一轮再报 */
  #pendingInvalid = new Set<string>();

  constructor(o: WorkerOptions) {
    this.#o = { concurrency: 20, now: Date.now, log: (m) => console.log(`[${new Date().toISOString()}] ${m}`), ...o };
  }

  async round(): Promise<RoundResult> {
    const { site, state, log } = this.#o;
    const result: RoundResult = { items: [], removed: 0, errors: [] };

    // 304 时使用上次保存的 feed：上一轮中途失败的条目仍需继续推送
    const fresh = await site.feed(state.get('feed_etag'));
    let items: FeedItem[];
    if (fresh) {
      items = fresh.feed.items;
      state.set('feed_body', fresh.body);
      state.set('feed_etag', fresh.etag ?? '');
    } else {
      const cached = state.get('feed_body');
      items = cached ? parseFeed(cached).items : [];
    }

    if (!state.initialized) {
      state.baseline(items.map((i) => i.id), this.#o.now());
      result.baseline = items.length;
      log(`首次运行：已有 ${items.length} 条记为已推送，之后只推送新条目`);
    } else {
      for (const item of selectNew(items, (id) => state.isSent(id), this.#o.now())) {
        // 单个条目失败不影响后面的条目；它会在下一轮从未完成的页继续
        try {
          result.items.push(await this.#deliver(item));
        } catch (e) {
          const err = e as Error & { cause?: { code?: string } };
          const msg = err.cause?.code ? `${err.message}（${err.cause.code}）` : err.message;
          result.errors.push(`${item.id}: ${msg}`);
          log(`推送 ${item.id} 未完成，下一轮继续：${msg}`);
        }
      }
    }

    const invalid = [...this.#pendingInvalid];
    try {
      const r = await site.report(invalid, { at: this.#o.now(), items: result.items, errors: result.errors });
      result.removed = r.removed;
      this.#pendingInvalid.clear();
      if (r.removed) log(`已删除 ${r.removed} 个失效设备`);
    } catch (e) {
      log(`回报失败，下一轮重试：${(e as Error).message}`);
    }

    // 有条目没推完时不算成功：一直失败会让 Docker 健康检查变为 unhealthy
    if (!result.errors.length) state.set('last_ok', String(this.#o.now()));
    state.prune(this.#o.now());
    return result;
  }

  /** 推送一个条目。每完成一页保存进度；中途出错时抛出，下一轮从未完成的页继续。 */
  async #deliver(item: FeedItem) {
    const { site, state, log } = this.#o;
    const q = targetQuery(item)!;
    let { cursor, targets } = state.progress(item.id);
    const stats = { id: item.id, targets, sent: 0, failed: 0, invalid: 0 };

    do {
      const page = await site.targets(q, cursor);
      const results = await this.#sendAll(item, page.targets);
      // 整页都因整体性原因失败（密钥配置错误、APNs 故障、网络中断）：这一页不算完成，下一轮重试。
      // 否则一旦配置出错，所有推送都会被记为“已推送”而悄悄丢失。
      const systemic = results.filter(([, r]) => isSystemicFailure(r));
      if (results.length && systemic.length === results.length) {
        const r = systemic[0]![1];
        throw new Error(`APNs 全部失败（HTTP ${r.status} ${r.reason ?? ''}），可能是密钥配置或网络问题`);
      }
      for (const [t, r] of results) {
        if (r.ok) stats.sent++;
        else stats.failed++;
        if (r.invalidToken) {
          stats.invalid++;
          this.#pendingInvalid.add(t.token);
        }
      }
      targets += page.targets.length;
      stats.targets = targets;
      cursor = page.next ?? '';
      if (cursor) state.saveProgress(item.id, cursor, targets);
    } while (cursor);

    state.markSent(item.id, targets, this.#o.now());
    log(`推送 ${item.id} → ${targets} 台设备：成功 ${stats.sent}，失败 ${stats.failed}，失效 ${stats.invalid}`);
    return stats;
  }

  #sendAll(item: FeedItem, targets: Target[]) {
    return this.#send(targets, { zh: payload(item, 'zh'), en: payload(item, 'en') }, collapseId(item.id));
  }

  async #send(targets: Target[], bodies: Record<Locale, object>, collapse: string) {
    const expiration = Math.floor(this.#o.now() / 1000) + EXPIRE_SECONDS;
    const out: [Target, SendResult][] = [];
    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const t = targets[next++]!;
        const r = await this.#o.apns.send(t.token, bodies[t.locale] ?? bodies.en, { env: t.env, collapseId: collapse, expiration });
        out.push([t, r]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.#o.concurrency, targets.length) }, worker));
    return out;
  }

  /**
   * 处理待发队列（管理员回复反馈等）：领取 → 发送 → 确认。
   * 某个任务的全部设备都因整体性原因失败时不确认，租约过期后由网站重新派发（最多 5 次）。
   */
  async outboxRound() {
    const { site, log } = this.#o;
    const jobs = await site.claimOutbox();
    const done: string[] = [];
    const invalid = new Set<string>();
    const stats = { jobs: jobs.length, sent: 0, failed: 0, retry: 0 };
    for (const job of jobs) {
      const bodies = { zh: outboxPayload(job, 'zh'), en: outboxPayload(job, 'en') };
      const results = await this.#send(job.targets, bodies, collapseId(`${job.route.kind}:${job.route.id}`));
      if (results.length && results.every(([, r]) => isSystemicFailure(r))) {
        stats.retry++;
        log(`推送任务 ${job.id} 全部失败（HTTP ${results[0]![1].status} ${results[0]![1].reason ?? ''}），稍后重试`);
        continue;
      }
      for (const [t, r] of results) {
        if (r.ok) stats.sent++;
        else stats.failed++;
        if (r.invalidToken) invalid.add(t.token);
      }
      done.push(job.id);
    }
    if (done.length || invalid.size) await site.ackOutbox(done, [...invalid]);
    if (jobs.length) log(`推送队列：${jobs.length} 个任务，成功 ${stats.sent}，失败 ${stats.failed}，待重试 ${stats.retry}`);
    return stats;
  }
}

/**
 * 与单个设备无关的失败：认证 / Bundle ID 配置错误、限流、APNs 服务器错误、连接失败。
 * 这类失败对所有设备都一样，重试才有意义；单个设备的问题（token 失效、正文过大等）不在此列。
 */
export function isSystemicFailure(r: SendResult) {
  if (r.ok || r.invalidToken) return false;
  if (r.status === 0) return r.reason !== 'PayloadTooLarge';
  return r.status === 403 || r.status === 429 || r.status >= 500 || r.reason === 'TopicDisallowed' || r.reason === 'BadTopic';
}
