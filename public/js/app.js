import { get, send, subscribe, STATIC, ApiError } from './api.js';
import { lineChart, stackedBars, histogramChart, gauge, sparkline, hideTip } from './charts.js';
import { esc, ms, pct, ago, duration, when, clock, day, host, tone } from './format.js';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');

// ------------------------------------------------------------------ themes
const THEMES = [
  ['bento', 'Bento Grid'],
  ['cosmic', 'Cosmic Cyber'],
  ['swiss', 'Swiss Architect'],
  ['aqua', 'Aqua Web 2.0'],
  ['brutalist', 'Pop Brutalist'],
  ['steel', 'Steel Tactical'],
  ['parchment', 'Parchment'],
];
const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch { /* private mode */ }
  },
};

function initTheme() {
  const root = document.documentElement;
  const select = $('#theme-select');
  select.innerHTML = THEMES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  select.value = root.dataset.theme;
  select.addEventListener('change', () => {
    root.dataset.theme = select.value;
    store.set('ahm.theme', select.value);
  });
  const btn = $('#scheme-toggle');
  const sync = () => btn.setAttribute('aria-label', `Switch to ${root.dataset.scheme === 'dark' ? 'light' : 'dark'} mode`);
  sync();
  btn.addEventListener('click', () => {
    root.dataset.scheme = root.dataset.scheme === 'dark' ? 'light' : 'dark';
    store.set('ahm.scheme', root.dataset.scheme);
    sync();
  });
}

// ------------------------------------------------------------------ helpers
function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 5000);
}

const statusBadge = (s) => `<span class="status ${esc(s)}">${esc(s)}</span>`;
const WINDOWS = STATIC ? ['6h', '24h', '7d'] : ['1h', '6h', '24h', '7d'];
const BUCKETS = { '1h': 60, '6h': 72, '24h': 48, '7d': 56 };
const tickLabel = (win) => (p) => (win === '7d' ? day(p.t) : clock(p.t));
const tipTime = (win) => (p) => {
  const start = Date.parse(p.t);
  const width = { '1h': 60e3, '6h': 300e3, '24h': 1800e3, '7d': 3 * 3600e3 }[win];
  return `${win === '7d' ? `${day(start)} ` : ''}${clock(start)} – ${clock(start + width)}`;
};
const PHASES = [
  { key: 'dns_ms', label: 'DNS', color: 'var(--c1)' },
  { key: 'connect_ms', label: 'TCP connect', color: 'var(--c2)' },
  { key: 'tls_ms', label: 'TLS handshake', color: 'var(--c3)' },
  { key: 'ttfb_ms', label: 'Server (TTFB)', color: 'var(--c4)' },
  { key: 'transfer_ms', label: 'Transfer', color: 'var(--c5)' },
];
const legend = (items) => `<div class="legend">${items.map((i) => `<span><i class="${i.line ? 'line' : ''}" style="background:${i.color}"></i>${esc(i.label)}</span>`).join('')}</div>`;

function describeAssertion(a) {
  const subject = a.property ? `${a.source}.${a.property}` : a.source;
  const target = a.target === undefined ? '' : ` ${JSON.stringify(a.target)}`;
  return `${subject} ${a.op}${target}`;
}

const state = { window: store.get('ahm.window') && WINDOWS.includes(store.get('ahm.window')) ? store.get('ahm.window') : '24h', api: null, generatedAt: null };

// ------------------------------------------------------------------ router
const routes = [
  [/^#?\/?$/, renderOverview, 'overview'],
  [/^#\/monitors\/([\w-]+)$/, renderMonitor, 'overview'],
  [/^#\/incidents$/, renderIncidents, 'incidents'],
  [/^#\/api$/, renderApi, 'api'],
];
let renderToken = 0;

async function route() {
  hideTip();
  // Deep links may carry a window: #/monitors/mon_x?window=6h
  const [hash, query = ''] = (location.hash || '#/').split('?');
  const linked = new URLSearchParams(query).get('window');
  if (WINDOWS.includes(linked)) state.window = linked;
  const match = routes.map(([re, fn, nav]) => [hash.match(re), fn, nav]).find(([m]) => m);
  const [m, fn, nav] = match || [[], renderNotFound, ''];
  document.querySelectorAll('.tabs a').forEach((a) => (a.dataset.nav === nav ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  const token = ++renderToken;
  view.setAttribute('aria-busy', 'true');
  try {
    await fn(...m.slice(1), token);
  } catch (err) {
    if (token !== renderToken) return;
    view.innerHTML = `<div class="card"><h1>Could not load this view</h1><p class="code">${esc(err instanceof ApiError ? `${err.status} ${err.problem.title || ''}: ${err.message}` : err.message)}</p><p><a href="#/">Back to overview</a></p></div>`;
  } finally {
    view.setAttribute('aria-busy', 'false');
  }
}
const stale = (token) => token !== renderToken;

function windowSwitch() {
  return `<div class="segmented" role="group" aria-label="Time window">${WINDOWS.map((w) => `<button type="button" data-window="${w}" aria-pressed="${w === state.window}">${w}</button>`).join('')}</div>`;
}
function bindWindowSwitch() {
  view.querySelectorAll('[data-window]').forEach((b) =>
    b.addEventListener('click', () => {
      state.window = b.dataset.window;
      store.set('ahm.window', state.window);
      if (location.hash.includes('?')) history.replaceState(null, '', location.hash.split('?')[0]);
      route();
    }),
  );
}

// ---------------------------------------------------------------- overview
async function renderOverview(token) {
  if (!view.innerHTML.trim()) view.innerHTML = '<div class="grid">' + '<div class="span-3 skeleton"></div>'.repeat(4) + '<div class="span-12 skeleton" style="height:320px"></div></div>';
  const { data: o } = await get(`/v1/overview?window=${state.window}`);
  if (stale(token)) return;
  state.generatedAt = o.generated_at;
  updatePill();
  const t = o.totals;
  const lat = o.latency_ms;
  const p95Trend = o.trend.map((b) => b.p95_ms);
  const availTone = tone(o.availability, 0.995);
  view.innerHTML = `
  <div class="page-head">
    <div><h1>Overview</h1><p>${t.monitors} monitors · ${o.checks.toLocaleString()} checks in the last ${o.window} · generated ${ago(o.generated_at)}</p></div>
    ${windowSwitch()}
  </div>
  <section class="grid" aria-label="Key indicators">
    <div class="card kpi span-3"><span class="label">Monitors healthy</span><span class="value">${t.up}<small>/ ${t.monitors}</small></span>
      <span class="delta">${t.degraded ? `<span class="tone-warn">${t.degraded} degraded</span> · ` : ''}${t.down ? `<span class="tone-err">${t.down} down</span>` : 'none down'}${t.paused ? ` · ${t.paused} paused` : ''}</span></div>
    <div class="card kpi span-3"><span class="label">Availability · ${o.window}</span><span class="value tone-${availTone}">${pct(o.availability)}</span>
      <span class="delta">${o.checks.toLocaleString()} checks across all monitors</span></div>
    <div class="card kpi span-3"><span class="label">p95 latency · ${o.window}</span><span class="value">${ms(lat.p95)}</span>
      <span class="delta">p50 ${ms(lat.p50)} · p99 ${ms(lat.p99)}</span>${sparkline(p95Trend, { color: 'var(--c3)' })}</div>
    <div class="card kpi span-3"><span class="label">Open incidents</span><span class="value ${t.open_incidents ? 'tone-err' : 'tone-ok'}">${t.open_incidents}</span>
      <span class="delta"><a href="#/incidents">Incident history</a></span></div>

    <div class="card span-8">
      <div class="card-head"><h2>Latency across all monitors</h2>${legend([{ label: 'p50', color: 'var(--c2)' }, { label: 'p95', color: 'var(--c3)', line: true }, { label: 'degraded', color: 'color-mix(in srgb, var(--warn) 35%, transparent)' }, { label: 'failed', color: 'color-mix(in srgb, var(--err) 35%, transparent)' }])}</div>
      <div class="chart" id="ov-latency" data-label="Median and 95th percentile latency over time across all monitors"></div>
    </div>
    <div class="card span-4">
      <div class="card-head"><h2>Unexpected responses</h2><span class="sub">latest ${o.recent_failures.length}</span></div>
      ${o.recent_failures.length ? `<div class="log">${o.recent_failures.slice(0, 6).map(failureItem).join('')}</div>` : '<div class="empty">No failed or degraded checks in this window.</div>'}
    </div>

    <div class="card span-12">
      <div class="card-head"><h2>Monitors</h2><span class="sub">select a row for latency breakdown and response log</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Endpoint</th><th>Status</th><th class="hide-sm">Last ${o.monitors[0]?.recent.length || 40} checks</th><th class="num">Availability</th><th class="num">p50</th><th class="num hide-sm">p95</th><th class="num hide-sm">Apdex</th><th class="hide-sm">Checked</th></tr></thead>
        <tbody>${o.monitors.map(monitorRow).join('') || '<tr><td colspan="8"><div class="empty">No monitors yet.</div></td></tr>'}</tbody>
      </table></div>
    </div>
  </section>`;
  bindWindowSwitch();
  view.querySelectorAll('tr[data-href]').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    location.hash = tr.dataset.href;
  }));
  lineChart($('#ov-latency'), {
    height: window.innerWidth > 1100 ? 400 : 240,
    points: o.trend,
    series: [
      { key: 'p50_ms', label: 'p50', color: 'var(--c2)', area: true },
      { key: 'p95_ms', label: 'p95', color: 'var(--c3)', dash: '5 4' },
    ],
    yFormat: (v) => ms(v, { short: true }),
    xLabel: tickLabel(state.window === '7d' ? '7d' : '24h'),
    tipTitle: (p) => when(p.t),
  });
}

function monitorRow(m) {
  const strip = m.recent.map((r) => {
    const h = r.ms == null ? 100 : Math.max(18, Math.min(100, (r.ms / Math.max(1, m.p95_ms || r.ms)) * 80));
    return `<i class="${r.outcome}" style="height:${h.toFixed(0)}%" title="${esc(`${when(r.t)} · ${r.outcome} · ${r.code ?? 'no response'} · ${ms(r.ms)}`)}"></i>`;
  }).join('');
  return `<tr class="clickable" data-href="#/monitors/${esc(m.id)}">
    <td><a class="m-name" href="#/monitors/${esc(m.id)}">${esc(m.name)}</a><span class="m-url"><span class="method">${esc(m.method)}</span>${esc(host(m.url))}</span></td>
    <td>${statusBadge(m.status)}</td>
    <td class="hide-sm"><div class="strip" aria-label="${m.recent.filter((r) => r.outcome !== 'up').length} of ${m.recent.length} recent checks failed or degraded">${strip}</div></td>
    <td class="num tone-${tone(m.availability, 0.995)}">${pct(m.availability)}</td>
    <td class="num">${ms(m.p50_ms)}</td>
    <td class="num hide-sm">${ms(m.p95_ms)}</td>
    <td class="num hide-sm">${m.apdex ?? '–'}</td>
    <td class="hide-sm" title="${esc(when(m.last_checked_at))}">${ago(m.last_checked_at)}</td>
  </tr>`;
}

function failureItem(c) {
  const msg = c.error ? `${c.error.code}: ${c.error.message}` : c.failed_assertions[0]?.message || `HTTP ${c.status_code}`;
  return `<details><summary><span class="when">${esc(when(c.started_at))}</span>${statusBadge(c.outcome)}<span class="msg">${esc(msg)}</span><span class="who">${esc(c.monitor_name || '')}</span></summary>
    <div class="body">${checkDetail(c)}</div></details>`;
}

function checkDetail(c) {
  const lines = [
    `<div class="code">probe <b>${esc(c.probe)}</b> · status <b>${esc(c.status_code ?? 'none')}</b> · total <b>${ms(c.timings.total_ms)}</b>${c.remote_address ? ` · ${esc(c.remote_address)}` : ''}${c.monitor_id ? ` · <a href="#/monitors/${esc(c.monitor_id)}">monitor</a>` : ''}</div>`,
  ];
  if (c.failed_assertions.length) lines.push(`<pre>${esc(c.failed_assertions.map((f) => `✗ ${f.message}`).join('\n'))}</pre>`);
  if (c.response_sample) {
    const hdrs = Object.entries(c.response_sample.headers).map(([k, v]) => `${k}: ${v}`).join('\n');
    lines.push(`<pre>${esc(`${hdrs}\n\n${c.response_sample.body}${c.response_sample.body_truncated ? '\n… (truncated)' : ''}`)}</pre>`);
  }
  return lines.join('');
}

// ----------------------------------------------------------------- monitor
async function renderMonitor(id, token) {
  const win = state.window;
  const buckets = BUCKETS[win];
  const [mon, st, stats, fails, recent, incidents] = await Promise.all([
    get(`/v1/monitors/${id}`),
    get(`/v1/monitors/${id}/state`),
    get(`/v1/monitors/${id}/stats?window=${win}&buckets=${buckets}`),
    get(`/v1/monitors/${id}/checks?outcome=fail&limit=25`),
    get(`/v1/monitors/${id}/checks?limit=15`),
    get(`/v1/incidents?monitor_id=${id}&limit=10`),
  ]);
  if (stale(token)) return;
  const m = mon.data;
  const s = stats.data;
  const sum = s.summary;
  const status = st.data.status;
  const totalCodes = Object.values(s.status_codes).reduce((a, b) => a + b, 0) || 1;
  const budget = sum.error_budget;
  const apdexT = m.assertions.find((a) => a.source === 'latency_ms')?.target ?? 500;
  view.innerHTML = `
  <a class="back" href="#/">← All monitors</a>
  <div class="card span-12" style="margin-bottom:var(--gap)">
    <div class="detail-head">
      <div>
        <h1>${esc(m.name)} ${statusBadge(status)}</h1>
        <div class="detail-meta"><span><span class="method">${esc(m.method)}</span><span class="mono">${esc(m.url)}</span></span>
          <span>every <b>${m.interval_s >= 60 ? `${m.interval_s / 60} min` : `${m.interval_s}s`}</b></span><span>timeout <b>${ms(m.timeout_ms)}</b></span>
          <span>SLO <b>${pct(m.slo_target, m.slo_target >= 0.999 ? 2 : 1)}</b></span><span>incident after <b>${m.failure_threshold}</b> failures</span>
          <span>last check <b>${ago(st.data.last_checked_at)}</b></span></div>
        <div class="chips">${(m.assertions.length ? m.assertions : [{ source: 'status', op: 'lt', target: 400 }]).map((a) => `<span class="chip">${esc(describeAssertion(a))}</span>`).join('')}${m.tags.map((t) => `<span class="chip tag">#${esc(t)}</span>`).join('')}</div>
      </div>
      <div class="actions">
        ${windowSwitch()}
        ${STATIC ? '' : `<button class="btn" id="run-now" type="button">Run check now</button>
        <button class="btn" id="toggle-pause" type="button">${m.paused ? 'Resume' : 'Pause'}</button>
        <button class="btn" id="edit" type="button">Edit</button>
        <button class="btn danger ghost" id="delete" type="button">Delete</button>`}
      </div>
    </div>
  </div>
  <section class="grid">
    <div class="card span-8">
      <div class="card-head"><h2>Latency · ${esc(win)}</h2>${legend([{ label: 'p50', color: 'var(--c2)' }, { label: 'p95', color: 'var(--c3)', line: true }, { label: 'max', color: 'var(--c5)', line: true }, { label: 'degraded', color: 'color-mix(in srgb, var(--warn) 35%, transparent)' }, { label: 'failed', color: 'color-mix(in srgb, var(--err) 35%, transparent)' }])}</div>
      <div class="stat-row" style="margin-bottom:12px">
        <div><span>p50</span><b>${ms(sum.latency_ms.p50)}</b></div><div><span>p90</span><b>${ms(sum.latency_ms.p90)}</b></div>
        <div><span>p95</span><b>${ms(sum.latency_ms.p95)}</b></div><div><span>p99</span><b>${ms(sum.latency_ms.p99)}</b></div>
        <div><span>Apdex (T=${apdexT})</span><b>${sum.apdex ?? '–'}</b></div><div><span>Checks</span><b>${sum.checks}</b></div>
      </div>
      <div class="chart" id="m-latency" data-label="Latency percentiles over time"></div>
    </div>
    <div class="card span-4">
      <div class="card-head"><h2>Error budget</h2><span class="sub">SLO ${pct(budget.slo_target, 2)}</span></div>
      <div id="m-gauge" style="display:grid;place-items:center"></div>
      <div class="stat-row" style="margin-top:8px">
        <div><span>Availability</span><b class="tone-${tone(sum.availability, m.slo_target)}">${pct(sum.availability)}</b></div>
        <div><span>Failed</span><b>${esc(budget.failures)}</b></div>
        <div><span>Allowed</span><b>${esc(budget.allowed_failures ?? '–')}</b></div>
      </div>
      <p class="card-foot">${budget.status === 'insufficient_data'
        ? `Not enough checks to measure: ${esc(sum.checks)} in ${esc(win)}, but a ${esc(pct(budget.slo_target, 2))} SLO needs at least ${esc(budget.min_checks)} before even one failure is allowed. Pick a longer window.`
        : `Failures allowed by the SLO over ${esc(win)}: ${esc(budget.allowed_failures ?? 0)} of ${esc(sum.checks)} checks. Degraded (slow but correct) checks count as available.`}</p>
    </div>
    <div class="card span-12">
      <div class="card-head"><h2>Availability by interval</h2><span class="sub">${sum.outcomes.up} up · ${sum.outcomes.degraded} degraded · ${sum.outcomes.down} down</span></div>
      <div class="uptime" role="img" aria-label="Availability per time bucket">${s.series.map((b) => `<i class="${b.availability == null ? 'none' : b.availability >= 1 && !b.degraded ? '' : b.availability >= 1 ? 'warn' : b.availability >= 0.5 ? 'warn' : 'err'}" title="${esc(`${tipTime(win)(b)} · ${b.checks ? `${pct(b.availability, 1)} of ${b.checks}` : 'no checks'}`)}"></i>`).join('')}</div>
      <div class="uptime-legend"><span>${esc(when(s.from))}</span><span>now</span></div>
    </div>
    <div class="card span-5">
      <div class="card-head"><h2>Where the time goes</h2><span class="sub">mean per interval</span></div>
      <div class="chart" id="m-phases" data-label="Mean latency per connection phase over time"></div>
      ${legend(PHASES)}
    </div>
    <div class="card span-4">
      <div class="card-head"><h2>Latency distribution</h2><span class="sub">ms · <span class="tone-warn">≥ ${apdexT} ms</span></span></div>
      <div class="chart" id="m-hist" data-label="Histogram of response times"></div>
    </div>
    <div class="card span-3">
      <div class="card-head"><h2>Responses</h2><span class="sub">${sum.checks} checks</span></div>
      <div class="bars">${Object.entries(s.status_codes).sort((a, b) => b[1] - a[1]).map(([code, n]) => `<div class="row"><span class="mono">${esc(code)}</span><div class="track"><div class="fill ${code.startsWith('error') || code.startsWith('5') ? 'err' : code.startsWith('4') ? 'warn' : ''}" style="width:${((n / totalCodes) * 100).toFixed(1)}%"></div></div><span class="num">${n}</span></div>`).join('') || '<div class="empty">No checks yet.</div>'}</div>
      <h3 style="margin:16px 0 8px">Phase averages</h3>
      <div class="bars">${PHASES.map((p) => `<div class="row"><span>${esc(p.label)}</span><div class="track"><div class="fill" style="background:${p.color};width:${Math.min(100, ((s.phases_ms[p.key] || 0) / Math.max(1, ...PHASES.map((x) => s.phases_ms[x.key] || 0))) * 100).toFixed(1)}%"></div></div><span class="num">${ms(s.phases_ms[p.key], { short: true })}</span></div>`).join('')}</div>
    </div>
    <div class="card span-7">
      <div class="card-head"><h2>Unexpected responses</h2><span class="sub">failed or degraded checks with captured response</span></div>
      ${fails.data.data.length ? `<div class="log">${fails.data.data.map((c) => failureItem({ ...c, monitor_id: undefined })).join('')}</div>` : '<div class="empty">Every recorded check met its assertions.</div>'}
    </div>
    <div class="card span-5">
      <div class="card-head"><h2>Recent checks</h2><span class="sub">newest first</span></div>
      <div class="table-wrap"><table><thead><tr><th>Time</th><th>Result</th><th class="num">Code</th><th class="num">Total</th><th class="hide-sm">Probe</th></tr></thead>
      <tbody>${recent.data.data.map((c) => `<tr><td class="mono">${esc(when(c.started_at))}</td><td>${statusBadge(c.outcome)}</td><td class="num">${esc(c.status_code ?? c.error?.code ?? '–')}</td><td class="num">${ms(c.timings.total_ms)}</td><td class="hide-sm">${esc(c.probe)}</td></tr>`).join('')}</tbody></table></div>
      <h3 style="margin:16px 0 8px">Incidents</h3>
      ${incidents.data.data.length ? incidents.data.data.map(incidentLine).join('') : '<div class="empty">No incidents recorded.</div>'}
    </div>
  </section>`;
  bindWindowSwitch();
  gauge($('#m-gauge'), {
    value: budget.remaining,
    label: budget.remaining == null ? 'n/a' : `${Math.round(budget.remaining * 100)}%`,
    sub: budget.status === 'insufficient_data' ? `needs ≥ ${budget.min_checks} checks` : budget.status === 'no_data' ? 'no checks yet' : 'budget remaining',
  });
  lineChart($('#m-latency'), {
    points: s.series,
    series: [
      { key: 'p50_ms', label: 'p50', color: 'var(--c2)', area: true },
      { key: 'p95_ms', label: 'p95', color: 'var(--c3)', dash: '5 4' },
      { key: 'max_ms', label: 'max', color: 'var(--c5)', width: 1.25, dash: '2 3' },
    ],
    yFormat: (v) => ms(v, { short: true }),
    xLabel: tickLabel(win),
    tipTitle: tipTime(win),
  });
  stackedBars($('#m-phases'), { points: s.series, keys: PHASES, yFormat: (v) => ms(v, { short: true }), xLabel: tickLabel(win), tipTitle: tipTime(win), height: 210 });
  histogramChart($('#m-hist'), { bins: s.histogram, threshold: apdexT, height: 210 });
  if (!STATIC) bindMonitorActions(m, mon.etag);
}

function incidentLine(i) {
  return `<div class="log"><details><summary><span class="when">${esc(when(i.opened_at))}</span><span class="status ${i.state === 'open' ? 'down' : 'up'}">${esc(i.state)}</span><span class="msg">${esc(i.cause)}</span><span class="who">${esc(duration(i.duration_s))}</span></summary>
    <div class="body"><div class="code">${esc(i.monitor_name)} · ${esc(i.failed_checks)} failed checks · opened ${esc(when(i.opened_at))}${i.resolved_at ? ` · resolved ${esc(when(i.resolved_at))}` : ''}</div></div></details></div>`;
}

function bindMonitorActions(m, etag) {
  const onError = (err) => {
    if (err instanceof ApiError && err.status === 412) toast('Someone else changed this monitor. Reloaded the latest version.', 'err');
    else toast(err.message, 'err');
    route();
  };
  $('#run-now').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      const { data } = await send('POST', `/v1/monitors/${m.id}/checks`, undefined, { idempotencyKey: crypto.randomUUID() });
      toast(`Check ${data.outcome}: ${data.status_code ?? data.error?.code} in ${ms(data.timings.total_ms)}`, data.outcome === 'up' ? 'ok' : 'err');
      route();
    } catch (err) {
      onError(err);
    }
  });
  $('#toggle-pause').addEventListener('click', async () => {
    try {
      await send('PATCH', `/v1/monitors/${m.id}`, { paused: !m.paused }, { etag, contentType: 'application/merge-patch+json' });
      toast(m.paused ? 'Monitor resumed.' : 'Monitor paused.', 'ok');
      route();
    } catch (err) {
      onError(err);
    }
  });
  $('#edit').addEventListener('click', () => openForm(m, etag));
  $('#delete').addEventListener('click', async () => {
    if (!window.confirm(`Delete "${m.name}" and all of its check history? This cannot be undone.`)) return;
    try {
      await send('DELETE', `/v1/monitors/${m.id}`, undefined, { etag });
      toast('Monitor deleted.', 'ok');
      location.hash = '#/';
    } catch (err) {
      onError(err);
    }
  });
}

// --------------------------------------------------------------- incidents
async function renderIncidents(token) {
  const { data } = await get('/v1/incidents?limit=100');
  if (stale(token)) return;
  const open = data.data.filter((i) => i.state === 'open');
  view.innerHTML = `<div class="page-head"><div><h1>Incidents</h1><p>An incident opens after a monitor fails its threshold of consecutive checks and resolves on the next passing check.</p></div></div>
  <section class="grid">
    <div class="card kpi span-3"><span class="label">Open now</span><span class="value ${open.length ? 'tone-err' : 'tone-ok'}">${open.length}</span></div>
    <div class="card kpi span-3"><span class="label">Recorded</span><span class="value">${data.data.length}</span></div>
    <div class="card kpi span-3"><span class="label">Median duration</span><span class="value">${(() => { const d = data.data.map((i) => i.duration_s).filter((x) => x != null).sort((a, b) => a - b); return d.length ? duration(d[Math.floor(d.length / 2)]) : '–'; })()}</span></div>
    <div class="card kpi span-3"><span class="label">Most affected</span><span class="value" style="font-size:16px">${esc(Object.entries(data.data.reduce((a, i) => ({ ...a, [i.monitor_name]: (a[i.monitor_name] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1])[0]?.[0] || '–')}</span></div>
    <div class="card span-12"><div class="table-wrap"><table><thead><tr><th>Opened</th><th>Monitor</th><th>State</th><th>Cause</th><th class="num">Failed checks</th><th class="num">Duration</th></tr></thead><tbody>
      ${data.data.map((i) => `<tr class="clickable" data-href="#/monitors/${esc(i.monitor_id)}"><td class="mono">${esc(when(i.opened_at))}</td><td><a class="m-name" href="#/monitors/${esc(i.monitor_id)}">${esc(i.monitor_name)}</a></td><td><span class="status ${i.state === 'open' ? 'down' : 'up'}">${esc(i.state)}</span></td><td>${esc(i.cause)}</td><td class="num">${esc(i.failed_checks)}</td><td class="num">${esc(duration(i.duration_s))}</td></tr>`).join('') || '<tr><td colspan="6"><div class="empty">No incidents recorded yet.</div></td></tr>'}
    </tbody></table></div></div>
  </section>`;
  view.querySelectorAll('tr[data-href]').forEach((tr) => tr.addEventListener('click', () => (location.hash = tr.dataset.href)));
}

// --------------------------------------------------------------------- API
async function renderApi(token) {
  const [{ data: spec }, transcripts] = await Promise.all([
    get('/v1/openapi.json'),
    fetch('transcripts.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : [])).catch(() => []),
  ]);
  if (stale(token)) return;
  const ops = Object.entries(spec.paths).flatMap(([path, item]) => Object.entries(item).filter(([k]) => ['get', 'post', 'patch', 'put', 'delete'].includes(k)).map(([verb, op]) => ({ verb: verb.toUpperCase(), path, op })));
  view.innerHTML = `<div class="page-head"><div><h1>REST API</h1><p>OpenAPI ${esc(spec.openapi)} contract with ${ops.length} operations. Transcripts on the right are real requests and responses recorded against this build, not hand-written examples.</p></div>
    <a class="btn" href="${STATIC ? 'openapi.json' : '/v1/openapi.json'}">openapi.json</a></div>
  <section class="grid">
    <div class="card span-5">
      <div class="card-head"><h2>Operations</h2><span class="sub">${esc(spec.info.title)} ${esc(spec.info.version)}</span></div>
      <div class="endpoints">${ops.map(({ verb, path, op }) => `<div class="endpoint"><span class="verb ${verb}">${verb}</span><code>${esc(path)}</code><small>${esc(op.summary)}${op.security?.some((s) => s.bearer) ? ' · requires API key' : ''}</small></div>`).join('')}</div>
      <h3 style="margin:18px 0 8px">Conventions</h3>
      <div class="bars" style="gap:6px;color:var(--muted);font-size:13px">
        <div>Errors are <b>RFC 9457</b> <code>application/problem+json</code>; <code>type</code> links to <a href="errors.html">the error catalogue</a>.</div>
        <div>Writes use <b>optimistic concurrency</b>: <code>If-Match</code> is required on PATCH (428 without it, 412 on a stale ETag).</div>
        <div>POST accepts <b>Idempotency-Key</b>; retries replay the first response with <code>Idempotent-Replayed: true</code>.</div>
        <div><b>Keyset pagination</b> with opaque cursors and <code>Link: rel="next"</code>.</div>
        <div><b>RateLimit</b> / <b>RateLimit-Policy</b> headers on every response; 429 with <code>Retry-After</code>.</div>
        <div>Outbound checks are <b>SSRF-guarded</b> at DNS resolution time.</div>
      </div>
    </div>
    <div class="card span-7">
      <div class="card-head"><h2>Recorded transcripts</h2><span class="sub">${transcripts.length} exchanges</span></div>
      ${transcripts.length ? transcripts.map((t) => `<div class="transcript"><h3><span>${esc(t.title)}</span><span class="status ${t.response.status < 300 ? 'up' : t.response.status < 500 ? 'degraded' : 'down'}">${t.response.status}</span></h3>${t.note ? `<p>${esc(t.note)}</p>` : ''}<pre class="req">${esc(t.request)}</pre><pre>${esc(t.response.text)}</pre></div>`).join('') : '<div class="empty">Run <code>npm run build:pages</code> to record transcripts.</div>'}
    </div>
  </section>`;
}

function renderNotFound() {
  view.innerHTML = '<div class="card"><h1>Not found</h1><p><a href="#/">Back to overview</a></p></div>';
}

// -------------------------------------------------------------------- form
const dialog = $('#monitor-dialog');
const form = $('#monitor-form');
let editing = null;
let idempotencyKey = null;

const SOURCES = { status: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in'], latency_ms: ['lt', 'lte'], header: ['eq', 'neq', 'contains', 'not_contains', 'exists', 'not_exists'], body: ['contains', 'not_contains'], json: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'contains', 'in', 'exists', 'not_exists'] };

function assertionRow(a = { source: 'status', op: 'eq', target: 200 }) {
  const row = document.createElement('div');
  row.className = 'assertion-row';
  row.innerHTML = `<select aria-label="Source" data-k="source">${Object.keys(SOURCES).map((s) => `<option ${s === a.source ? 'selected' : ''}>${s}</option>`).join('')}</select>
    <input aria-label="Property" data-k="property" placeholder="header or json path" value="${esc(a.property ?? '')}">
    <select aria-label="Operator" data-k="op"></select>
    <input aria-label="Target" data-k="target" placeholder="value (JSON)" value="${esc(a.target === undefined ? '' : JSON.stringify(a.target))}">
    <button type="button" class="icon-btn" aria-label="Remove assertion">✕</button>`;
  const src = row.querySelector('[data-k="source"]');
  const op = row.querySelector('[data-k="op"]');
  const sync = (keep) => {
    op.innerHTML = SOURCES[src.value].map((o) => `<option ${o === keep ? 'selected' : ''}>${o}</option>`).join('');
    row.querySelector('[data-k="property"]').disabled = !['header', 'json'].includes(src.value);
  };
  sync(a.op);
  src.addEventListener('change', () => sync());
  row.querySelector('button').addEventListener('click', () => row.remove());
  return row;
}

function readAssertions() {
  return [...document.querySelectorAll('#assertion-rows .assertion-row')].map((row) => {
    const get = (k) => row.querySelector(`[data-k="${k}"]`).value.trim();
    const a = { source: get('source'), op: get('op') };
    if (['header', 'json'].includes(a.source)) a.property = get('property');
    if (!['exists', 'not_exists'].includes(a.op)) {
      const raw = get('target');
      try {
        a.target = JSON.parse(raw);
      } catch {
        a.target = raw;
      }
    }
    return a;
  });
}

function openForm(monitor = null, etag = null) {
  editing = monitor ? { monitor, etag } : null;
  idempotencyKey = crypto.randomUUID();
  form.reset();
  $('#dialog-title').textContent = monitor ? `Edit ${monitor.name}` : 'New monitor';
  $('#form-errors').hidden = true;
  form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  const rows = $('#assertion-rows');
  rows.innerHTML = '';
  if (monitor) {
    for (const k of ['name', 'url', 'method', 'interval_s', 'timeout_ms', 'failure_threshold', 'slo_target', 'capture']) form.elements[k].value = monitor[k];
    form.elements.tags.value = monitor.tags.join(', ');
    form.elements.follow_redirects.checked = monitor.follow_redirects;
    form.elements.paused.checked = monitor.paused;
    form.elements.headers.value = Object.entries(monitor.headers).map(([k, v]) => `${k}: ${v}`).join('\n');
    form.elements.body.value = monitor.body ?? '';
    monitor.assertions.forEach((a) => rows.append(assertionRow(a)));
  } else {
    rows.append(assertionRow({ source: 'status', op: 'eq', target: 200 }));
    rows.append(assertionRow({ source: 'latency_ms', op: 'lt', target: 1000 }));
  }
  dialog.showModal();
}

function formValue() {
  const f = form.elements;
  const headers = {};
  for (const line of f.headers.value.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const num = (v) => (v === '' ? undefined : Number(v));
  return {
    name: f.name.value.trim(),
    url: f.url.value.trim(),
    method: f.method.value,
    headers,
    body: f.body.value === '' ? null : f.body.value,
    interval_s: num(f.interval_s.value),
    timeout_ms: num(f.timeout_ms.value),
    failure_threshold: num(f.failure_threshold.value),
    slo_target: num(f.slo_target.value),
    tags: f.tags.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
    follow_redirects: f.follow_redirects.checked,
    paused: f.paused.checked,
    capture: f.capture.value,
    assertions: readAssertions(),
  };
}

// Builds an RFC 7396 merge patch containing only what changed.
function diff(before, after) {
  const patch = {};
  for (const [k, v] of Object.entries(after)) {
    if (k === 'headers') {
      const h = {};
      for (const key of Object.keys(before.headers)) if (!(key in v)) h[key] = null;
      for (const [key, val] of Object.entries(v)) if (before.headers[key] !== val) h[key] = val;
      if (Object.keys(h).length) patch.headers = h;
    } else if (JSON.stringify(before[k]) !== JSON.stringify(v)) patch[k] = v;
  }
  return patch;
}

function showProblem(err) {
  const box = $('#form-errors');
  const p = err.problem || {};
  const lines = [p.title ? `${p.title}${p.detail ? `: ${p.detail}` : ''}` : err.message];
  for (const e of p.errors || []) {
    lines.push(`• ${e.pointer || 'body'}: ${e.detail}`);
    const field = e.pointer.split('/')[1];
    if (field === 'assertions') {
      const idx = Number(e.pointer.split('/')[2]);
      document.querySelectorAll('#assertion-rows .assertion-row')[idx]?.querySelectorAll('input,select').forEach((el) => el.setAttribute('aria-invalid', 'true'));
    } else form.elements[field]?.setAttribute('aria-invalid', 'true');
  }
  box.textContent = lines.join('\n');
  box.hidden = false;
}

form.addEventListener('submit', async (e) => {
  if (e.submitter?.value === 'cancel') return;
  e.preventDefault();
  form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  const save = $('#save-monitor');
  save.disabled = true;
  try {
    const value = formValue();
    let res;
    if (editing) {
      const patch = diff(editing.monitor, value);
      if (!Object.keys(patch).length) {
        dialog.close();
        return;
      }
      res = await send('PATCH', `/v1/monitors/${editing.monitor.id}`, patch, { etag: editing.etag, contentType: 'application/merge-patch+json' });
    } else {
      res = await send('POST', '/v1/monitors', value, { idempotencyKey });
    }
    dialog.close();
    toast(editing ? 'Monitor updated.' : `Monitor created${res.replayed ? ' (replayed)' : ''}. First check runs within seconds.`, 'ok');
    location.hash = `#/monitors/${res.data.id}`;
    route();
  } catch (err) {
    if (err instanceof ApiError) showProblem(err);
    else showProblem({ problem: {}, message: err.message });
  } finally {
    save.disabled = false;
  }
});
$('#add-assertion').addEventListener('click', () => $('#assertion-rows').append(assertionRow({ source: 'json', op: 'exists' })));

// ------------------------------------------------------------------- boot
function updatePill() {
  const pill = $('#mode-pill');
  pill.hidden = false;
  pill.innerHTML = STATIC
    ? `<span class="dot" style="background:var(--accent)"></span>Snapshot · ${esc(ago(state.generatedAt))}`
    : '<span class="dot"></span>Live';
}

async function boot() {
  initTheme();
  if (STATIC) {
    const banner = $('#banner');
    banner.hidden = false;
    banner.innerHTML = '<strong>Read-only live snapshot.</strong> A scheduled GitHub Actions job runs every check from its runner (probe <code>gh-actions</code>) about every 15 minutes and republishes this page. Earlier history came from a workstation probe. Run the app yourself (<code>npm run demo</code>) for the writable API and the event stream.';
  } else {
    $('#new-monitor').hidden = false;
    $('#new-monitor').addEventListener('click', () => openForm());
    let timer = 0;
    subscribe((type) => {
      if (dialog.open) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!location.hash.startsWith('#/api')) route();
      }, type === 'check.completed' ? 1500 : 200);
    });
  }
  window.addEventListener('hashchange', () => {
    route();
    view.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  });
  await route();
}

boot();
