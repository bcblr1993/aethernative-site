import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createD1 } from './d1';
import { onRequest as download } from '../../functions/api/download/[app]/[version]';
import { onRequestGet as stats } from '../../functions/api/admin/downloads';
import { beijingDay, downloadRange, recordDownload, safeDownloadTarget } from '../../functions/_lib/downloads';
import { createSession, upsertUser } from '../../functions/_lib/session';
import { buildDownloadReport, downloadCSV } from '../../src/lib/download-report';
const target = 'https://github.com/bcblr1993/AetherRoute/releases/download/v1.4.2/AetherRoute.dmg';
let env: any;
let pending: Promise<unknown>[];
beforeEach(() => {
  pending = [];
  env = { DB: createD1(), ASSETS: { fetch: vi.fn(async () => new Response(JSON.stringify({ aetherroute: { '1.4.2': target } }))) } };
});
async function request(method = 'GET', headers: Record<string, string> = {}, params: Record<string, string> = { app: 'aetherroute', version: '1.4.2' }) {
  const response = await download({ request: new Request('https://aethernative.com/api/download/aetherroute/1.4.2', {
    method, headers: { 'User-Agent': 'Mozilla/5.0 Safari/604.1', ...headers },
  }), env, params, waitUntil: (p: Promise<unknown>) => pending.push(p) } as any);
  await Promise.all(pending);
  return response;
}
const count = () => env.DB.raw.prepare('SELECT SUM(requests) AS n FROM download_daily').get().n;
async function cookie(admin: boolean) {
  const user = await upsertUser(env.DB, { provider: 'google', id: 'test', name: 'Test', email: null, avatarUrl: null });
  if (admin) env.DB.raw.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
  return (await createSession(env.DB, user.id, 'test')).map((c) => c.split(';')[0]).join('; ');
}
const getStats = (c = '', q = '') => stats({ env, request: new Request(`https://aethernative.com/api/admin/downloads?${q}`, { headers: { Cookie: c } }) } as any);

describe('download initiations', () => {
  it('redirects exactly to the approved asset; repeated requests atomically increment one aggregate', async () => {
    const a = await request(); await request();
    expect(a.status).toBe(302); expect(a.headers.get('Location')).toBe(target);
    expect(a.headers.get('Cache-Control')).toBe('no-store'); expect(count()).toBe(2);
    expect(env.DB.raw.prepare('SELECT * FROM download_daily').all()).toEqual([{ day: beijingDay(), app_id: 'aetherroute', version: '1.4.2', requests: 2 }]);
  });
  it.each([
    ['HEAD', {}], ['GET', { Purpose: 'prefetch' }], ['GET', { 'Sec-Purpose': 'prefetch;prerender' }],
    ['GET', { 'User-Agent': 'Googlebot' }], ['GET', { 'User-Agent': 'meta-externalagent/1.1' }],
    ['GET', { 'User-Agent': '' }], ['GET', { 'User-Agent': 'curl/8.0' }],
  ])('does not count automation %s %j but still redirects', async (method, headers) => {
    expect((await request(method, headers)).status).toBe(302); expect(count()).toBeNull();
  });
  it('rejects unknown versions, prototype keys, traversal and non-read methods', async () => {
    for (const params of [{ app: '../x', version: '1.4.2' }, { app: 'aetherroute', version: 'missing' }, { app: 'constructor', version: 'name' }]) {
      expect((await request('GET', {}, params)).status).toBe(404);
    }
    expect((await request('POST')).status).toBe(405); expect(count()).toBeNull();
  });
  it('never becomes an open redirect', () => {
    for (const bad of ['https://evil.example/file.dmg', 'http://github.com/a/b/releases/download/v1/a',
      'https://github.com.evil.example/a/b/releases/download/v1/a', 'https://user@github.com/a/b/releases/download/v1/a',
      'https://github.com/a/b/releases/download/v1/a?x=1', 'https://github.com/a/b/releases/tag/v1']) expect(safeDownloadTarget(bad)).toBeNull();
    expect(safeDownloadTarget(target)).toBe(target);
    expect(safeDownloadTarget('/downloads/AetherSwitch-1.0.0-arm64.dmg')).toBe('/downloads/AetherSwitch-1.0.0-arm64.dmg');
    for (const bad of ['//evil.example/file.dmg', '/api/auth/logout', '/downloads/../file.dmg', '/downloads/%2fsecret.dmg']) expect(safeDownloadTarget(bad)).toBeNull();
  });
  it('does not block downloads when the statistics DB fails, and exposes no exception contents', async () => {
    env.DB = { prepare: () => { throw new Error('private information'); } };
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await request()).status).toBe(302);
    expect(log).toHaveBeenCalledWith('download_daily_write_failed'); log.mockRestore();
  });
  it('fails explicitly if the deployment catalog cannot be read', async () => {
    env.ASSETS.fetch = async () => new Response('unavailable', { status: 500 });
    expect((await request()).status).toBe(503); expect(count()).toBeNull();
  });
  it('separates days at midnight Beijing time and isolates apps and versions', async () => {
    await recordDownload(env.DB, 'aetherroute', '1', Date.parse('2026-10-09T15:59:59Z'));
    await recordDownload(env.DB, 'aetherroute', '2', Date.parse('2026-10-09T16:00:00Z'));
    await recordDownload(env.DB, 'apexterm', '2', Date.parse('2026-10-09T16:00:00Z'));
    expect(env.DB.raw.prepare('SELECT day, app_id, version FROM download_daily ORDER BY day, app_id').all()).toEqual([
      { day: '2026-10-09', app_id: 'aetherroute', version: '1' },
      { day: '2026-10-10', app_id: 'aetherroute', version: '2' },
      { day: '2026-10-10', app_id: 'apexterm', version: '2' },
    ]);
  });
});
describe('private daily report', () => {
  it('requires an authenticated admin', async () => {
    expect((await getStats()).status).toBe(401);
    expect((await getStats(await cookie(false))).status).toBe(403);
  });
  it('sums versions for an app, filters apps and never caches private data', async () => {
    await recordDownload(env.DB, 'aetherroute', '1'); await recordDownload(env.DB, 'aetherroute', '2');
    await recordDownload(env.DB, 'apexterm', '1');
    const response = await getStats(await cookie(true), 'app=aetherroute');
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ timezone: 'Asia/Shanghai', metric: 'download_initiations',
      rows: [{ day: beijingDay(), app_id: 'aetherroute', requests: 2 }] });
  });
  it('rejects impossible dates, future dates, SQL-like apps, reversed and excessive ranges', () => {
    const now = Date.parse('2026-10-10T10:00:00Z');
    for (const q of ['from=2026-02-30', 'to=2027-01-01', 'app=x%27OR1', 'from=2026-10-09&to=2026-10-08', 'from=2020-01-01'])
      expect(downloadRange(new URLSearchParams(q), now)).toBeNull();
  });
  it('shows unavailable history separately from measured zero and preserves totals in CSV', () => {
    const data = { from: '2026-10-08', to: '2026-10-10', app: '', startedAt: Date.parse('2026-10-09T09:00Z'),
      rows: [{ day: '2026-10-10', app_id: 'aetherroute', requests: 2 }] };
    const report = buildDownloadReport(data, [{ id: 'aetherroute', name: 'AetherRoute' }]);
    expect(report.days).toEqual([{ day: '2026-10-10', requests: 2 }, { day: '2026-10-09', requests: 0 }, { day: '2026-10-08', requests: null }]);
    expect(report.total).toBe(2); expect(downloadCSV(report, data)).toContain('"2026-10-08","AetherRoute","","尚未统计"');
  });
});
