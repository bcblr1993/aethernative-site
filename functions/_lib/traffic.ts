import type { Env } from './env';
import { beijingDay } from './downloads';
export const ANALYTICS_ACCOUNT = 'dc47f3175058911e0ec47458b05aba64';
export const ANALYTICS_SITE = '277a6a29a96c41beb8f6c6b93f97fcef';
type Row = { count:number; sum:{visits:number}; dimensions?:Record<string,string>; avg?:{sampleInterval:number} };
export async function fetchTraffic(token:string, days:number, now=Date.now()) {
  const today=beijingDay(now), midnight=Date.parse(`${today}T00:00:00+08:00`);
  const start=midnight-(days-1)*86400000;
  const iso=(n:number)=>new Date(n).toISOString();
  const filter=(from:number,to:number)=>`siteTag: "${ANALYTICS_SITE}", bot: 0, datetime_geq: "${iso(from)}", datetime_lt: "${iso(to)}"`;
  const metric='count sum { visits } avg { sampleInterval }';
  const total=(name:string,from:number,to:number)=>`${name}: rumPageloadEventsAdaptiveGroups(limit:1,filter:{${filter(from,to)}}){${metric}}`;
  const group=(name:string,dim:string,limit:number)=>`${name}: rumPageloadEventsAdaptiveGroups(limit:${limit},orderBy:[count_DESC],filter:{${filter(start,now)}}){${metric} dimensions {${dim}}}`;
  const query=`query { viewer { accounts(filter:{accountTag:"${ANALYTICS_ACCOUNT}"}) {
    ${total('today',midnight,now)} ${total('yesterday',midnight-86400000,midnight)}
    ${total('yesterdaySameTime',midnight-86400000,now-86400000)} ${total('period',start,now)}
    hours: rumPageloadEventsAdaptiveGroups(limit:745,filter:{${filter(start,now)}}){${metric} dimensions {datetimeHour}}
    ${group('pages','requestPath',12)} ${group('sources','refererHost',10)} ${group('devices','userAgentOS',10)} ${group('countries','countryName',10)}
  } } }`;
  const r=await fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(15000)});
  if(!r.ok) throw new Error('analytics_unavailable');
  const data=await r.json() as {errors?:unknown[];data?:{viewer?:{accounts?:Record<string,Row[]>[]}}};
  const a=data.data?.viewer?.accounts?.[0];
  if(data.errors?.length || !a || !Array.isArray(a.period) || !Array.isArray(a.hours)) throw new Error('analytics_unavailable');
  const count=(rows:Row[])=>({pv:rows.reduce((s,r)=>s+r.count,0),visits:rows.reduce((s,r)=>s+r.sum.visits,0)});
  const daily=Array.from({length:days},(_,i)=>({day:beijingDay(start+i*86400000),pv:0,visits:0}));
  for(const row of a.hours){const day=beijingDay(Date.parse(row.dimensions!.datetimeHour));const d=daily.find(x=>x.day===day);if(d){d.pv+=row.count;d.visits+=row.sum.visits;}}
  const breakdown=(rows:Row[],dim:string)=>rows.map(r=>({label:r.dimensions?.[dim]||'(direct)',pv:r.count,visits:r.sum.visits}));
  return {capturedAt:now,from:beijingDay(start),to:today,days,timezone:'Asia/Shanghai',today:count(a.today),yesterday:count(a.yesterday),yesterdaySameTime:count(a.yesterdaySameTime),period:count(a.period),daily,
    pages:breakdown(a.pages,'requestPath'),sources:breakdown(a.sources,'refererHost'),devices:breakdown(a.devices,'userAgentOS'),countries:breakdown(a.countries,'countryName')};
}
export async function traffic(env:Env,days:number,now=Date.now()) {
  const cached=await env.DB.prepare('SELECT captured_at,payload FROM traffic_cache WHERE days=?').bind(days).first<{captured_at:number;payload:string}>();
  let payload:unknown;try{payload=cached?JSON.parse(cached.payload):null;}catch{payload=null;}
  const configured=Boolean(env.CLOUDFLARE_ANALYTICS_TOKEN);
  if(payload && cached && now-cached.captured_at<300000) return {report:payload,stale:false,configured};
  if(configured){try{
    const report=await fetchTraffic(env.CLOUDFLARE_ANALYTICS_TOKEN!,days,now);
    await env.DB.prepare('INSERT INTO traffic_cache(days,captured_at,payload) VALUES(?,?,?) ON CONFLICT(days) DO UPDATE SET captured_at=excluded.captured_at,payload=excluded.payload').bind(days,now,JSON.stringify(report)).run();
    return {report,stale:false,configured};
  }catch{/* Keep the last successful snapshot, never replace failures with zeros. */}}
  return {report:payload,stale:true,configured};
}
