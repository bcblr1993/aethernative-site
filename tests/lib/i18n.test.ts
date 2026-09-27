import { describe, expect, it } from 'vitest';
import { fmtAgo } from '../../src/lib/i18n';

const now = Date.UTC(2026, 8, 27, 12, 0, 0);
const min = 60_000;
const hour = 60 * min;
const day = 24 * hour;

describe('fmtAgo', () => {
  it('一分钟以内显示“刚刚”', () => {
    expect(fmtAgo(now - 30_000, now, 'zh')).toBe('刚刚');
    expect(fmtAgo(now, now, 'en')).toBe('just now');
  });

  it('按分钟、小时、天取整', () => {
    expect(fmtAgo(now - 5 * min, now, 'zh')).toBe('5分钟前');
    expect(fmtAgo(now - 59 * min, now, 'en')).toBe('59 minutes ago');
    expect(fmtAgo(now - 3 * hour - 10 * min, now, 'en')).toBe('3 hours ago');
    expect(fmtAgo(now - 1 * day, now, 'en')).toBe('1 day ago');
    expect(fmtAgo(now - 29 * day, now, 'zh')).toBe('29天前');
  });

  it('30 天及以上或未来时间回落到日期', () => {
    expect(fmtAgo(now - 30 * day, now, 'zh')).toBe('2026-08-28');
    expect(fmtAgo(now + hour, now, 'en')).toBe('Sep 27, 2026');
  });
});
