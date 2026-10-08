// Import verified native captures; never generate or recolor product screenshots.
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parse, stringify } from 'yaml';
const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/import-aetherterm-screenshots.mjs <outputs/macos27/website>');
const root = resolve(source);
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const remoteNative = manifest.captureMethod === 'remote-native' && String(manifest.model).startsWith('Mac');
if ((manifest.vm !== 'macos27' && !remoteNative) || !String(manifest.systemVersion).startsWith('27.') || !manifest.demoData) {
  throw new Error('Require macOS 27 native captures using demo data.');
}
const themes = [
  ['classic', { zh: '经典白色', en: 'Classic Light' }, 'light'],
  ['modern', 'VS Code Dark Modern', 'dark'], ['tokyo', 'Tokyo Night', 'dark'],
  ['mocha', 'Catppuccin Mocha', 'dark'], ['nord', 'Nord', 'dark'], ['dracula', 'Dracula', 'dark'],
  ['latte', 'Catppuccin Latte', 'light'], ['onedark', 'One Dark Pro', 'dark'],
  ['gruvbox', 'Gruvbox Dark', 'dark'], ['everforest', 'Everforest', 'dark'],
  ['rosepine', 'Rosé Pine', 'dark'], ['solarized', 'Solarized Light', 'light'],
];
const pages = [['main', { zh: '工作台', en: 'Workspace' }], ['editor', { zh: '编辑器', en: 'Editor' }],
  ['settings', { zh: '设置', en: 'Settings' }], ['about', { zh: '关于', en: 'About' }]];
const directory = new URL('../src/content/apps/aetherterm/', import.meta.url);
// Check the entire matrix before writing anything into the website.
for (const [id] of themes) for (const [page] of pages) {
  const file = `${id}-${page}.png`;
  if (!manifest.screenshots.includes(file)) throw new Error(`Capture manifest missing ${file}`);
  const data = await readFile(join(root, 'captures', file));
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || data.readUInt32BE(16) < 400 || data.readUInt32BE(20) < 300) {
    throw new Error(`Invalid native screenshot: ${file}`);
  }
}
const configFile = new URL('app.yaml', directory);
const app = parse(await readFile(configFile, 'utf8'));
app.themeGallery = {
  note: { zh: '12 种应用主题 · macOS 27 原生窗口截图 · 演示数据。应用主题预览与网站深浅色独立切换。',
    en: '12 app themes · Native macOS 27 window screenshots · Demo data. App preview themes are independent of website appearance.' },
  themes: themes.map(([id, name, appearance]) => ({ id, name, appearance,
    shots: pages.map(([page, label]) => ({ label, zh: `./media/${id}-${page}.png` })) })),
};
app.gallery = [{ label: { zh: '工作台 · 经典白色', en: 'Workspace · Classic Light' }, zh: './media/classic-main.png' }];
for (const [id] of themes) for (const [page] of pages) {
  const file = `${id}-${page}.png`;
  await copyFile(join(root, 'captures', file), new URL(`media/${file}`, directory));
}
await writeFile(configFile, stringify(app, { lineWidth: 120 }));
console.log(`Imported 48 native screenshots from ${manifest.sourceCommit}`);
