import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertText, collapseId, payload, selectNew, targetQuery, type FeedItem } from '../src/notify.ts';

const NOW = Date.parse('2026-10-10T00:00:00Z');
const item = (over: Partial<FeedItem> = {}): FeedItem => ({
  id: 'release:aetherroute:1.1.0',
  kind: 'release',
  date: '2026-10-09T00:00:00.000Z',
  title: { zh: 'AetherRoute 1.1.0', en: 'AetherRoute 1.1.0' },
  summary: { zh: '全新液态玻璃界面', en: 'A new Liquid Glass design' },
  push: true,
  release: { appId: 'aetherroute', version: '1.1.0', channel: 'stable' },
  ...over,
});

test('targetQuery：公告、正式版、测试版；不推送 push=false、技术预览与未知类型', () => {
  assert.deepEqual(targetQuery(item({ kind: 'news', release: undefined })), { kind: 'news' });
  assert.deepEqual(targetQuery(item()), { kind: 'release', app: 'aetherroute', channel: 'stable' });
  assert.deepEqual(targetQuery(item({ release: { appId: 'x', version: '1', channel: 'beta' } })), { kind: 'release', app: 'x', channel: 'beta' });
  assert.equal(targetQuery(item({ push: false })), null);
  assert.equal(targetQuery(item({ release: { appId: 'x', version: '1', channel: 'preview' } })), null);
  assert.equal(targetQuery(item({ kind: 'video' })), null);
});

test('selectNew：跳过已推送和超过 7 天的条目，按时间正序', () => {
  const items = [
    item({ id: 'b', date: '2026-10-09T00:00:00Z' }),
    item({ id: 'a', date: '2026-10-05T00:00:00Z' }),
    item({ id: 'old', date: '2026-09-01T00:00:00Z' }),
    item({ id: 'sent', date: '2026-10-08T00:00:00Z' }),
    item({ id: 'nopush', push: false }),
  ];
  assert.deepEqual(selectNew(items, (id) => id === 'sent', NOW).map((i) => i.id), ['a', 'b']);
});

test('通知文案：正式版 / 测试版 / 公告，中英文', () => {
  assert.deepEqual(alertText(item(), 'zh'), { title: 'AetherRoute 1.1.0 已发布', body: '全新液态玻璃界面' });
  assert.deepEqual(alertText(item(), 'en'), { title: 'AetherRoute 1.1.0 is available', body: 'A new Liquid Glass design' });
  const beta = item({ release: { appId: 'aetherroute', version: '1.2.0-beta', channel: 'beta' } });
  assert.equal(alertText(beta, 'zh').title, 'AetherRoute 1.1.0 测试版 已发布');
  assert.equal(alertText(beta, 'en').title, 'AetherRoute 1.1.0 beta is available');
  const news = item({ kind: 'news', title: { zh: '公告', en: 'News' }, release: undefined });
  assert.deepEqual(alertText(news, 'en'), { title: 'News', body: 'A new Liquid Glass design' });
});

test('简介与标题相同或为空时，正文换成通用提示；过长时截断', () => {
  const same = item({ summary: { zh: 'AetherRoute 1.1.0', en: '' } });
  assert.equal(alertText(same, 'zh').body, '点击查看更新说明');
  assert.equal(alertText(same, 'en').body, 'Tap to see what’s new');
  const long = alertText(item({ summary: { zh: '字'.repeat(500), en: 'x' } }), 'zh').body;
  assert.equal([...long].length, 180);
  assert.ok(long.endsWith('…'));
});

test('payload：跳转信息与按软件分组', () => {
  assert.deepEqual(payload(item(), 'zh'), {
    aps: { alert: { title: 'AetherRoute 1.1.0 已发布', body: '全新液态玻璃界面' }, sound: 'default', 'thread-id': 'app:aetherroute' },
    route: { kind: 'release', appId: 'aetherroute', releaseId: 'release:aetherroute:1.1.0' },
  });
  const news = payload(item({ id: 'news:x', kind: 'news', release: undefined }), 'en');
  assert.deepEqual(news.route, { kind: 'news', id: 'news:x' });
  assert.equal(news.aps['thread-id'], 'news');
});

test('collapseId 不超过 64 字节', () => {
  assert.equal(collapseId('release:a:1'), 'release:a:1');
  const long = collapseId('release:' + 'a'.repeat(80) + ':1.0.0');
  assert.equal(long.length, 64);
  assert.match(long, /^[0-9a-f]{64}$/);
});
