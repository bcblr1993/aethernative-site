// 构建后检查（npm run build 会自动执行）：
// 1. Cloudflare Pages 单个文件不能超过 25 MiB —— 大安装包请放 GitHub Releases；
// 2. 所有页面里的站内链接（href / src / srcset）都必须指向实际存在的文件；
// 3. 原样转发的签名清单（appcastMode: mirror）必须与源文件逐字节一致，且清单签名有效。
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { verifySignedFeed } from './lib/release-sync.mjs';

const DIST = new URL('../dist/', import.meta.url).pathname;
const LIMIT = 25 * 1024 * 1024;

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const errors = [];
const pages = [];
let files = 0;
for await (const file of walk(DIST)) {
  files++;
  const { size } = await stat(file);
  if (size > LIMIT) errors.push(`文件超过 25 MiB（${(size / 1048576).toFixed(1)} MiB）：${relative(DIST, file)} —— 请改放到 GitHub Releases`);
  if (file.endsWith('.html')) pages.push(file);
}

const resolves = (url) => {
  const path = decodeURIComponent(url.split(/[?#]/)[0]);
  if (path === '' || path === '/') return existsSync(join(DIST, 'index.html'));
  const target = join(DIST, path);
  return existsSync(target) && (!path.endsWith('/') || existsSync(join(target, 'index.html')));
};

let links = 0;
for (const page of pages) {
  const html = await readFile(page, 'utf8');
  const urls = [
    ...[...html.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/\ssrcset="([^"]+)"/g)].flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+/)[0])),
  ];
  for (const url of urls) {
    if (!url.startsWith('/') || url.startsWith('//')) continue;
    links++;
    if (!resolves(url)) errors.push(`坏链接：${relative(DIST, page)} → ${url}`);
  }
}

// 签名清单
const APPS = new URL('../src/content/apps/', import.meta.url).pathname;
let feeds = 0;
for (const id of await readdir(APPS)) {
  const appYaml = join(APPS, id, 'app.yaml');
  if (!existsSync(appYaml)) continue;
  const app = parse(await readFile(appYaml, 'utf8'));
  if (app.appcastMode !== 'mirror') continue;
  const built = join(DIST, 'apps', id, 'appcast.xml');
  if (!existsSync(built)) { errors.push(`缺少原样转发的清单：apps/${id}/appcast.xml`); continue; }
  const out = await readFile(built);
  const src = await readFile(join(APPS, id, 'appcast.xml'));
  if (!out.equals(src)) errors.push(`apps/${id}/appcast.xml 与源文件不一致（原样转发的清单不能有任何改动）`);
  const check = verifySignedFeed(out, app.sparklePublicKey);
  if (!check.ok) errors.push(`apps/${id}/appcast.xml 清单签名无效：${check.reason}`);
  feeds++;
}

if (errors.length) {
  console.error(`\n✗ 构建检查未通过（${errors.length} 个问题）：\n  ` + [...new Set(errors)].join('\n  '));
  process.exit(1);
}
console.log(`✓ 构建检查通过：${files} 个文件均小于 25 MiB，${pages.length} 个页面中的 ${links} 个站内链接全部有效` +
  (feeds ? `，${feeds} 个签名清单校验通过` : ''));
