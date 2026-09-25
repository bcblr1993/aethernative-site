import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  buildEntry, compareVersions, detectBuild, detectVersion, findInAppcast, parseSiteBlock,
  parseSparkleLine, pickAsset, upsertRelease, verifySparkleSignature,
} from './release-sync.mjs';

const SIG = 'A'.repeat(86) + '==';

describe('parseSiteBlock', () => {
  it('读取隐藏区块中的 YAML，忽略正文其他内容', () => {
    const body = `# 内部验收记录\n路径 /Users/x、主机 100.64.0.3\n\n<!-- aethernative\nsummary:\n  zh: 修复若干问题\n  en: Bug fixes\nbuild: 42\n-->\n`;
    expect(parseSiteBlock(body)).toEqual({ summary: { zh: '修复若干问题', en: 'Bug fixes' }, build: 42 });
  });
  it('没有区块返回 null', () => expect(parseSiteBlock('只是普通说明')).toBeNull());
  it('YAML 写错时给出明确错误', () => {
    expect(() => parseSiteBlock('<!-- aethernative\nsummary: [未闭合\n-->')).toThrow(/不是合法的 YAML/);
  });
});

describe('parseSparkleLine', () => {
  it('解析 sign_update 输出，顺序不限', () => {
    expect(parseSparkleLine(`sparkle:edSignature="${SIG}" length="123"`)).toEqual({ edSignature: SIG, length: 123 });
    expect(parseSparkleLine(`length="9" sparkle:edSignature="${SIG}"`)).toEqual({ edSignature: SIG, length: 9 });
  });
  it('缺字段返回 null', () => expect(parseSparkleLine('length="9"')).toBeNull());
});

describe('findInAppcast', () => {
  const xml = `<rss><channel>
    <item><sparkle:version>200</sparkle:version><sparkle:shortVersionString>1.1</sparkle:shortVersionString>
      <enclosure url="x" sparkle:edSignature="${SIG}" length="55" type="application/octet-stream" /></item>
    <item><sparkle:version>100</sparkle:version><sparkle:shortVersionString>1.0</sparkle:shortVersionString>
      <enclosure url="y" sparkle:edSignature="${SIG}" length="44" /></item>
  </channel></rss>`;
  it('按版本号找到对应条目', () => expect(findInAppcast(xml, '1.0')).toEqual({ edSignature: SIG, length: 44, build: '100' }));
  it('找不到返回 null', () => expect(findInAppcast(xml, '2.0')).toBeNull());
});

describe('pickAsset', () => {
  const a = (name) => ({ name });
  it('优先 dmg，其次 zip；同类型优先 arm64', () => {
    expect(pickAsset([a('SHA256SUMS'), a('App.zip'), a('App-x86_64.dmg'), a('App-arm64.dmg')]).name).toBe('App-arm64.dmg');
    expect(pickAsset([a('SHA256SUMS'), a('App.zip')]).name).toBe('App.zip');
  });
  it('没有安装包返回 null', () => expect(pickAsset([a('SHA256SUMS'), a('notes.txt')])).toBeNull());
});

describe('detectBuild / detectVersion', () => {
  it('构建号优先级：区块 > appcast > 文件名 > 标题', () => {
    expect(detectBuild({ block: { build: 7 }, appcast: { build: '8' }, assetName: 'A-build-9.dmg' })).toBe('7');
    expect(detectBuild({ appcast: { build: '8' }, assetName: 'A-build-9.dmg' })).toBe('8');
    expect(detectBuild({ assetName: 'A-1.0-build-2026092402-arm64.dmg' })).toBe('2026092402');
    expect(detectBuild({ assetName: 'A.dmg', title: 'App 1.2 (Build 345)' })).toBe('345');
    expect(detectBuild({ assetName: 'A.dmg', title: 'App 1.2' })).toBeUndefined();
  });
  it('版本号去掉标签前缀 v，区块可覆盖', () => {
    expect(detectVersion('v1.0.27')).toBe('1.0.27');
    expect(detectVersion('1.2')).toBe('1.2');
    expect(detectVersion('release-5', { version: '5.0' })).toBe('5.0');
  });
});

describe('compareVersions', () => {
  it('按数字比较各段', () => {
    expect(compareVersions('1.0.10', '1.0.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2', '1.10')).toBeLessThan(0);
    expect(compareVersions('1.0', '1.0')).toBe(0);
  });
});

describe('verifySparkleSignature', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
  const data = Buffer.from('fake dmg bytes');
  const sig = sign(null, data, privateKey).toString('base64');
  it('正确签名通过，改动文件或签名均失败', () => {
    expect(verifySparkleSignature(data, sig, pub)).toBe(true);
    expect(verifySparkleSignature(Buffer.from('tampered'), sig, pub)).toBe(false);
    const bad = Buffer.from(sig, 'base64'); bad[0] ^= 1;
    expect(verifySparkleSignature(data, bad.toString('base64'), pub)).toBe(false);
  });
  it('公钥格式错误时报错', () => expect(() => verifySparkleSignature(data, sig, 'abc=')).toThrow(/32 字节/));
});

describe('buildEntry', () => {
  const release = { tag_name: 'v2.0', name: 'App 2.0', published_at: '2026-10-01T08:00:00Z', prerelease: true, html_url: 'https://gh/r/v2.0' };
  const asset = { browser_download_url: 'https://gh/d/App.dmg', size: 10 };
  it('prerelease 记为 beta；没有区块时不带 summary', () => {
    const e = buildEntry({ release, asset, sha256: 'f'.repeat(64) });
    expect(e).toMatchObject({ version: '2.0', date: '2026-10-01', channel: 'beta', download: asset.browser_download_url });
    expect(e.summary).toBeUndefined();
  });
  it('带上区块中的说明与签名', () => {
    const e = buildEntry({ release, asset, block: { channel: 'stable', summary: { zh: '甲', en: 'A' }, minimumSystemVersion: 14 }, sparkle: { edSignature: SIG, length: 10 }, build: '5' });
    expect(e).toMatchObject({ channel: 'stable', build: '5', summary: { zh: '甲', en: 'A' }, sparkle: { edSignature: SIG, length: 10, minimumSystemVersion: '14' } });
  });
});

describe('upsertRelease', () => {
  const base = `# 注释会被保留\nreleases:\n  - version: "1.10"\n    date: 2026-09-20\n    badge: 手工填写\n    summary:\n      zh: 旧说明\n      en: Old\n  - version: "1.9"\n    date: 2026-09-10\n    summary: s\n`;
  const entry = (over) => ({ version: '1.11', date: '2026-09-25', channel: 'stable', download: 'https://d', ...over });

  it('新版本按日期插到最前，版本号与构建号保持字符串', () => {
    const { text, action, position } = upsertRelease(base, entry({ build: '0120' }), { fallbackSummary: { zh: 't', en: 't' } });
    expect(action).toBe('added');
    expect(position).toBe(0);
    expect(text.startsWith('# 注释会被保留')).toBe(true);
    expect(text).toContain('version: "1.11"');
    expect(text).toContain('build: "0120"');
    const data = parse(text).releases;
    expect(data.map((r) => r.version)).toEqual(['1.11', '1.10', '1.9']);
    expect(data[0].summary).toEqual({ zh: 't', en: 't' });
  });

  it('补录历史版本时插到正确位置', () => {
    const { text } = upsertRelease(base, entry({ version: '1.9.5', date: '2026-09-15', summary: 's' }));
    expect(parse(text).releases.map((r) => r.version)).toEqual(['1.10', '1.9.5', '1.9']);
  });

  it('更新已有版本：只改变化的字段，保留手工字段与原有说明', () => {
    const { text, action, changed } = upsertRelease(base, entry({ version: '1.10', date: '2026-09-20', sha256: 'a'.repeat(64) }));
    expect(action).toBe('updated');
    expect(changed).toEqual(['channel', 'download', 'sha256']);
    const r = parse(text).releases[0];
    expect(r).toMatchObject({ version: '1.10', badge: '手工填写', summary: { zh: '旧说明', en: 'Old' }, sha256: 'a'.repeat(64) });
    expect(text).toContain('version: "1.10"');
  });

  it('内容相同时不产生变化', () => {
    const { text, action } = upsertRelease(base, { version: '1.9', date: '2026-09-10', summary: 's' });
    expect(action).toBe('unchanged');
    expect(text).toBe(base);
  });

  it('新版本没有 summary 也没有兜底时报错', () => {
    expect(() => upsertRelease(base, entry())).toThrow(/缺少 summary/);
  });

  it('文件为空时自动创建列表', () => {
    const { text } = upsertRelease('', entry({ summary: 's' }));
    expect(parse(text).releases).toHaveLength(1);
  });
});
