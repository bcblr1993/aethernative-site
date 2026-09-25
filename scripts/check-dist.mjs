// 构建后检查（npm run build 会自动执行）：
// 1. Cloudflare Pages 单个文件不能超过 25 MiB —— 大安装包请放 GitHub Releases；
// 2. 所有页面里的站内链接（href / src / srcset）都必须指向实际存在的文件。
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

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

if (errors.length) {
  console.error(`\n✗ 构建检查未通过（${errors.length} 个问题）：\n  ` + [...new Set(errors)].join('\n  '));
  process.exit(1);
}
console.log(`✓ 构建检查通过：${files} 个文件均小于 25 MiB，${pages.length} 个页面中的 ${links} 个站内链接全部有效`);
