'use strict';

// ---------------------------------------------------------------------------
// Chart layer. Plain SVG, no dependencies.
// Mark specs: 2px lines with round joins; bars ≤ 24px with a 4px rounded
// data-end and a square baseline; ≥ 8px end markers with a 2px surface ring;
// hairline solid gridlines; legends for ≥ 2 series; values wear text tokens,
// never the series colour; hover tooltips on every plot.
// ---------------------------------------------------------------------------

const SVGNS = 'http://www.w3.org/2000/svg';

function css(varName) {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}

export const seriesColor = (i) => css(`--series-${(i % 8) + 1}`);

function el(tag, attrs = {}, parent) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

// ---- tooltip singleton ----
let tip;
function tooltip() {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'viz-tooltip';
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  return tip;
}
export function showTip(html, evt) {
  const t = tooltip();
  t.innerHTML = html;
  t.hidden = false;
  const pad = 14;
  const rect = t.getBoundingClientRect();
  let x = evt.clientX + pad, y = evt.clientY + pad;
  if (x + rect.width > window.innerWidth - 8) x = evt.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = evt.clientY - rect.height - pad;
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}
export function hideTip() { if (tip) tip.hidden = true; }

function niceTicks(min, max, count = 4) {
  if (min === max) { max = min + 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step * 0.001; v += step) ticks.push(v);
  return { ticks, lo, hi };
}

function legendRow(container, series) {
  if (series.length < 2) return;
  const div = document.createElement('div');
  div.className = 'viz-legend';
  for (const s of series) {
    const item = document.createElement('span');
    item.className = 'viz-legend-item';
    item.innerHTML = `<span class="viz-swatch" style="background:${s.color}"></span>${s.name}`;
    div.appendChild(item);
  }
  container.appendChild(div);
}

/**
 * Multi-series line chart with optional dashed-free target series and a
 * forecast segment rendered as a confidence band + continuation line.
 * series: [{ name, values: number[], color, isTarget?, band?: [lo,hi][] }]
 */
export function lineChart(container, { series, labels, fmt = (v) => v, forecastFrom = null, height = 240, onPointClick = null }) {
  container.innerHTML = '';
  legendRow(container, series);
  const W = Math.max(340, container.clientWidth || 620);
  const H = height;
  const m = { top: 14, right: 74, bottom: 26, left: 80 };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'viz-plot' });
  container.appendChild(svg);

  const all = series.flatMap((s) => s.values.filter((v) => v != null))
    .concat(series.flatMap((s) => (s.band || []).flat()));
  const { ticks, lo, hi } = niceTicks(Math.min(0, ...all), Math.max(...all));
  const x = (i) => m.left + (i / Math.max(1, labels.length - 1)) * (W - m.left - m.right);
  const y = (v) => m.top + (1 - (v - lo) / (hi - lo)) * (H - m.top - m.bottom);

  // hairline grid + tick labels
  for (const t of ticks) {
    el('line', { x1: m.left, x2: W - m.right, y1: y(t), y2: y(t), class: 'viz-grid' }, svg);
    const txt = el('text', { x: m.left - 8, y: y(t) + 3, class: 'viz-tick', 'text-anchor': 'end' }, svg);
    txt.textContent = fmt(t);
  }
  // x labels (thinned)
  const stepX = Math.ceil(labels.length / 8);
  labels.forEach((lab, i) => {
    if (i % stepX !== 0 && i !== labels.length - 1) return;
    const txt = el('text', { x: x(i), y: H - 8, class: 'viz-tick', 'text-anchor': 'middle' }, svg);
    txt.textContent = lab;
  });

  // forecast divider
  if (forecastFrom != null && forecastFrom < labels.length) {
    el('line', { x1: x(forecastFrom), x2: x(forecastFrom), y1: m.top, y2: H - m.bottom, class: 'viz-forecast-divider' }, svg);
    const t = el('text', { x: x(forecastFrom) + 4, y: m.top + 10, class: 'viz-tick' }, svg);
    t.textContent = 'forecast';
  }

  series.forEach((s) => {
    // confidence band (area wash ~10%)
    if (s.band) {
      const pts = s.band.map((b, i) => b ? [x(i), y(b[1])] : null).filter(Boolean);
      const back = s.band.map((b, i) => b ? [x(i), y(b[0])] : null).filter(Boolean).reverse();
      if (pts.length > 1) {
        const d = `M${pts.map((p) => p.join(',')).join('L')}L${back.map((p) => p.join(',')).join('L')}Z`;
        el('path', { d, fill: s.color, opacity: 0.1, stroke: 'none' }, svg);
      }
    }
    const pts = s.values.map((v, i) => (v == null ? null : [x(i), y(v)]));
    let d = '';
    pts.forEach((p) => { d += p ? (d.endsWith('M') || d === '' ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`) : ''; });
    el('path', {
      d, fill: 'none', stroke: s.color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      opacity: s.isTarget ? 0.55 : 1
    }, svg);
    // end marker with surface ring
    const last = [...pts].reverse().find(Boolean);
    if (last && !s.isTarget) {
      el('circle', { cx: last[0], cy: last[1], r: 4.5, fill: s.color, stroke: css('--surface-1'), 'stroke-width': 2 }, svg);
      const label = el('text', { x: last[0] + 8, y: last[1] + 3, class: 'viz-endlabel' }, svg);
      label.textContent = fmt(s.values[s.values.length - 1]);
    }
  });

  // crosshair + tooltip
  const hover = el('rect', { x: m.left, y: m.top, width: W - m.left - m.right, height: H - m.top - m.bottom, fill: 'transparent' }, svg);
  const cross = el('line', { y1: m.top, y2: H - m.bottom, class: 'viz-crosshair', visibility: 'hidden' }, svg);
  hover.addEventListener('mousemove', (evt) => {
    const rect = svg.getBoundingClientRect();
    const px = (evt.clientX - rect.left) * (W / rect.width);
    const i = Math.max(0, Math.min(labels.length - 1, Math.round(((px - m.left) / (W - m.left - m.right)) * (labels.length - 1))));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
    cross.setAttribute('visibility', 'visible');
    const lines = series.map((s) => s.values[i] == null ? '' :
      `<div><span class="viz-swatch" style="background:${s.color}"></span>${s.name}: <b>${fmt(s.values[i])}</b></div>`).join('');
    showTip(`<div class="viz-tip-title">${labels[i]}</div>${lines}`, evt);
  });
  hover.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
  if (onPointClick) {
    hover.style.cursor = 'pointer';
    hover.addEventListener('click', (evt) => {
      const rect = svg.getBoundingClientRect();
      const px = (evt.clientX - rect.left) * (W / rect.width);
      const i = Math.max(0, Math.min(labels.length - 1, Math.round(((px - m.left) / (W - m.left - m.right)) * (labels.length - 1))));
      onPointClick(i);
    });
  }
}

/** Ranked horizontal bar chart; click a bar to drill. */
export function barChartH(container, { items, fmt = (v) => v, color = null, height = null, onBarClick = null }) {
  container.innerHTML = '';
  const W = Math.max(320, container.clientWidth || 560);
  const barH = 20, gap = 10;
  const m = { top: 6, right: 86, bottom: 6, left: 176 };
  const H = height || m.top + m.bottom + items.length * (barH + gap);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'viz-plot' });
  container.appendChild(svg);
  const maxV = Math.max(...items.map((d) => Math.abs(d.value)), 1);
  const scale = (v) => (Math.abs(v) / maxV) * (W - m.left - m.right);
  const barColor = color || css('--series-1');

  items.forEach((d, i) => {
    const yPos = m.top + i * (barH + gap);
    const w = Math.max(2, scale(d.value));
    const r = Math.min(4, w / 2);
    // square at baseline (left), 4px rounded data-end (right)
    const path = `M${m.left},${yPos} h${w - r} a${r},${r} 0 0 1 ${r},${r} v${barH - 2 * r} a${r},${r} 0 0 1 ${-r},${r} h${-(w - r)} Z`;
    const bar = el('path', { d: path, fill: d.color || barColor, class: 'viz-bar' }, svg);
    const cat = el('text', { x: m.left - 8, y: yPos + barH / 2 + 3.5, 'text-anchor': 'end', class: 'viz-cat' }, svg);
    cat.textContent = d.label.length > 24 ? d.label.slice(0, 23) + '…' : d.label;
    const val = el('text', { x: m.left + w + 8, y: yPos + barH / 2 + 3.5, class: 'viz-endlabel' }, svg);
    val.textContent = fmt(d.value);
    const hit = el('rect', { x: 0, y: yPos - gap / 2, width: W, height: barH + gap, fill: 'transparent' }, svg);
    hit.addEventListener('mousemove', (evt) => showTip(`<div class="viz-tip-title">${d.label}</div><div><b>${fmt(d.value)}</b>${d.extra ? `</div><div>${d.extra}` : ''}</div>`, evt));
    hit.addEventListener('mouseleave', hideTip);
    if (onBarClick) {
      hit.style.cursor = 'pointer';
      hit.classList.add('viz-hit');
      hit.addEventListener('click', () => onBarClick(d));
      bar.classList.add('viz-clickable');
    }
  });
}

/** Waterfall / variance bridge. steps: [{label, value, type:'start'|'inc'|'dec'|'total'}] */
export function waterfall(container, { steps, fmt = (v) => v, height = 240 }) {
  container.innerHTML = '';
  const W = Math.max(340, container.clientWidth || 560);
  const H = height;
  const m = { top: 16, right: 12, bottom: 46, left: 80 };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'viz-plot' });
  container.appendChild(svg);

  let running = 0;
  const boxes = steps.map((s) => {
    if (s.type === 'start') { running = s.value; return { ...s, from: 0, to: s.value }; }
    if (s.type === 'total') { return { ...s, from: 0, to: running }; }
    const from = running; running += s.value;
    return { ...s, from, to: running };
  });
  const allVals = boxes.flatMap((b) => [b.from, b.to, 0]);
  const { ticks, lo, hi } = niceTicks(Math.min(...allVals), Math.max(...allVals));
  const y = (v) => m.top + (1 - (v - lo) / (hi - lo)) * (H - m.top - m.bottom);
  for (const t of ticks) {
    el('line', { x1: m.left, x2: W - m.right, y1: y(t), y2: y(t), class: 'viz-grid' }, svg);
    const txt = el('text', { x: m.left - 8, y: y(t) + 3, class: 'viz-tick', 'text-anchor': 'end' }, svg);
    txt.textContent = fmt(t);
  }
  const slot = (W - m.left - m.right) / boxes.length;
  const barW = Math.min(24, slot * 0.55);
  const incC = css('--series-1'), decC = css('--series-6'), totC = css('--axis');

  boxes.forEach((b, i) => {
    const cx = m.left + slot * i + slot / 2;
    const top = y(Math.max(b.from, b.to));
    const hgt = Math.max(2, Math.abs(y(b.from) - y(b.to)));
    const fill = b.type === 'dec' ? decC : (b.type === 'inc' ? incC : totC);
    const r = Math.min(4, hgt / 2, barW / 2);
    // rounded on the data-end (top for rises/totals, bottom for falls)
    const roundTop = b.type !== 'dec';
    const d0 = roundTop
      ? `M${cx - barW / 2},${top + hgt} v${-(hgt - r)} a${r},${r} 0 0 1 ${r},${-r} h${barW - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${hgt - r} Z`
      : `M${cx - barW / 2},${top} v${hgt - r} a${r},${r} 0 0 0 ${r},${r} h${barW - 2 * r} a${r},${r} 0 0 0 ${r},${-r} v${-(hgt - r)} Z`;
    el('path', { d: d0, fill, class: 'viz-bar' }, svg);
    // connector to next box
    if (i < boxes.length - 1) {
      el('line', { x1: cx + barW / 2, x2: m.left + slot * (i + 1) + slot / 2 - barW / 2, y1: y(b.to), y2: y(b.to), class: 'viz-connector' }, svg);
    }
    const lab = el('text', { x: cx, y: H - 26, class: 'viz-tick', 'text-anchor': 'middle' }, svg);
    const words = b.label.split(' ');
    lab.textContent = words[0].length > 12 ? words[0].slice(0, 11) + '…' : words[0];
    if (words.length > 1) {
      const l2 = el('text', { x: cx, y: H - 14, class: 'viz-tick', 'text-anchor': 'middle' }, svg);
      const rest = words.slice(1).join(' ');
      l2.textContent = rest.length > 12 ? rest.slice(0, 11) + '…' : rest;
    }
    const hit = el('rect', { x: cx - slot / 2, y: m.top, width: slot, height: H - m.top - m.bottom, fill: 'transparent' }, svg);
    hit.addEventListener('mousemove', (evt) => showTip(
      `<div class="viz-tip-title">${b.label}</div><div><b>${fmt(b.type === 'total' || b.type === 'start' ? b.to : b.value)}</b></div>`, evt));
    hit.addEventListener('mouseleave', hideTip);
  });
}

/** Heatmap with a single-hue sequential ramp. */
export function heatmap(container, { rows, cols, get, fmt = (v) => v, height = null, onCellClick = null }) {
  container.innerHTML = '';
  const ramp = ['--seq-100', '--seq-200', '--seq-300', '--seq-400', '--seq-500', '--seq-600', '--seq-700'].map(css);
  const W = Math.max(340, container.clientWidth || 560);
  const m = { top: 26, right: 8, bottom: 6, left: 150 };
  const cellH = 26, gapC = 2;
  const H = height || m.top + rows.length * (cellH + gapC) + m.bottom;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'viz-plot' });
  container.appendChild(svg);
  const cellW = (W - m.left - m.right - gapC * cols.length) / cols.length;

  const values = rows.flatMap((r) => cols.map((c) => get(r, c))).filter((v) => v != null);
  const minV = Math.min(...values), maxV = Math.max(...values);
  const shade = (v) => ramp[Math.max(0, Math.min(ramp.length - 1, Math.floor(((v - minV) / (maxV - minV || 1)) * ramp.length)))];

  cols.forEach((c, j) => {
    const t = el('text', { x: m.left + j * (cellW + gapC) + cellW / 2, y: 14, class: 'viz-tick', 'text-anchor': 'middle' }, svg);
    t.textContent = String(c).length > 14 ? String(c).slice(0, 13) + '…' : c;
  });
  rows.forEach((r, i) => {
    const t = el('text', { x: m.left - 8, y: m.top + i * (cellH + gapC) + cellH / 2 + 3.5, class: 'viz-cat', 'text-anchor': 'end' }, svg);
    t.textContent = String(r).length > 20 ? String(r).slice(0, 19) + '…' : r;
    cols.forEach((c, j) => {
      const v = get(r, c);
      if (v == null) return;
      const rect = el('rect', {
        x: m.left + j * (cellW + gapC), y: m.top + i * (cellH + gapC),
        width: cellW, height: cellH, rx: 3, fill: shade(v)
      }, svg);
      rect.addEventListener('mousemove', (evt) => showTip(`<div class="viz-tip-title">${r} · ${c}</div><div><b>${fmt(v)}</b></div>`, evt));
      rect.addEventListener('mouseleave', hideTip);
      if (onCellClick) { rect.style.cursor = 'pointer'; rect.addEventListener('click', () => onCellClick(r, c, v)); }
    });
  });
}

/** 12-point sparkline for stat tiles: de-emphasised line, accent end dot. */
export function sparkline(values, w = 96, h = 28) {
  const min = Math.min(...values), max = Math.max(...values);
  const x = (i) => 2 + (i / (values.length - 1)) * (w - 10);
  const y = (v) => 3 + (1 - (v - min) / (max - min || 1)) * (h - 6);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join('');
  const last = values[values.length - 1];
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
    <path d="${d}" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(values.length - 1)}" cy="${y(last)}" r="3.5" fill="var(--series-1)" stroke="var(--surface-1)" stroke-width="2"/>
  </svg>`;
}

/** KPI stat tile per figure contract: label · value · delta · trend. */
export function statTile({ label, value, delta = null, deltaLabel = 'vs prior period', upIsGood = true, trend = null, status = null }) {
  const div = document.createElement('div');
  div.className = 'kpi-tile';
  let deltaHtml = '';
  if (delta != null) {
    const up = delta >= 0;
    const good = up === upIsGood;
    deltaHtml = `<span class="kpi-delta ${good ? 'delta-good' : 'delta-bad'}">${up ? '▲' : '▼'} ${Math.abs(delta).toFixed(1)}% <span class="kpi-delta-ctx">${deltaLabel}</span></span>`;
  }
  const statusHtml = status ? `<span class="kpi-status status-${status.level}">${status.icon} ${status.text}</span>` : '';
  div.innerHTML = `
    <div class="kpi-label">${label}</div>
    <div class="kpi-value">${value}</div>
    <div class="kpi-foot">${deltaHtml}${statusHtml}${trend ? `<span class="kpi-trend">${sparkline(trend)}</span>` : ''}</div>`;
  return div;
}

/** Detail table with optional conditional signals and row drill. */
export function dataTable(container, { columns, rows, onRowClick = null, maxRows = 12 }) {
  container.innerHTML = '';
  const table = document.createElement('table');
  table.className = 'detail-table';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>${columns.map((c) => `<th class="${c.numeric ? 'num' : ''}">${c.label}</th>`).join('')}</tr>`;
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  rows.slice(0, maxRows).forEach((row) => {
    const tr = document.createElement('tr');
    tr.innerHTML = columns.map((c) => {
      const v = typeof c.get === 'function' ? c.get(row) : row[c.key];
      const cls = [c.numeric ? 'num' : '', c.signal ? c.signal(row) || '' : ''].join(' ').trim();
      return `<td class="${cls}">${v ?? '—'}</td>`;
    }).join('');
    if (onRowClick) {
      tr.classList.add('row-clickable');
      tr.addEventListener('click', () => onRowClick(row));
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);
  if (rows.length > maxRows) {
    const note = document.createElement('div');
    note.className = 'table-note';
    note.textContent = `Showing ${maxRows} of ${rows.length} rows — refine filters or drill for more.`;
    container.appendChild(note);
  }
}
