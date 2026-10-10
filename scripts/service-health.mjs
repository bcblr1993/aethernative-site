import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function checkPackage(app, fetcher = fetch, site = 'https://aethernative.com') {
  const checks = [];
  const get = async (url, timeout = 90000) => {
    const r = await fetcher(new URL(url, site), { signal: AbortSignal.timeout(timeout) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r;
  };
  if (!app.download) return [{ kind:'package', status:'skipped', message:'未提供独立安装包' }];
  try {
    const r = await get(app.download);
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of r.body) { hash.update(chunk); bytes += chunk.length; }
    const actual = hash.digest('hex');
    checks.push({ kind:'package', status: bytes > 0 ? 'ok':'failed', bytes, finalUrl:r.url ? new URL(r.url).origin + new URL(r.url).pathname : null, message:bytes > 0 ? '安装包可下载':'安装包为空' });
    checks.push({ kind:'sha256', status:app.sha256 ? (actual === app.sha256 ? 'ok':'failed'):'skipped', actual, message:app.sha256 ? (actual === app.sha256 ? 'SHA256 一致':'SHA256 不一致'):'发布记录未提供 SHA256' });
    checks.push({ kind:'size', status:app.length ? (bytes === app.length ? 'ok':'failed'):'skipped', message:app.length ? (bytes === app.length ? '文件大小一致':'文件大小不一致'):'发布记录未提供文件大小' });
  } catch (e) { checks.push({kind:'package',status:'failed',message:e.message}); }
  if (app.appcast) {
    try {
      const xml = await (await get(app.appcast,20000)).text();
      const items = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/g) ?? [];
      const item = items.find(text => text.includes(`<sparkle:shortVersionString>${app.version}</sparkle:shortVersionString>`));
      const enclosure = item?.match(/<enclosure\b[^>]*>/)?.[0] ?? '';
      const url = enclosure.match(/\burl="([^"]+)"/)?.[1]?.replaceAll('&amp;','&');
      const signature = enclosure.match(/sparkle:edSignature="([^"]+)"/)?.[1];
      const length = Number(enclosure.match(/\blength="(\d+)"/)?.[1]);
      const valid = url === new URL(app.download,site).href && !!signature && (!app.edSignature || signature === app.edSignature) && (!app.length || length === app.length);
      checks.push({kind:'appcast',status:valid?'ok':'failed',message:valid?'更新源版本、下载地址和大小一致，包含对应签名字段':'更新源与当前正式版不一致或缺少签名字段'});
    } catch(e) {checks.push({kind:'appcast',status:'failed',message:e.message});}
  }
  return checks;
}

export async function scan(catalog, previous = {}, fetcher = fetch) {
  const checkedAt = new Date().toISOString(); const apps = [];
  for (const app of catalog.apps) {
    let checks = await checkPackage(app, fetcher);
    if(checks.some(c=>c.status==='failed')) checks = await checkPackage(app, fetcher);
    const failed = checks.some(c=>c.status==='failed');
    const old = previous.apps?.find(a=>a.id===app.id && a.version===app.version && a.download===app.download && a.sha256===app.sha256);
    const failures = failed ? (old?.failures ?? 0) + 1 : 0;
    apps.push({...app,checks,failures,status:failed?(failures>=2?'failed':'suspect'):checks.every(c=>c.status==='skipped')?'skipped':'ok'});
    console.log(`${app.id}: ${apps.at(-1).status}`);
  }
  return { checkedAt, apps };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const catalog = JSON.parse(await readFile(process.argv[2] ?? 'dist/service-catalog.json','utf8'));
  const output = process.argv[3] ?? 'public/service-health.json';
  const previous = await readFile(output,'utf8').then(JSON.parse).catch(()=>({}));
  const report = await scan(catalog,previous);
  await writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({checkedAt:report.checkedAt,apps:report.apps.map(a=>({id:a.id,status:a.status,failures:a.failures}))}));
  if(report.apps.some(a=>a.status==='failed')) process.exitCode=1;
}
