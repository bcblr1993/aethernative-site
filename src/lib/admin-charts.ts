/** Small, dependency-free charts. Values are also available as text and accessible tables. */
export interface ChartValue { label: string; value: number | null }
const number = (n: number) => n.toLocaleString('zh-CN');
export function bars(target: HTMLElement, values: ChartValue[], unit = '次') {
  target.replaceChildren();
  const max = Math.max(1, ...values.map(v => v.value ?? 0));
  if (!values.some(v => (v.value ?? 0) > 0)) {
    const p = document.createElement('p'); p.className = 'chart-empty'; p.textContent = '暂无数据'; target.append(p); return;
  }
  for (const item of values) {
    const row = document.createElement('div'); row.className = 'bar-row';
    const name = document.createElement('span'); name.className = 'bar-name'; name.textContent = item.label;
    const track = document.createElement('span'); track.className = 'bar-track'; track.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('i'); fill.style.width = `${(item.value ?? 0) / max * 100}%`; track.append(fill);
    const count = document.createElement('b'); count.textContent = item.value === null ? '—' : number(item.value); count.title = unit;
    row.append(name, track, count); target.append(row);
  }
}

export function trend(target: HTMLElement, values: ChartValue[], title: string) {
  target.replaceChildren();
  const max = Math.max(1, ...values.map(v => v.value ?? 0));
  const columns = document.createElement('div'); columns.className = 'trend-columns';
  columns.setAttribute('role', 'group'); columns.setAttribute('aria-label', title);
  for (const item of values) {
    const column = document.createElement('span'); column.className = 'trend-column'; column.tabIndex = 0;
    const label = `${item.label}：${item.value === null ? '尚未统计' : number(item.value)}`;
    column.title = label; column.setAttribute('aria-label', label); column.dataset.tip = label;
    const fill = document.createElement('i'); fill.style.height = `${(item.value ?? 0) / max * 100}%`;
    if (item.value === null) column.classList.add('untracked');
    column.append(fill); columns.append(column);
  }
  const axis = document.createElement('div'); axis.className = 'chart-axis';
  for (const label of [values[0]?.label ?? '', `峰值 ${number(max === 1 && !values.some(v => v.value) ? 0 : max)}`, values.at(-1)?.label ?? '']) { const span = document.createElement('span'); span.textContent = label; axis.append(span); }
  const details = document.createElement('details'); const heading = document.createElement('summary'); heading.textContent = '查看每日数据';
  const table = document.createElement('table'); const caption = document.createElement('caption'); caption.textContent = title;
  table.append(caption);
  const head = document.createElement('thead'); const hr = document.createElement('tr');
  for (const text of ['日期（北京时间）', '数量']) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = text; hr.append(th); } head.append(hr); table.append(head);
  const body = document.createElement('tbody');
  for (const item of values) { const tr = document.createElement('tr'); for (const text of [item.label, item.value === null ? '尚未统计' : number(item.value)]) { const td = document.createElement('td'); td.textContent = text; tr.append(td); } body.append(tr); }
  table.append(body); details.append(heading, table); target.append(columns, axis, details);
}

export function ring(target: HTMLElement, values: ChartValue[]) {
  target.replaceChildren();
  const colors = ['#6366f1', '#14b8a6', '#f59e0b', '#ec4899', '#64748b'];
  const total = values.reduce((sum, v) => sum + (v.value ?? 0), 0);
  if (!total) { bars(target, []); return; }
  let offset = 0;
  const segments = values.map((v, i) => { const start = offset; offset += (v.value ?? 0) / total * 100; return `${colors[i % colors.length]} ${start}% ${offset}%`; });
  const donut = document.createElement('div'); donut.className = 'chart-ring'; donut.style.background = `conic-gradient(${segments.join(',')})`;
  donut.setAttribute('aria-hidden', 'true'); const center = document.createElement('span'); center.textContent = number(total); donut.append(center);
  const legend = document.createElement('div'); legend.className = 'chart-legend';
  values.forEach((v, i) => { const row = document.createElement('p'), dot = document.createElement('i'); dot.style.background = colors[i % colors.length]; row.append(dot, document.createTextNode(`${v.label} · ${number(v.value ?? 0)}（${((v.value ?? 0) / total * 100).toFixed(1)}%）`)); legend.append(row); });
  target.append(donut, legend);
}
