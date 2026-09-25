#!/usr/bin/env node
// 把某个软件的 GitHub Release 同步到网站的 releases.yaml。
//
// 用法：node scripts/sync-release.mjs --app <软件id> --tag <标签> [--dry-run]
//   例：node scripts/sync-release.mjs --app aetherroute --tag v1.0.27
//
// 原样转发：app.yaml 设 appcastMode: mirror 时（软件开启了 SURequireSignedFeed），最新正式版 Release 附件里
// 签好名的 appcast.xml 会校验后原样保存到 src/content/apps/<id>/appcast.xml，官网逐字节提供。
//
// 数据来源：
//   - 版本号 / 日期 / 测试版标记 / 下载地址 / SHA-256：GitHub Release 与附件（附件的 digest）；
//   - 简介、更新说明、Sparkle 签名：Release 正文里的隐藏区块 <!-- aethernative ... -->；
//   - 区块里没有签名时，回退读取软件仓库该标签下的 appcast.xml（app.yaml 的 appcastPath，默认 appcast.xml）。
// 安全：app.yaml 配了 sparklePublicKey 时，会下载安装包用公钥核对签名，不匹配就中止，绝不写入错误签名。
//
// 环境变量：GITHUB_TOKEN（可选；读私有仓库或避免 API 限流时需要）
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import {
  buildEntry, detectBuild, detectVersion, findInAppcast, parseSiteBlock, parseSparkleLine,
  latestStableVersion, pickAsset, upsertRelease, verifySignedFeed, verifySparkleSignature,
} from './lib/release-sync.mjs';

const { values: args } = parseArgs({
  options: { app: { type: 'string' }, tag: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
});
if (!args.app || !args.tag) {
  console.error('用法：node scripts/sync-release.mjs --app <软件id> --tag <标签> [--dry-run]');
  process.exit(64);
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(args.app)) fail(`软件 id 不合法：${args.app}`);

const inCI = !!process.env.GITHUB_ACTIONS;
const warn = (msg) => console.log(inCI ? `::warning::${msg}` : `⚠️  ${msg}`);
function fail(msg) {
  console.error(inCI ? `::error::${msg}` : `✗ ${msg}`);
  process.exit(1);
}

const ROOT = new URL('../', import.meta.url);
const appDir = new URL(`src/content/apps/${args.app}/`, ROOT);
const appFile = new URL('app.yaml', appDir);
const releasesFile = new URL('releases.yaml', appDir);
if (!existsSync(appFile)) fail(`找不到 ${appFile.pathname}，请先在网站上建好这个软件`);

const app = parse(await readFile(appFile, 'utf8'));
const repo = app.repo?.match(/github\.com\/([^/]+\/[^/#?]+)/)?.[1]?.replace(/\.git$/, '');
if (!repo) fail(`${args.app}/app.yaml 缺少 GitHub 仓库地址（repo）`);

const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'aethernative-sync' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

/** 带重试的 fetch：网络错误或 5xx 时最多重试 3 次（1s、3s、9s）。 */
async function fetchRetry(url, init) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status < 500 || attempt >= 3) return res;
    } catch (e) {
      if (attempt >= 3) fail(`网络请求失败（已重试 3 次）：${url}：${e.cause?.code ?? e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1000 * 3 ** attempt));
  }
}

async function gh(path) {
  const res = await fetchRetry(`https://api.github.com${path}`, { headers });
  if (!res.ok) fail(`GitHub API ${path} 返回 ${res.status}：${(await res.text()).slice(0, 200)}`);
  return res.json();
}
async function download(url) {
  const res = await fetchRetry(url, { headers: { 'User-Agent': headers['User-Agent'], ...(headers.Authorization && url.includes('api.github.com') && { Authorization: headers.Authorization }) } });
  if (!res.ok) fail(`下载失败 ${res.status}：${url}`);
  return Buffer.from(await res.arrayBuffer());
}

console.log(`→ 读取 ${repo} 的 Release ${args.tag}`);
const release = await gh(`/repos/${repo}/releases/tags/${encodeURIComponent(args.tag)}`);
if (release.draft) {
  console.log('这是草稿（draft）Release，跳过同步');
  process.exit(0);
}

let block;
try {
  block = parseSiteBlock(release.body ?? '');
} catch (e) {
  fail(e.message);
}
if (!block) warn('Release 正文里没有 <!-- aethernative --> 区块：将只同步版本、下载地址与校验值，新版本的简介暂用 Release 标题');

const asset = pickAsset(release.assets);
if (!asset) fail('Release 里没有找到 .dmg / .zip / .pkg 安装包');
console.log(`→ 安装包：${asset.name}（${(asset.size / 1048576).toFixed(1)} MiB）`);

// SHA-256：优先使用 GitHub 提供的 digest，没有时下载计算
let data;
let sha256 = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : undefined;
if (!sha256) {
  data ??= await download(asset.browser_download_url);
  sha256 = createHash('sha256').update(data).digest('hex');
}

// Release 附件里的 appcast.xml（NotchQuota 等“签名清单”软件每次发版都会附带）
const version = detectVersion(release.tag_name, block);
const feedAsset = release.assets.find((a) => a.name === 'appcast.xml');
const feedBuf = feedAsset ? await download(feedAsset.browser_download_url) : null;

// Sparkle 签名：区块 > Release 附件 appcast.xml > 仓库 appcast.xml
let appcast = null;
let sparkle = block?.sparkle ? (typeof block.sparkle === 'string' ? parseSparkleLine(block.sparkle) : block.sparkle) : null;
if (block?.sparkle && !sparkle) fail('区块里的 sparkle 无法解析，请直接粘贴 sign_update 的输出：sparkle:edSignature="..." length="..."');
if (!sparkle && feedBuf) {
  appcast = findInAppcast(feedBuf.toString('utf8'), version);
  if (appcast) {
    sparkle = { edSignature: appcast.edSignature, length: appcast.length };
    console.log(`→ 从 Release 附件 appcast.xml 读取到 ${version} 的 Sparkle 签名`);
  }
}
if (!sparkle && app.sparklePublicKey) {
  const path = app.appcastPath ?? 'appcast.xml';
  const res = await fetchRetry(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(release.tag_name)}/${path}`, { headers: { 'User-Agent': headers['User-Agent'] } });
  if (res.ok) {
    appcast = findInAppcast(await res.text(), version);
    if (appcast) {
      sparkle = { edSignature: appcast.edSignature, length: appcast.length };
      console.log(`→ 从仓库 ${path}（${release.tag_name}）读取到 ${version} 的 Sparkle 签名`);
    }
  }
}

if (sparkle) {
  if (sparkle.length !== asset.size) fail(`Sparkle length=${sparkle.length} 与安装包实际大小 ${asset.size} 不一致，签名可能对应的是别的文件`);
  if (app.sparklePublicKey) {
    data ??= await download(asset.browser_download_url);
    if (!verifySparkleSignature(data, sparkle.edSignature, app.sparklePublicKey)) {
      fail('Sparkle 签名与安装包不匹配（已用 app.yaml 的 sparklePublicKey 校验）。请确认签名来自这个安装包、且使用的是正确的私钥');
    }
    console.log('→ Sparkle 签名校验通过');
  } else {
    warn(`${args.app}/app.yaml 未配置 sparklePublicKey，无法校验签名`);
  }
} else if (app.sparklePublicKey) {
  warn(`没有找到 ${version} 的 Sparkle 签名：这个版本不会出现在自动更新清单里`);
}

const build = detectBuild({ block, appcast, assetName: asset.name, title: release.name ?? '', body: release.body ?? '' });
if (sparkle && !build) fail('有 Sparkle 签名但识别不到构建号（CFBundleVersion）：请在区块里写 build: 123');

const entry = buildEntry({ release, asset, sha256, block, sparkle, build });
const title = release.name?.trim() || version;
const current = existsSync(releasesFile) ? await readFile(releasesFile, 'utf8') : `# ${app.name} 版本记录\nreleases: []\n`;
let result;
try {
  result = upsertRelease(current, entry, { fallbackSummary: { zh: title, en: title } });
} catch (e) {
  fail(e.message);
}

// 原样转发模式：最新正式版的签名清单原样保存，官网直接提供（改动任何字节都会使清单签名失效）
let mirrorWrite = null;
if (app.appcastMode === 'mirror' && latestStableVersion(result.text) === entry.version && !feedBuf) {
  warn(`${args.app} 使用原样转发模式，但最新正式版 ${release.tag_name} 没有附带 appcast.xml：官网上的更新清单保持不变`);
} else if (app.appcastMode === 'mirror' && latestStableVersion(result.text) === entry.version) {
  const check = verifySignedFeed(feedBuf, app.sparklePublicKey);
  if (!check.ok) fail(`Release 附件 appcast.xml 校验失败：${check.reason}`);
  if (!findInAppcast(feedBuf.toString('utf8'), entry.version)) fail(`Release 附件 appcast.xml 中没有 ${entry.version} 这个版本`);
  console.log('→ 签名清单校验通过，将原样转发');
  mirrorWrite = feedBuf;
}

const verb = { added: '新增', updated: `更新（${result.changed?.join('、')}）`, unchanged: '无变化' }[result.action];
console.log(`\n${verb} ${app.name} ${entry.version}` +
  `（${entry.channel}${build ? `，build ${build}` : ''}${sparkle ? '，含 Sparkle 签名' : ''}）`);
if (args['dry-run']) {
  console.log('\n--dry-run：不写入文件。结果预览：\n');
  console.log(result.text);
} else {
  await writeFile(releasesFile, result.text);
  console.log(`已写入 ${releasesFile.pathname.replace(ROOT.pathname, '')}`);
  if (mirrorWrite) {
    const feedFile = new URL('appcast.xml', appDir);
    await writeFile(feedFile, mirrorWrite);
    console.log(`已写入 ${feedFile.pathname.replace(ROOT.pathname, '')}（原样转发的签名清单）`);
  }
}
