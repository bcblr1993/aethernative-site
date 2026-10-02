import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Http2Server, type IncomingHttpHeaders } from 'node:http2';
import { generateKeyPairSync, verify } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ApnsClient } from '../src/apns.ts';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const TOKEN = 'a'.repeat(64);
const base = { key: KEY, keyId: 'ABC123DEFG', teamId: 'TEAM123456', topic: 'com.aethernative.app' };

type Reply = { status: number; body?: object; headers?: Record<string, string> };

/** 本地明文 HTTP/2 服务器，模拟 APNs。按顺序返回 replies，记录收到的请求。 */
async function fakeApns(replies: Reply[]) {
  const seen: { headers: IncomingHttpHeaders; body: string }[] = [];
  const server: Http2Server = createServer();
  server.on('stream', (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => {
      seen.push({ headers, body: Buffer.concat(chunks).toString() });
      const r = replies.shift() ?? { status: 200 };
      stream.respond({ ':status': r.status, 'apns-id': 'id-' + seen.length, ...r.headers });
      stream.end(r.body ? JSON.stringify(r.body) : undefined);
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { seen, origin, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

function decodeJwt(jwt: string) {
  const [h, c, s] = jwt.split('.');
  const ok = verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  return { header: JSON.parse(Buffer.from(h, 'base64url').toString()), claims: JSON.parse(Buffer.from(c, 'base64url').toString()), ok };
}

test('认证 token：ES256 签名、包含 kid / iss / iat，50 分钟内复用', () => {
  let now = 1_700_000_000_000;
  const c = new ApnsClient({ ...base, now: () => now });
  const t1 = c.authToken();
  const d = decodeJwt(t1);
  assert.equal(d.ok, true);
  assert.deepEqual(d.header, { alg: 'ES256', kid: 'ABC123DEFG' });
  assert.deepEqual(d.claims, { iss: 'TEAM123456', iat: 1_700_000_000 });

  now += 49 * 60_000;
  assert.equal(c.authToken(), t1);
  now += 2 * 60_000;
  const t2 = c.authToken();
  assert.notEqual(t2, t1);
  assert.equal(decodeJwt(t2).claims.iat, Math.floor(now / 1000));
});

test('配置校验：Key ID / Team ID 格式错误、非 EC 密钥直接报错', () => {
  assert.throws(() => new ApnsClient({ ...base, keyId: 'short' }), /Key ID/);
  assert.throws(() => new ApnsClient({ ...base, teamId: 'lower12345' }), /Team ID/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  assert.throws(() => new ApnsClient({ ...base, key: rsa }), /EC P-256/);
});

test('发送：路径、请求头与正文符合 APNs 要求', async () => {
  const s = await fakeApns([{ status: 200 }]);
  const c = new ApnsClient({ ...base, origins: { sandbox: s.origin } });
  try {
    const r = await c.send(TOKEN, { aps: { alert: 'hi' } }, { env: 'sandbox', collapseId: 'news:1', expiration: 0 });
    assert.deepEqual(r, { ok: true, status: 200, apnsId: 'id-1', reason: undefined, invalidToken: false });
    const { headers, body } = s.seen[0];
    assert.equal(headers[':method'], 'POST');
    assert.equal(headers[':path'], `/3/device/${TOKEN}`);
    assert.equal(headers['apns-topic'], 'com.aethernative.app');
    assert.equal(headers['apns-push-type'], 'alert');
    assert.equal(headers['apns-priority'], '10');
    assert.equal(headers['apns-collapse-id'], 'news:1');
    assert.equal(headers['apns-expiration'], '0');
    assert.match(String(headers.authorization), /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    assert.deepEqual(JSON.parse(body), { aps: { alert: 'hi' } });
  } finally {
    c.close();
    await s.close();
  }
});

test('失效 token：410 Unregistered 与 400 BadDeviceToken 标记为 invalidToken', async () => {
  const s = await fakeApns([
    { status: 410, body: { reason: 'Unregistered', timestamp: 1 } },
    { status: 400, body: { reason: 'BadDeviceToken' } },
    { status: 429, body: { reason: 'TooManyRequests' } },
  ]);
  const c = new ApnsClient({ ...base, origins: { production: s.origin } });
  try {
    const a = await c.send(TOKEN, {}, { env: 'production' });
    assert.equal(a.invalidToken, true);
    assert.equal(a.reason, 'Unregistered');
    const b = await c.send(TOKEN, {}, { env: 'production' });
    assert.equal(b.invalidToken, true);
    const d = await c.send(TOKEN, {}, { env: 'production' });
    assert.deepEqual([d.ok, d.invalidToken, d.reason], [false, false, 'TooManyRequests']);
  } finally {
    c.close();
    await s.close();
  }
});

test('ExpiredProviderToken：换新 token 重试一次', async () => {
  const s = await fakeApns([{ status: 403, body: { reason: 'ExpiredProviderToken' } }, { status: 200 }]);
  let now = 1_700_000_000_000;
  const c = new ApnsClient({ ...base, now: () => (now += 1000), origins: { production: s.origin } });
  try {
    const r = await c.send(TOKEN, {}, { env: 'production' });
    assert.equal(r.ok, true);
    assert.equal(s.seen.length, 2);
    assert.notEqual(s.seen[0].headers.authorization, s.seen[1].headers.authorization);
  } finally {
    c.close();
    await s.close();
  }
});

test('本地拦截：格式错误的 token 与超过 4KB 的正文不发请求', async () => {
  const c = new ApnsClient({ ...base, origins: { production: 'http://127.0.0.1:1' } });
  assert.deepEqual(await c.send('not-hex', {}, { env: 'production' }), {
    ok: false, status: 0, reason: 'BadDeviceToken', invalidToken: true,
  });
  const big = await c.send(TOKEN, { x: 'y'.repeat(5000) }, { env: 'production' });
  assert.deepEqual([big.ok, big.reason, big.invalidToken], [false, 'PayloadTooLarge', false]);
});

test('连接失败：返回 ConnectionError，不抛异常', async () => {
  const c = new ApnsClient({ ...base, origins: { production: 'http://127.0.0.1:1' }, timeoutMs: 2000 });
  const r = await c.send(TOKEN, {}, { env: 'production' });
  assert.equal(r.ok, false);
  assert.equal(r.invalidToken, false);
  assert.match(r.reason ?? '', /ConnectionError|Timeout/);
  c.close();
});
