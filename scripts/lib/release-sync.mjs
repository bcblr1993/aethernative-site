// 发版同步的纯逻辑（无网络访问），供 scripts/sync-release.mjs 使用，并有单元测试覆盖。
import { createPublicKey, verify } from 'node:crypto';
import { parse, parseDocument, isSeq, isScalar } from 'yaml';

/**
 * 从 GitHub Release 正文中取出隐藏的官网信息区块：
 *   <!-- aethernative
 *   summary: { zh: ..., en: ... }
 *   notes: [...]
 *   sparkle: sparkle:edSignature="..." length="..."
 *   -->
 * 区块内是 YAML。没有区块时返回 null；YAML 写错时抛出带原因的错误。
 */
export function parseSiteBlock(body = '') {
  const m = body.match(/<!--\s*aethernative\s*\n([\s\S]*?)-->/);
  if (!m) return null;
  let data;
  try {
    data = parse(m[1]) ?? {};
  } catch (e) {
    throw new Error(`官网信息区块不是合法的 YAML：${e.message}`);
  }
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error('官网信息区块应为 YAML 对象');
  return data;
}

/** 解析 sign_update 的输出：sparkle:edSignature="..." length="..."（顺序不限）。 */
export function parseSparkleLine(text) {
  if (!text) return null;
  const sig = String(text).match(/edSignature="([^"]+)"/);
  const len = String(text).match(/length="(\d+)"/);
  return sig && len ? { edSignature: sig[1], length: Number(len[1]) } : null;
}

/** 从 appcast.xml 中找到指定版本（shortVersionString）的签名、长度与构建号。 */
export function findInAppcast(xml, version) {
  for (const item of xml.match(/<item>[\s\S]*?<\/item>/g) ?? []) {
    const short = item.match(/<sparkle:shortVersionString>([^<]+)</)?.[1]?.trim();
    if (short !== version) continue;
    const enc = item.match(/<enclosure[\s\S]*?\/?>/)?.[0] ?? '';
    const sp = parseSparkleLine(enc);
    const build = item.match(/<sparkle:version>([^<]+)</)?.[1]?.trim();
    return sp ? { ...sp, build } : null;
  }
  return null;
}

/** 选出 Mac 安装包：优先 .dmg，其次 .zip / .pkg；同类型里优先文件名含 arm64 / universal 的。 */
export function pickAsset(assets = []) {
  const rank = (a) => {
    const n = a.name.toLowerCase();
    const type = n.endsWith('.dmg') ? 0 : n.endsWith('.zip') ? 1 : n.endsWith('.pkg') ? 2 : 9;
    const arch = /arm64|universal|apple-?silicon/.test(n) ? 0 : 1;
    return type * 10 + arch;
  };
  return [...assets].filter((a) => rank(a) < 90).sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** 构建号：区块 > appcast > 文件名中的 build-123 > Release 标题/正文中的 Build 123。 */
export function detectBuild({ block, appcast, assetName = '', title = '', body = '' }) {
  if (block?.build != null) return String(block.build);
  if (appcast?.build) return appcast.build;
  const m = assetName.match(/build[-_.]?(\d+)/i) ?? `${title}\n${body}`.match(/\bBuild[\s:：-]*(\d{3,})/i);
  return m?.[1];
}

/** 版本号：区块 > 标签去掉前缀 v。 */
export const detectVersion = (tag, block) => String(block?.version ?? tag.replace(/^v(?=\d)/i, ''));

/** 用软件的 Sparkle 公钥（SUPublicEDKey，Base64）校验安装包签名。 */
export function verifySparkleSignature(data, edSignature, publicKeyBase64) {
  const raw = Buffer.from(publicKeyBase64, 'base64');
  if (raw.length !== 32) throw new Error('sparklePublicKey 应为 32 字节的 Ed25519 公钥（Base64）');
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
  return verify(null, data, key, Buffer.from(edSignature, 'base64'));
}

/** 由 GitHub Release 与区块信息组装一条 releases.yaml 记录。 */
export function buildEntry({ release, asset, sha256, block, sparkle, build }) {
  const version = detectVersion(release.tag_name, block);
  const entry = {
    version,
    ...(build && { build }),
    date: release.published_at.slice(0, 10),
    channel: block?.channel ?? (release.prerelease ? 'beta' : 'stable'),
    download: asset.browser_download_url,
    github: release.html_url,
    ...(sha256 && { sha256 }),
    ...(sparkle && { sparkle: { edSignature: sparkle.edSignature, length: sparkle.length, ...(block?.minimumSystemVersion && { minimumSystemVersion: String(block.minimumSystemVersion) }) } }),
    ...(block?.badge && { badge: block.badge }),
    ...(block?.summary && { summary: block.summary }),
    ...(block?.notes && { notes: block.notes }),
  };
  return entry;
}

const QUOTED = new Set(['version', 'build']);

/** 版本号比较：1.0.10 > 1.0.9；预览版后缀按字符串比较。 */
export function compareVersions(a, b) {
  const pa = a.split(/[.-]/), pb = b.split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '', y = pb[i] ?? '';
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (!nx || !ny) { if (x !== y) return x < y ? -1 : 1; }
  }
  return 0;
}

/**
 * 把记录写入 releases.yaml 文本（保留注释与格式），返回 { text, action }。
 * - 已有同版本：用新数据覆盖，但保留手工填写而新数据里没有的字段（如 badge、requirement、summary、notes）；
 * - 新版本：按日期（其次版本号）倒序插入到合适位置；没有 summary 时使用 fallbackSummary（通常是 Release 标题）。
 */
export function upsertRelease(yamlText, entry, { fallbackSummary } = {}) {
  const doc = parseDocument(yamlText ?? 'releases: []\n');
  if (doc.errors.length) throw new Error(`releases.yaml 解析失败：${doc.errors[0].message}`);
  if (!doc.has('releases')) doc.set('releases', doc.createNode([]));
  const seq = doc.get('releases');
  if (!isSeq(seq)) throw new Error('releases.yaml 中 releases 应为列表');

  // 版本号、构建号必须保持字符串（否则 1.10 会被当成数字 1.1）
  const node = (key, value) => {
    const n = doc.createNode(value);
    if (QUOTED.has(key) && isScalar(n)) n.type = 'QUOTE_DOUBLE';
    return n;
  };
  const idx = seq.items.findIndex((n) => String(n.get?.('version')) === entry.version);
  if (idx >= 0) {
    // 只改有变化的字段，其余保持原样（包括格式与引号），方便审查差异
    const item = seq.items[idx];
    const changed = [];
    for (const [key, value] of Object.entries(entry)) {
      const old = item.get(key, true);
      const oldJSON = old?.toJSON ? old.toJSON() : old;
      if (JSON.stringify(oldJSON) === JSON.stringify(value)) continue;
      item.set(key, node(key, value));
      changed.push(key);
    }
    return { text: doc.toString({ lineWidth: 0 }), action: changed.length ? 'updated' : 'unchanged', changed };
  }
  const newer = (n) => {
    const d = String(n.get('date') ?? '');
    return d > entry.date || (d === entry.date && compareVersions(String(n.get('version')), entry.version) > 0);
  };
  let pos = seq.items.findIndex((n) => !newer(n));
  if (pos < 0) pos = seq.items.length;
  if (!entry.summary) {
    if (!fallbackSummary) throw new Error(`新版本 ${entry.version} 缺少 summary，且没有可用的兜底说明`);
    entry = { ...entry, summary: fallbackSummary };
  }
  const map = doc.createNode({});
  for (const [key, value] of Object.entries(entry)) map.set(key, node(key, value));
  seq.items.splice(pos, 0, map);
  return { text: doc.toString({ lineWidth: 0 }), action: 'added', position: pos };
}

/**
 * 校验“签名清单”（Sparkle SURequireSignedFeed）：文件末尾的
 *   <!-- sparkle-signatures:\nedSignature: ...\nlength: N\n-->
 * 签名覆盖文件前 N 字节。返回 { ok, reason }。
 */
export function verifySignedFeed(buf, publicKeyBase64) {
  const text = buf.toString('utf8');
  const m = text.match(/<!-- sparkle-signatures:\s*\n\s*edSignature:\s*(\S+)\s*\n\s*length:\s*(\d+)\s*\n\s*-->/);
  if (!m) return { ok: false, reason: '清单没有 sparkle-signatures 签名' };
  const length = Number(m[2]);
  if (length > buf.length) return { ok: false, reason: `签名声明的长度 ${length} 超过文件大小 ${buf.length}` };
  const ok = verifySparkleSignature(buf.subarray(0, length), m[1], publicKeyBase64);
  return ok ? { ok } : { ok, reason: '清单签名与内容不匹配' };
}

/** 版本记录中的最新正式版（第一条 stable）。 */
export function latestStableVersion(yamlText) {
  const list = parse(yamlText)?.releases ?? [];
  return list.find((r) => (r.channel ?? 'stable') === 'stable')?.version?.toString();
}
