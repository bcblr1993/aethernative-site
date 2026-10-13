export const beijingDay = (time = Date.now()) => new Date(time + 8 * 3600_000).toISOString().slice(0, 10);
export interface AppName { id: string; name: string }
export interface DownloadStats {
  from: string; to: string; app: string; startedAt: number | null;
  versions?: { app_id: string; version: string; requests: number }[];
  rows: { day: string; app_id: string; requests: number }[];
}
export function buildDownloadReport(data: DownloadStats, names: AppName[]) {
  const byDay = new Map<string, number>();
  const totals = new Map<string, number>();
  for (const row of data.rows) {
    byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.requests);
    totals.set(row.app_id, (totals.get(row.app_id) ?? 0) + row.requests);
  }
  const started = data.startedAt === null ? null : beijingDay(data.startedAt);
  const days: { day: string; requests: number | null }[] = [];
  for (let time = Date.parse(data.to); time >= Date.parse(data.from); time -= 86400_000) {
    const day = new Date(time).toISOString().slice(0, 10);
    days.push({ day, requests: started && day >= started ? byDay.get(day) ?? 0 : null });
  }
  const apps = names.filter((item) => !data.app || item.id === data.app)
    .map((item) => ({ ...item, requests: totals.get(item.id) ?? 0 }));
  // Preserve historical totals for software no longer listed in the catalog.
  for (const [id, requests] of totals) if (!apps.some((item) => item.id === id)) apps.push({ id, name: id, requests });
  apps.sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name));
  return { days, apps, total: [...totals.values()].reduce((sum, count) => sum + count, 0) };
}
export function downloadCSV(report: ReturnType<typeof buildDownloadReport>, data: DownloadStats) {
  const quote = (value: unknown) => {
    const text = String(value);
    return `"${(/^[=+@-]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
  };
  const lines = [['日期（北京时间）', '软件', '下载发起次数', '统计状态']];
  for (const day of report.days) {
    for (const app of report.apps) {
      const count = data.rows.find((row) => row.day === day.day && row.app_id === app.id)?.requests ?? 0;
      lines.push([day.day, app.name, day.requests === null ? '' : String(count), day.requests === null ? '尚未统计' : '已统计']);
    }
  }
  return lines.map((line) => line.map(quote).join(',')).join('\r\n');
}
