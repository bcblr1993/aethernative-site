import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { SendOptions, SendResult } from '../src/apns.ts';
import { parseFeed, SiteClient } from '../src/site.ts';
import { State } from '../src/state.ts';
import { isSystemicFailure, Worker } from '../src/worker.ts';

const NOW = Date.parse('2026-10-10T00:00:00Z');
const TOKEN = 't'.repeat(40);
const tok = (n: number) => n.toString(16).padStart(64, '0');

const rel = (id: string, date: string, channel = 'stable') => ({
  id: `release:demo:${id}`,
  kind: 'release',
  date,
  title: { zh: `Demo ${id}`, en: `Demo ${id}` },
  summary: { zh: '摘要', en: 'Summary' },
  push: true,
  release: { appId: 'demo', version: id, channel },
});

/** 模拟 aethernative.com：feed.json（带 ETag）、push-targets（可分页、可注入失败）、push-report（记录请求）。 */
interface FakeSite {
  items: object[];
  targets: { token: string; env: string; locale: string }[];
  pageSize: number;
  failTargetsAt: number | null;
  failReport: boolean;
  reports: { invalidTokens: string[]; status: any }[];
  targetQueries: string[];
  feedRequests: { ifNoneMatch?: string; status: number }[];
  jobs: object[];
  acks: { ids: string[]; invalidTokens: string[] }[];
}

let site: FakeSite;
let server: Server;
let dir: string;
let state: State;
let client: SiteClient;
let sends: { token: string; payload: any; o: SendOptions }[];
let invalid: Set<string>;
/** 模拟整体性失败（例如密钥错误）：所有发送返回 403 */
let apnsDown: boolean;

const apns = {
  async send(token: string, payload: object, o: SendOptions): Promise<SendResult> {
    sends.push({ token, payload, o });
    if (apnsDown) return { ok: false, status: 403, reason: 'InvalidProviderToken', invalidToken: false };
    const bad = invalid.has(token);
    return { ok: !bad, status: bad ? 410 : 200, reason: bad ? 'Unregistered' : undefined, invalidToken: bad };
  },
};

const worker = () => new Worker({ site: client, apns, state, now: () => NOW, log: () => {} });

beforeEach(async () => {
  site = { items: [], targets: [], pageSize: 500, failTargetsAt: null, failReport: false, reports: [], targetQueries: [], feedRequests: [], jobs: [], acks: [] };
  sends = [];
  invalid = new Set();
  apnsDown = false;
  let targetCalls = 0;
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const authed = req.headers.authorization === `Bearer ${TOKEN}`;
    if (url.pathname === '/feed.json') {
      const body = JSON.stringify({ version: 1, items: site.items });
      const etag = `"${Buffer.from(body).toString('base64').length}-${site.items.length}"`;
      const status = req.headers['if-none-match'] === etag ? 304 : 200;
      site.feedRequests.push({ ifNoneMatch: req.headers['if-none-match'] as string, status });
      res.writeHead(status, { ETag: etag, 'Content-Type': 'application/json' });
      return res.end(status === 200 ? body : undefined);
    }
    if (!authed) return res.writeHead(401).end();
    if (url.pathname === '/api/admin/push-targets') {
      site.targetQueries.push(url.search);
      if (site.failTargetsAt !== null && targetCalls++ === site.failTargetsAt) return res.writeHead(503).end();
      const start = Number(url.searchParams.get('cursor') || 0);
      const page = site.targets.slice(start, start + site.pageSize);
      const next = start + site.pageSize < site.targets.length ? String(start + site.pageSize) : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ targets: page, next }));
    }
    if (url.pathname === '/api/admin/push-outbox/claim') {
      const jobs = site.jobs;
      site.jobs = [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ jobs }));
    }
    if (url.pathname === '/api/admin/push-outbox/ack') {
      let body = '';
      req.on('data', (c) => (body += c)).on('end', () => {
        const r = JSON.parse(body);
        site.acks.push(r);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ acked: r.ids.length, removed: r.invalidTokens.length }));
      });
      return;
    }
    if (url.pathname === '/api/admin/push-report') {
      if (site.failReport) return res.writeHead(503).end();
      let body = '';
      req.on('data', (c) => (body += c)).on('end', () => {
        const r = JSON.parse(body);
        site.reports.push(r);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ removed: r.invalidTokens.length }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  client = new SiteClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, TOKEN);
  dir = mkdtempSync(join(tmpdir(), 'push-'));
  state = new State(join(dir, 'state.db'));
});

afterEach(async () => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
  await new Promise<void>((ok) => server.close(() => ok()));
});

test('首次运行只建立基线，不发送；之后只推送新条目一次', async () => {
  site.items = [rel('1.0', '2026-10-09T00:00:00Z')];
  site.targets = [{ token: tok(1), env: 'production', locale: 'zh' }];
  const r1 = await worker().round();
  assert.equal(r1.baseline, 1);
  assert.equal(sends.length, 0);

  site.items = [rel('1.1', '2026-10-10T00:00:00Z'), ...site.items];
  const r2 = await worker().round();
  assert.deepEqual(r2.items.map((i) => [i.id, i.targets, i.sent]), [['release:demo:1.1', 1, 1]]);
  assert.equal(sends.length, 1);
  assert.equal(sends[0]!.payload.aps.alert.title, 'Demo 1.1 已发布');
  assert.equal(sends[0]!.o.collapseId, 'release:demo:1.1');
  assert.equal(sends[0]!.o.expiration, NOW / 1000 + 3 * 86_400);

  // 再来一轮（304）：不重复推送
  await worker().round();
  assert.equal(sends.length, 1);
  assert.equal(site.feedRequests.at(-1)!.status, 304);
});

test('按设备语言与环境发送；按渠道查询目标', async () => {
  await worker().round(); // 基线（空）
  site.items = [rel('2.0-beta', '2026-10-10T00:00:00Z', 'beta')];
  site.targets = [
    { token: tok(1), env: 'production', locale: 'zh' },
    { token: tok(2), env: 'sandbox', locale: 'en' },
  ];
  await worker().round();
  assert.match(site.targetQueries[0]!, /kind=release&app=demo&channel=beta/);
  const byToken = Object.fromEntries(sends.map((s) => [s.token, s]));
  assert.equal(byToken[tok(1)]!.payload.aps.alert.title, 'Demo 2.0-beta 测试版 已发布');
  assert.equal(byToken[tok(2)]!.payload.aps.alert.title, 'Demo 2.0-beta beta is available');
  assert.equal(byToken[tok(2)]!.o.env, 'sandbox');
});

test('失效 token 回报给网站；回报失败时留到下一轮重报', async () => {
  await worker().round();
  site.items = [rel('1.1', '2026-10-10T00:00:00Z')];
  site.targets = [1, 2, 3].map((n) => ({ token: tok(n), env: 'production', locale: 'zh' }));
  invalid.add(tok(2));
  site.failReport = true;
  const w = worker();
  const r1 = await w.round();
  assert.deepEqual(r1.items[0], { id: 'release:demo:1.1', targets: 3, sent: 2, failed: 1, invalid: 1 });
  assert.equal(r1.removed, 0);

  site.failReport = false;
  const r2 = await w.round();
  assert.deepEqual(site.reports.at(-1)!.invalidTokens, [tok(2)]);
  assert.equal(r2.removed, 1);
  // 报告成功后清空，不再重复上报
  await w.round();
  assert.deepEqual(site.reports.at(-1)!.invalidTokens, []);
});

test('分页推送；中途失败时下一轮从未完成的页继续，已发送的页不重复', async () => {
  await worker().round();
  site.items = [rel('1.1', '2026-10-10T00:00:00Z')];
  site.targets = Array.from({ length: 5 }, (_, i) => ({ token: tok(i + 1), env: 'production', locale: 'zh' }));
  site.pageSize = 2;
  site.failTargetsAt = 1; // 第 2 页失败

  const r1 = await worker().round();
  assert.equal(r1.errors.length, 1);
  assert.deepEqual(sends.map((s) => s.token), [tok(1), tok(2)]);
  assert.equal(state.isSent('release:demo:1.1'), false);

  site.failTargetsAt = null;
  const r2 = await worker().round(); // feed 未变（304），使用保存的 feed 继续
  assert.equal(site.feedRequests.at(-1)!.status, 304);
  assert.deepEqual(r2.errors, []);
  assert.deepEqual(sends.map((s) => s.token).sort(), [1, 2, 3, 4, 5].map(tok));
  assert.equal(r2.items[0]!.targets, 5);
  assert.equal(state.isSent('release:demo:1.1'), true);
});

test('一个条目失败不影响其他条目；失败的那轮不更新 last_ok', async () => {
  await worker().round();
  state.set('last_ok', '0');
  site.items = [rel('1.1', '2026-10-09T00:00:00Z'), rel('1.2', '2026-10-10T00:00:00Z')];
  site.targets = [{ token: tok(1), env: 'production', locale: 'zh' }];
  site.failTargetsAt = 0; // 第一个条目（时间较早的 1.1）的查询失败
  const r = await worker().round();
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!, /release:demo:1\.1/);
  assert.deepEqual(r.items.map((i) => i.id), ['release:demo:1.2']);
  assert.equal(state.get('last_ok'), '0');
});

test('重启后（新的 Worker、同一个状态文件）不重复推送', async () => {
  await worker().round();
  site.items = [rel('1.1', '2026-10-10T00:00:00Z')];
  site.targets = [{ token: tok(1), env: 'production', locale: 'zh' }];
  await worker().round();
  state.close();
  state = new State(join(dir, 'state.db'));
  state.set('feed_etag', ''); // 模拟丢失 ETag：重新下载完整 feed
  await worker().round();
  assert.equal(sends.length, 1);
});

test('不推送 push=false 的公告与超过 7 天的条目', async () => {
  await worker().round();
  site.items = [
    { ...rel('n', '2026-10-10T00:00:00Z'), id: 'news:quiet', kind: 'news', release: undefined, push: false },
    rel('old', '2026-09-01T00:00:00Z'),
  ];
  site.targets = [{ token: tok(1), env: 'production', locale: 'zh' }];
  const r = await worker().round();
  assert.deepEqual(r.items, []);
  assert.equal(sends.length, 0);
});

test('feed 版本高于支持的版本时报错，不会误推', () => {
  assert.throws(() => parseFeed('{"version":2,"items":[]}'), /版本 2/);
  assert.throws(() => parseFeed('{"items":5}'), /格式不正确/);
});

test('APNs 整体失败（密钥错误等）时不记为已推送，恢复后重试', async () => {
  await worker().round();
  site.items = [rel('1.1', '2026-10-10T00:00:00Z')];
  site.targets = [1, 2].map((n) => ({ token: tok(n), env: 'production', locale: 'zh' }));
  apnsDown = true;
  const r1 = await worker().round();
  assert.match(r1.errors[0]!, /InvalidProviderToken/);
  assert.equal(state.isSent('release:demo:1.1'), false);

  apnsDown = false;
  sends = [];
  const r2 = await worker().round();
  assert.deepEqual(r2.errors, []);
  assert.equal(sends.length, 2);
  assert.equal(state.isSent('release:demo:1.1'), true);
});

test('只有部分设备失败时照常完成（单个设备的问题不阻塞整体）', async () => {
  await worker().round();
  site.items = [rel('1.1', '2026-10-10T00:00:00Z')];
  site.targets = [1, 2].map((n) => ({ token: tok(n), env: 'production', locale: 'zh' }));
  invalid.add(tok(1));
  const r = await worker().round();
  assert.deepEqual(r.errors, []);
  assert.equal(state.isSent('release:demo:1.1'), true);
});

test('isSystemicFailure 分类', () => {
  const f = (status: number, reason?: string, invalidToken = false) => isSystemicFailure({ ok: false, status, reason, invalidToken });
  assert.equal(f(403, 'InvalidProviderToken'), true);
  assert.equal(f(429, 'TooManyRequests'), true);
  assert.equal(f(503, 'ServiceUnavailable'), true);
  assert.equal(f(0, 'ConnectionError: x'), true);
  assert.equal(f(400, 'TopicDisallowed'), true);
  assert.equal(f(410, 'Unregistered', true), false);
  assert.equal(f(400, 'BadDeviceToken', true), false);
  assert.equal(f(0, 'PayloadTooLarge'), false);
  assert.equal(isSystemicFailure({ ok: true, status: 200, invalidToken: false }), false);
});

// ---------- 推送队列（反馈回复） ----------

const job = (id: string, targets: { token: string; env: string; locale: string }[]) => ({
  id,
  kind: 'feedback_reply',
  route: { kind: 'feedback', id: `fb-${id}` },
  alert: { zh: { title: '你的反馈有新回复', body: '订阅更新失败' }, en: { title: 'New reply to your feedback', body: '订阅更新失败' } },
  targets,
});

test('队列：按设备语言发送反馈回复，确认任务并回报失效 token', async () => {
  site.jobs = [job('j1', [
    { token: tok(1), env: 'production', locale: 'zh' },
    { token: tok(2), env: 'sandbox', locale: 'en' },
  ])];
  invalid.add(tok(2));
  const r = await worker().outboxRound();
  assert.deepEqual(r, { jobs: 1, sent: 1, failed: 1, retry: 0 });
  const byToken = Object.fromEntries(sends.map((s) => [s.token, s]));
  assert.equal(byToken[tok(1)]!.payload.aps.alert.title, '你的反馈有新回复');
  assert.equal(byToken[tok(2)]!.payload.aps.alert.title, 'New reply to your feedback');
  assert.deepEqual(byToken[tok(1)]!.payload.route, { kind: 'feedback', id: 'fb-j1' });
  assert.equal(byToken[tok(1)]!.payload.aps['thread-id'], 'feedback');
  assert.equal(byToken[tok(1)]!.o.collapseId, 'feedback:fb-j1');
  assert.equal(byToken[tok(2)]!.o.env, 'sandbox');
  assert.deepEqual(site.acks, [{ ids: ['j1'], invalidTokens: [tok(2)] }]);
});

test('队列：整体性失败（密钥错误等）不确认，等租约过期重试；没有设备的任务直接确认', async () => {
  apnsDown = true;
  site.jobs = [job('down', [{ token: tok(1), env: 'production', locale: 'zh' }]), job('empty', [])];
  const r = await worker().outboxRound();
  assert.equal(r.retry, 1);
  assert.deepEqual(site.acks, [{ ids: ['empty'], invalidTokens: [] }]);
});

test('队列：没有任务时不发确认请求', async () => {
  const r = await worker().outboxRound();
  assert.deepEqual(r, { jobs: 0, sent: 0, failed: 0, retry: 0 });
  assert.deepEqual(site.acks, []);
});
