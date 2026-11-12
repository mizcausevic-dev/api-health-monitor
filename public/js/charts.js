// Dependency-free SVG charts. Every color is a CSS custom property, so
// switching theme or light/dark restyles charts without re-rendering.
// Each chart is rendered at the container's real pixel width (no viewBox
// stretching), so text stays crisp and readable at every size.
import { esc } from './format.js';

const tipEl = () => document.getElementById('tooltip');

export function hideTip() {
  const t = tipEl();
  if (t) t.hidden = true;
}

function showTip(evt, html) {
  const t = tipEl();
  t.innerHTML = html;
  t.hidden = false;
  const pad = 14;
  const r = t.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
  t.style.left = `${Math.max(8, x)}px`;
  t.style.top = `${Math.max(8, y)}px`;
}

const row = (color, label, value) => `<div class="t-row"><span><i style="background:${color}"></i>${esc(label)}</span><b>${esc(value)}</b></div>`;

// Re-render on width change; returns a disposer.
const observers = new WeakMap();
export function mount(el, render) {
  render();
  let last = el.clientWidth;
  let frame = 0;
  const ro = new ResizeObserver(() => {
    if (Math.abs(el.clientWidth - last) < 4) return;
    last = el.clientWidth;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(render);
  });
  ro.observe(el);
  observers.get(el)?.disconnect();
  observers.set(el, ro);
}

export function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  if (ticks.at(-1) < max) ticks.push(ticks.at(-1) + step);
  return ticks;
}

function frame(el, height, left = 48) {
  const W = Math.max(260, Math.floor(el.clientWidth));
  const m = { t: 10, r: 12, b: 24, l: left };
  return { W, H: height, m, iw: W - m.l - m.r, ih: height - m.t - m.b };
}

function yAxis({ W, m, ih }, ticks, Y, fmt) {
  return ticks
    .map((v) => `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text class="axis" x="${m.l - 8}" y="${Y(v) + 3.5}" text-anchor="end">${esc(fmt(v))}</text>`)
    .join('') + `<line class="gridline" x1="${m.l}" x2="${m.l}" y1="${m.t}" y2="${m.t + ih}" />`;
}

function xLabels(n, X, y, label, maxLabels) {
  if (!n) return '';
  const step = Math.max(1, Math.ceil(n / maxLabels));
  let out = '';
  for (let i = 0; i < n; i += step) out += `<text class="axis" x="${X(i)}" y="${y}" text-anchor="middle">${esc(label(i))}</text>`;
  return out;
}

function pathFor(points, key, X, Y) {
  let d = '';
  let pen = false;
  points.forEach((p, i) => {
    const v = p[key];
    if (v == null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

function areaFor(points, key, X, Y, base) {
  const segs = [];
  let cur = [];
  points.forEach((p, i) => {
    if (p[key] == null) {
      if (cur.length) segs.push(cur);
      cur = [];
    } else cur.push(i);
  });
  if (cur.length) segs.push(cur);
  return segs
    .map((s) => `M${X(s[0]).toFixed(1)},${base}` + s.map((i) => `L${X(i).toFixed(1)},${Y(points[i][key]).toFixed(1)}`).join('') + `L${X(s.at(-1)).toFixed(1)},${base}Z`)
    .join('');
}

// Multi-series time line chart with failure bands and a hover crosshair.
export function lineChart(el, { points, series, height = 230, yFormat = String, xLabel, tipTitle, failuresKey = 'failures' }) {
  mount(el, () => {
    const f = frame(el, height);
    const { W, H, m, iw, ih } = f;
    const n = points.length;
    const vals = points.flatMap((p) => series.map((s) => p[s.key])).filter((v) => v != null);
    const ticks = niceTicks(Math.max(1, ...vals));
    const yMax = ticks.at(-1);
    const X = (i) => m.l + (n <= 1 ? iw / 2 : (i * iw) / (n - 1));
    const Y = (v) => m.t + ih - (v / yMax) * ih;
    const bw = n > 1 ? iw / (n - 1) : iw;
    const id = `g${Math.random().toString(36).slice(2, 8)}`;
    let svg = `<svg width="${W}" height="${H}" role="img" aria-label="${esc(el.dataset.label || 'Latency chart')}">`;
    svg += `<defs>${series.filter((s) => s.area).map((s) => `<linearGradient id="${id}${s.key}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" style="stop-color:${s.color};stop-opacity:.28"/><stop offset="1" style="stop-color:${s.color};stop-opacity:0"/></linearGradient>`).join('')}</defs>`;
    svg += yAxis(f, ticks, Y, yFormat);
    points.forEach((p, i) => {
      if (p[failuresKey] > 0) svg += `<rect x="${X(i) - bw / 2}" y="${m.t}" width="${bw}" height="${ih}" style="fill:var(--err);opacity:.12"/>`;
      else if (p.degraded > 0) svg += `<rect x="${X(i) - bw / 2}" y="${m.t}" width="${bw}" height="${ih}" style="fill:var(--warn);opacity:.08"/>`;
    });
    for (const s of series) {
      if (s.area) svg += `<path d="${areaFor(points, s.key, X, Y, m.t + ih)}" fill="url(#${id}${s.key})"/>`;
      svg += `<path d="${pathFor(points, s.key, X, Y)}" fill="none" style="stroke:${s.color}" stroke-width="${s.width || 2}" stroke-linejoin="round" stroke-linecap="round" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''}/>`;
      // Isolated points (no neighbours) would be invisible as a path.
      points.forEach((p, i) => {
        if (p[s.key] != null && points[i - 1]?.[s.key] == null && points[i + 1]?.[s.key] == null) svg += `<circle cx="${X(i)}" cy="${Y(p[s.key])}" r="2.5" style="fill:${s.color}"/>`;
      });
    }
    svg += xLabels(n, X, H - 6, (i) => xLabel(points[i], i), Math.max(2, Math.floor(iw / 90)));
    svg += `<g class="hover" visibility="hidden"><line class="crosshair" y1="${m.t}" y2="${m.t + ih}"/>${series.map((s) => `<circle r="4" style="fill:var(--surface);stroke:${s.color}" stroke-width="2"/>`).join('')}</g>`;
    svg += `<rect class="overlay" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent"/></svg>`;
    el.innerHTML = svg;

    const root = el.querySelector('svg');
    const hover = root.querySelector('.hover');
    const line = hover.querySelector('line');
    const dots = hover.querySelectorAll('circle');
    const move = (evt) => {
      const box = root.getBoundingClientRect();
      const x = evt.clientX - box.left;
      const i = Math.max(0, Math.min(n - 1, Math.round(((x - m.l) / iw) * (n - 1))));
      const p = points[i];
      hover.setAttribute('visibility', 'visible');
      line.setAttribute('x1', X(i));
      line.setAttribute('x2', X(i));
      series.forEach((s, k) => {
        const v = p[s.key];
        dots[k].setAttribute('visibility', v == null ? 'hidden' : 'visible');
        if (v != null) {
          dots[k].setAttribute('cx', X(i));
          dots[k].setAttribute('cy', Y(v));
        }
      });
      showTip(evt, `<div class="t-head">${esc(tipTitle(p, i))}</div>${series.map((s) => row(s.color, s.label, p[s.key] == null ? '–' : yFormat(p[s.key]))).join('')}${p.checks != null ? row('var(--muted)', 'checks', `${p.checks}${p[failuresKey] ? ` · ${p[failuresKey]} failed` : ''}`) : ''}`);
    };
    const leave = () => {
      hover.setAttribute('visibility', 'hidden');
      hideTip();
    };
    const overlay = root.querySelector('.overlay');
    overlay.addEventListener('pointermove', move);
    overlay.addEventListener('pointerleave', leave);
  });
}

// Stacked columns, e.g. DNS / TCP / TLS / TTFB / transfer per bucket.
export function stackedBars(el, { points, keys, height = 230, yFormat = String, xLabel, tipTitle }) {
  mount(el, () => {
    const f = frame(el, height);
    const { W, H, m, iw, ih } = f;
    const n = points.length;
    const totals = points.map((p) => keys.reduce((a, k) => a + (p[k.key] || 0), 0));
    const ticks = niceTicks(Math.max(1, ...totals));
    const yMax = ticks.at(-1);
    const Y = (v) => m.t + ih - (v / yMax) * ih;
    const slot = iw / Math.max(1, n);
    const bw = Math.max(2, Math.min(28, slot * 0.72));
    const X = (i) => m.l + slot * i + slot / 2;
    let svg = `<svg width="${W}" height="${H}" role="img" aria-label="${esc(el.dataset.label || 'Stacked bar chart')}">${yAxis(f, ticks, Y, yFormat)}`;
    points.forEach((p, i) => {
      let acc = 0;
      svg += `<g data-i="${i}">`;
      for (const k of keys) {
        const v = p[k.key] || 0;
        if (v <= 0) continue;
        const y0 = Y(acc + v);
        svg += `<rect x="${(X(i) - bw / 2).toFixed(1)}" y="${y0.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, Y(acc) - y0).toFixed(1)}" style="fill:${k.color}"/>`;
        acc += v;
      }
      svg += `<rect class="hit" x="${m.l + slot * i}" y="${m.t}" width="${slot}" height="${ih}" fill="transparent"/></g>`;
    });
    svg += `${xLabels(n, X, H - 6, (i) => xLabel(points[i], i), Math.max(2, Math.floor(iw / 90)))}</svg>`;
    el.innerHTML = svg;
    el.querySelectorAll('g[data-i]').forEach((g) => {
      const p = points[Number(g.dataset.i)];
      g.addEventListener('pointermove', (evt) => {
        const total = keys.reduce((a, k) => a + (p[k.key] || 0), 0);
        showTip(evt, `<div class="t-head">${esc(tipTitle(p))}</div>${keys.map((k) => row(k.color, k.label, p[k.key] == null ? '–' : yFormat(p[k.key]))).join('')}${row('transparent', 'total', yFormat(total))}`);
      });
      g.addEventListener('pointerleave', hideTip);
    });
  });
}

// Latency histogram with the Apdex threshold drawn in.
export function histogramChart(el, { bins, height = 200, threshold }) {
  mount(el, () => {
    const f = frame(el, height, 36);
    const { W, H, m, iw, ih } = f;
    const shown = bins.slice(0, bins.findLastIndex((b) => b.count > 0) + 2 || bins.length);
    const n = Math.max(1, shown.length);
    const ticks = niceTicks(Math.max(1, ...shown.map((b) => b.count)), 3);
    const yMax = ticks.at(-1);
    const Y = (v) => m.t + ih - (v / yMax) * ih;
    const slot = iw / n;
    const label = (b) => (b.from_ms >= 1000 ? `${b.from_ms / 1000}s` : `${b.from_ms}`);
    let svg = `<svg width="${W}" height="${H}" role="img" aria-label="${esc(el.dataset.label || 'Latency histogram')}">${yAxis(f, ticks, Y, (v) => String(v))}`;
    shown.forEach((b, i) => {
      const x = m.l + slot * i + 1;
      const hot = threshold != null && b.from_ms >= threshold;
      svg += `<rect data-i="${i}" x="${x.toFixed(1)}" y="${Y(b.count).toFixed(1)}" width="${Math.max(1, slot - 2).toFixed(1)}" height="${(m.t + ih - Y(b.count)).toFixed(1)}" rx="2" style="fill:${hot ? 'var(--warn)' : 'var(--c2)'}"/>`;
      if (i % Math.max(1, Math.ceil(n / Math.floor(iw / 42))) === 0) svg += `<text class="axis" x="${x}" y="${H - 6}">${label(b)}</text>`;
    });
    svg += '</svg>';
    el.innerHTML = svg;
    el.querySelectorAll('rect[data-i]').forEach((r) => {
      const b = shown[Number(r.dataset.i)];
      r.addEventListener('pointermove', (evt) => showTip(evt, `<div class="t-head">${b.from_ms}–${b.to_ms ?? '∞'} ms</div>${row('var(--c2)', 'checks', String(b.count))}`));
      r.addEventListener('pointerleave', hideTip);
    });
  });
}

// Semicircle gauge for error budget remaining (value can go negative).
export function gauge(el, { value, label, sub }) {
  const v = value == null ? 0 : Math.max(0, Math.min(1, value));
  const color = value == null ? 'var(--muted)' : value > 0.5 ? 'var(--ok)' : value > 0 ? 'var(--warn)' : 'var(--err)';
  const r = 70;
  const cx = 90;
  const cy = 86;
  const len = Math.PI * r;
  el.innerHTML = `<svg width="180" height="104" viewBox="0 0 180 104" role="img" aria-label="${esc(label)}" style="margin:0 auto">
    <path d="M${cx - r},${cy} A${r},${r} 0 0 1 ${cx + r},${cy}" fill="none" style="stroke:var(--grid)" stroke-width="14" stroke-linecap="round"/>
    <path d="M${cx - r},${cy} A${r},${r} 0 0 1 ${cx + r},${cy}" fill="none" style="stroke:${color};transition:stroke-dashoffset .8s cubic-bezier(.2,.8,.2,1)" stroke-width="14" stroke-linecap="round" stroke-dasharray="${len}" stroke-dashoffset="${len * (1 - v)}"/>
    <text x="${cx}" y="${cy - 14}" text-anchor="middle" style="fill:var(--text);font:700 24px var(--font-display)">${esc(label)}</text>
    <text x="${cx}" y="${cy + 4}" text-anchor="middle" style="fill:var(--muted);font:11px var(--font)">${esc(sub)}</text>
  </svg>`;
}

export function sparkline(values, { width = 120, height = 34, color = 'var(--accent)' } = {}) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts.length < 2) return '';
  const max = Math.max(...pts.map(([, v]) => v));
  const min = Math.min(...pts.map(([, v]) => v));
  const X = (i) => (i / (values.length - 1)) * (width - 2) + 1;
  const Y = (v) => height - 2 - ((v - min) / (max - min || 1)) * (height - 6);
  const d = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  return `<svg class="spark" width="${width}" height="${height}" aria-hidden="true"><path d="${d}" fill="none" style="stroke:${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" opacity=".85"/></svg>`;
}
