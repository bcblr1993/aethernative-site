// 访问 aethernative.com：读取 feed.json（带 ETag），查询推送目标，回报失效 token 与心跳。
import type { FeedItem, Locale, TargetQuery } from './notify.ts';
import type { ApnsEnv } from './apns.ts';

export interface Target {
  token: string;
  env: ApnsEnv;
  locale: Locale;
}

export interface Feed {
  version: number;
  items: FeedItem[];
}

/** 本服务支持的 feed 版本；网站升级数据结构后需要同步更新推送服务。 */
export const SUPPORTED_FEED_VERSION = 1;

export class SiteClient {
  #base: string;
  #token: string;
  #timeoutMs: number;

  constructor(base: string, serviceToken: string, timeoutMs = 15_000) {
    this.#base = base.replace(/\/+$/, '');
    this.#token = serviceToken;
    this.#timeoutMs = timeoutMs;
  }

  /** 内容没变时返回 null（304）。 */
  async feed(etag: string | null): Promise<{ feed: Feed; etag: string | null; body: string } | null> {
    const r = await this.#fetch('/feed.json', { headers: etag ? { 'If-None-Match': etag } : {} });
    if (r.status === 304) return null;
    if (!r.ok) throw new Error(`读取 feed.json 失败：HTTP ${r.status}`);
    const body = await r.text();
    return { feed: parseFeed(body), etag: r.headers.get('ETag'), body };
  }

  async targets(q: TargetQuery, cursor: string): Promise<{ targets: Target[]; next: string | null }> {
    const p = new URLSearchParams(q.kind === 'news' ? { kind: 'news' } : { kind: 'release', app: q.app, channel: q.channel });
    if (cursor) p.set('cursor', cursor);
    const r = await this.#fetch(`/api/admin/push-targets?${p}`, { headers: this.#auth() });
    if (!r.ok) throw new Error(`查询推送目标失败：HTTP ${r.status}`);
    return (await r.json()) as { targets: Target[]; next: string | null };
  }

  async report(invalidTokens: string[], status: object) {
    const r = await this.#fetch('/api/admin/push-report', {
      method: 'POST',
      headers: { ...this.#auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ invalidTokens, status }),
    });
    if (!r.ok) throw new Error(`回报失败：HTTP ${r.status}`);
    return (await r.json()) as { removed: number };
  }

  #auth() {
    return { Authorization: `Bearer ${this.#token}` };
  }

  #fetch(path: string, init: RequestInit) {
    return fetch(this.#base + path, { ...init, signal: AbortSignal.timeout(this.#timeoutMs) });
  }
}

export function parseFeed(body: string): Feed {
  const feed = JSON.parse(body) as Feed;
  if (typeof feed?.version !== 'number' || !Array.isArray(feed.items)) throw new Error('feed.json 格式不正确');
  if (feed.version > SUPPORTED_FEED_VERSION) throw new Error(`feed.json 版本 ${feed.version} 高于推送服务支持的 ${SUPPORTED_FEED_VERSION}，请更新推送服务`);
  return feed;
}
