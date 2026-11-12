// Aggregations behind /stats and /overview. Pure functions over check rows so
// they are trivially unit-testable.

export const WINDOWS = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3, '30d': 30 * 24 * 3600e3 };
export const HISTOGRAM_EDGES = [0, 50, 100, 150, 200, 300, 400, 600, 800, 1000, 1500, 2000, 3000, 5000, 10000];
const PHASES = ['dns_ms', 'connect_ms', 'tls_ms', 'ttfb_ms', 'transfer_ms'];

const r1 = (n) => (n == null || Number.isNaN(n) ? null : Math.round(n * 10) / 10);

// Nearest-rank percentile on a pre-sorted array.
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function latencyLatencies(rows) {
  return rows.filter((r) => r.status_code != null && r.duration_ms != null).map((r) => r.duration_ms).sort((a, b) => a - b);
}

export function summarize(rows, { apdexT = 500, sloTarget = 0.999 } = {}) {
  const total = rows.length;
  const counts = { up: 0, degraded: 0, down: 0 };
  for (const r of rows) counts[r.outcome] += 1;
  const lat = latencyLatencies(rows);
  const satisfied = lat.filter((x) => x <= apdexT).length;
  const tolerating = lat.filter((x) => x > apdexT && x <= 4 * apdexT).length;
  const availability = total ? (counts.up + counts.degraded) / total : null;
  const allowed = total * (1 - sloTarget);
  return {
    checks: total,
    outcomes: counts,
    availability: availability == null ? null : Math.round(availability * 1e5) / 1e5,
    // Apdex counts transport failures as frustrated: they are in `total`
    // but in neither bucket.
    apdex: total ? Math.round(((satisfied + tolerating / 2) / total) * 1000) / 1000 : null,
    apdex_t_ms: apdexT,
    latency_ms: {
      min: r1(lat[0]),
      p50: r1(percentile(lat, 50)),
      p90: r1(percentile(lat, 90)),
      p95: r1(percentile(lat, 95)),
      p99: r1(percentile(lat, 99)),
      max: r1(lat.at(-1)),
      mean: r1(mean(lat)),
    },
    error_budget: {
      slo_target: sloTarget,
      allowed_failures: r1(allowed),
      failures: counts.down,
      remaining: total ? Math.max(-1, Math.round((1 - counts.down / Math.max(allowed, 1e-9)) * 1000) / 1000) : null,
    },
  };
}

export function phaseBreakdown(rows) {
  const out = {};
  for (const ph of PHASES) out[ph] = r1(mean(rows.map((r) => r[ph]).filter((x) => x != null)));
  return out;
}

export function statusCodes(rows) {
  const out = {};
  for (const r of rows) {
    const key = r.status_code != null ? String(r.status_code) : `error:${r.error_code || 'unknown'}`;
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

export function histogram(rows) {
  const lat = latencyLatencies(rows);
  return HISTOGRAM_EDGES.map((lo, i) => {
    const hi = HISTOGRAM_EDGES[i + 1] ?? null;
    return { from_ms: lo, to_ms: hi, count: lat.filter((x) => x >= lo && (hi == null || x < hi)).length };
  });
}

export function series(rows, { from, to, buckets }) {
  const width = (to - from) / buckets;
  const bins = Array.from({ length: buckets }, () => []);
  for (const r of rows) {
    const idx = Math.floor((Date.parse(r.started_at) - from) / width);
    if (idx >= 0 && idx < buckets) bins[idx].push(r);
  }
  return bins.map((b, i) => {
    const lat = latencyLatencies(b);
    const failures = b.filter((r) => r.outcome === 'down').length;
    return {
      t: new Date(from + i * width).toISOString(),
      checks: b.length,
      failures,
      degraded: b.filter((r) => r.outcome === 'degraded').length,
      availability: b.length ? Math.round(((b.length - failures) / b.length) * 1e4) / 1e4 : null,
      p50_ms: r1(percentile(lat, 50)),
      p95_ms: r1(percentile(lat, 95)),
      max_ms: r1(lat.at(-1)),
      ...phaseBreakdown(b),
    };
  });
}

export function apdexThreshold(monitor) {
  const budget = monitor.assertions.find((a) => a.source === 'latency_ms');
  return budget ? budget.target : 500;
}
