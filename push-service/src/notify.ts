// 推送什么、推给谁、通知长什么样。纯函数，不做网络请求。数据结构见 ../docs/api.md。
import { createHash } from 'node:crypto';

export type Bi = { zh: string; en: string };
export type Locale = 'zh' | 'en';

export interface FeedItem {
  id: string;
  kind: string;
  date: string;
  title: Bi;
  summary: Bi;
  push: boolean;
  release?: { appId: string; version: string; channel: string };
}

export type TargetQuery = { kind: 'news' } | { kind: 'release'; app: string; channel: 'stable' | 'beta' };

/** 超过这个时间的条目不再推送（服务停机很久后恢复、状态丢失重建时，避免推送旧内容） */
export const MAX_AGE_MS = 7 * 86_400_000;
/** 通知在 APNs 上的保留时间：设备离线超过这么久就不再送达 */
export const EXPIRE_SECONDS = 3 * 86_400;

/** 该条目推给哪些设备；不应推送的返回 null。 */
export function targetQuery(item: FeedItem): TargetQuery | null {
  if (!item.push) return null;
  if (item.kind === 'news') return { kind: 'news' };
  const r = item.release;
  if (item.kind === 'release' && r && (r.channel === 'stable' || r.channel === 'beta')) {
    return { kind: 'release', app: r.appId, channel: r.channel };
  }
  return null;
}

/** 需要推送的条目：应推送、未推送过、未过期。按时间正序，让通知按发布顺序到达。 */
export function selectNew(items: FeedItem[], isSent: (id: string) => boolean, now = Date.now(), maxAgeMs = MAX_AGE_MS) {
  return items
    .filter((i) => targetQuery(i) && !isSent(i.id) && now - Date.parse(i.date) <= maxAgeMs)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

const BODY_MAX = 180;
const clip = (s: string) => ([...s].length > BODY_MAX ? [...s].slice(0, BODY_MAX - 1).join('') + '…' : s);

export function alertText(item: FeedItem, locale: Locale) {
  const title = item.title[locale];
  const summary = item.summary[locale].trim();
  const beta = item.release?.channel === 'beta';
  if (item.kind === 'release') {
    return {
      title: locale === 'zh' ? `${title}${beta ? ' 测试版' : ''} 已发布` : `${title}${beta ? ' beta' : ''} is available`,
      // 同步时 Release 正文没写简介会用标题代替，这时换成通用提示
      body: summary && summary !== title ? clip(summary) : locale === 'zh' ? '点击查看更新说明' : 'Tap to see what’s new',
    };
  }
  return { title, body: clip(summary) };
}

/** apns-collapse-id 最长 64 字节：同一条目在设备上只保留一条通知（重复发送时也只显示一次）。 */
export function collapseId(id: string) {
  return Buffer.byteLength(id) <= 64 ? id : createHash('sha256').update(id).digest('hex');
}

/** 通知内容。route 供 App 点开通知后跳转（见 iOS 的 NotificationRoute）。 */
export function payload(item: FeedItem, locale: Locale) {
  const route =
    item.kind === 'release' && item.release
      ? { kind: 'release', appId: item.release.appId, releaseId: item.id }
      : { kind: 'news', id: item.id };
  return {
    aps: {
      alert: alertText(item, locale),
      sound: 'default',
      // 通知中心按软件分组
      'thread-id': item.release ? `app:${item.release.appId}` : 'news',
    },
    route,
  };
}
