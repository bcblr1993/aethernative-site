import { describe, expect, it } from 'vitest';
import { createD1 } from './d1';
import { recordDownload } from '../../functions/_lib/downloads';
import { onRequestGet } from '../../functions/api/downloads';

const get = (DB: unknown) => onRequestGet({ env: { DB } } as any);

describe('public download totals', () => {
  it('anonymously sums all dates and versions while isolating apps', async () => {
    const db = createD1();
    await recordDownload(db, 'aetherroute', '1', Date.parse('2026-10-10T00:00Z'));
    await recordDownload(db, 'aetherroute', '2', Date.parse('2026-10-25T00:00Z'));
    await recordDownload(db, 'aetherkey', '1');
    const response = await get(db);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(await response.json()).toEqual({ metric: 'download_initiations', startedAt: expect.any(Number),
      apps: [{ appId: 'aetherkey', total: 1 }, { appId: 'aetherroute', total: 2 }] });
  });
  it('distinguishes an empty measured dataset from unavailable statistics', async () => {
    const db = createD1();
    expect(await (await get(db)).json()).toMatchObject({ apps: [], startedAt: expect.any(Number) });
    db.raw.exec('DELETE FROM download_stats_meta');
    expect((await get(db)).status).toBe(503);
  });
  it('returns an uncached generic failure without exposing database details', async () => {
    const response = await get({ prepare() { throw new Error('private database details'); } });
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'download_stats_unavailable' });
  });
});
