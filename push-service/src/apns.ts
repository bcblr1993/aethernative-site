// APNs 发送器：HTTP/2 + Token（.p8）认证。只用 Node 内置模块。
// 文档：https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
import { connect, type ClientHttp2Session, type OutgoingHttpHeaders } from 'node:http2';
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';

export type ApnsEnv = 'production' | 'sandbox';

export const APNS_ORIGINS: Record<ApnsEnv, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

export interface ApnsOptions {
  /** .p8 文件内容（PEM） */
  key: string;
  keyId: string;
  teamId: string;
  /** App 的 Bundle ID */
  topic: string;
  /** 测试用：替换 APNs 地址 */
  origins?: Partial<Record<ApnsEnv, string>>;
  /** 测试用：当前时间（毫秒） */
  now?: () => number;
  /** 单次请求超时，默认 10 秒 */
  timeoutMs?: number;
}

export interface SendOptions {
  env: ApnsEnv;
  pushType?: 'alert' | 'background';
  /** 10 立即送达；5 省电送达（background 推送必须是 5） */
  priority?: 5 | 10;
  /** 过期时间（Unix 秒）；0 表示只尝试送达一次 */
  expiration?: number;
  /** 相同 collapseId 的通知在设备上只保留最新一条（最长 64 字节） */
  collapseId?: string;
}

export interface SendResult {
  ok: boolean;
  status: number;
  apnsId?: string;
  reason?: string;
  /** token 已失效或不属于这个 App / 环境，应从数据库删除 */
  invalidToken: boolean;
}

/**
 * Apple 要求：认证 token 至少每 60 分钟更换一次，但更换不能比每 20 分钟一次更频繁，
 * 否则返回 TooManyProviderTokenUpdates。这里固定 50 分钟更换。
 */
const TOKEN_TTL_MS = 50 * 60_000;
const DEVICE_TOKEN = /^[0-9a-f]{64,200}$/i;
const INVALID_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export class ApnsClient {
  #key: KeyObject;
  #opts: ApnsOptions;
  #now: () => number;
  #jwt?: { value: string; issuedAt: number };
  #sessions = new Map<ApnsEnv, ClientHttp2Session>();

  constructor(opts: ApnsOptions) {
    if (!/^[A-Z0-9]{10}$/.test(opts.keyId)) throw new Error('APNs Key ID 应为 10 位大写字母或数字');
    if (!/^[A-Z0-9]{10}$/.test(opts.teamId)) throw new Error('Team ID 应为 10 位大写字母或数字');
    this.#key = createPrivateKey(opts.key);
    if (this.#key.asymmetricKeyType !== 'ec') throw new Error('APNs 密钥应为 .p8（EC P-256）私钥');
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
  }

  /** ES256 签名的认证 token，缓存 50 分钟。 */
  authToken(force = false) {
    const now = this.#now();
    if (!force && this.#jwt && now - this.#jwt.issuedAt < TOKEN_TTL_MS) return this.#jwt.value;
    const header = b64url(JSON.stringify({ alg: 'ES256', kid: this.#opts.keyId }));
    const claims = b64url(JSON.stringify({ iss: this.#opts.teamId, iat: Math.floor(now / 1000) }));
    const sig = sign('sha256', Buffer.from(`${header}.${claims}`), { key: this.#key, dsaEncoding: 'ieee-p1363' });
    this.#jwt = { value: `${header}.${claims}.${b64url(sig)}`, issuedAt: now };
    return this.#jwt.value;
  }

  async send(deviceToken: string, payload: object, o: SendOptions): Promise<SendResult> {
    if (!DEVICE_TOKEN.test(deviceToken)) return { ok: false, status: 0, reason: 'BadDeviceToken', invalidToken: true };
    const body = JSON.stringify(payload);
    // 普通通知上限 4KB
    if (Buffer.byteLength(body) > 4096) return { ok: false, status: 0, reason: 'PayloadTooLarge', invalidToken: false };

    let r = await this.#request(deviceToken, body, o, this.authToken());
    // token 过期（例如机器休眠后时钟跳变）：换一个 token 重试一次
    if (r.status === 403 && r.reason === 'ExpiredProviderToken') {
      r = await this.#request(deviceToken, body, o, this.authToken(true));
    }
    return r;
  }

  close() {
    for (const s of this.#sessions.values()) s.close();
    this.#sessions.clear();
  }

  #session(env: ApnsEnv) {
    const cur = this.#sessions.get(env);
    if (cur && !cur.closed && !cur.destroyed) return cur;
    const s = connect(this.#opts.origins?.[env] ?? APNS_ORIGINS[env]);
    // 连接出错或被对端关闭（GOAWAY）后丢弃，下次请求重新连接
    const drop = () => this.#sessions.get(env) === s && this.#sessions.delete(env);
    s.on('error', drop).on('close', drop).on('goaway', drop);
    // 不调用 unref()：unref 后进行中的请求不会阻止进程退出。用完由调用方 close()
    this.#sessions.set(env, s);
    return s;
  }

  #request(deviceToken: string, body: string, o: SendOptions, jwt: string) {
    const pushType = o.pushType ?? 'alert';
    const headers: OutgoingHttpHeaders = {
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': this.#opts.topic,
      'apns-push-type': pushType,
      'apns-priority': String(o.priority ?? (pushType === 'background' ? 5 : 10)),
      'content-type': 'application/json',
    };
    if (o.expiration !== undefined) headers['apns-expiration'] = String(o.expiration);
    if (o.collapseId) headers['apns-collapse-id'] = o.collapseId;

    return new Promise<SendResult>((resolve) => {
      let req;
      try {
        req = this.#session(o.env).request(headers);
      } catch (e) {
        resolve({ ok: false, status: 0, reason: `ConnectionError: ${(e as Error).message}`, invalidToken: false });
        return;
      }
      let status = 0;
      let apnsId: string | undefined;
      const chunks: Buffer[] = [];
      req.setTimeout(this.#opts.timeoutMs ?? 10_000, () => req.close());
      req.on('response', (h) => {
        status = Number(h[':status']);
        apnsId = h['apns-id'] as string | undefined;
      });
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('error', (e) => resolve({ ok: false, status, reason: `ConnectionError: ${e.message}`, invalidToken: false }));
      req.on('close', () => {
        if (!status) return resolve({ ok: false, status: 0, reason: 'Timeout', invalidToken: false });
        let reason: string | undefined;
        if (chunks.length) {
          try {
            reason = JSON.parse(Buffer.concat(chunks).toString('utf8')).reason;
          } catch {
            reason = 'UnparsableResponse';
          }
        }
        resolve({
          ok: status === 200,
          status,
          apnsId,
          reason,
          invalidToken: status === 410 || (reason !== undefined && INVALID_REASONS.has(reason)),
        });
      });
      req.end(body);
    });
  }
}
