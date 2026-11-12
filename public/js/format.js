export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function ms(v, { short = false } = {}) {
  if (v == null || Number.isNaN(v)) return '–';
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 2)}${short ? 's' : ' s'}`;
  return `${Math.round(v)}${short ? 'ms' : ' ms'}`;
}

export function pct(v, digits = 2) {
  if (v == null) return '–';
  const p = v * 100;
  if (p === 100) return '100%';
  return `${p.toFixed(digits)}%`;
}

export function ago(iso, now = Date.now()) {
  if (!iso) return 'never';
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function duration(seconds) {
  if (seconds == null) return 'ongoing';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

const dtf = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const tf = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const df = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
export const when = (iso) => (iso ? dtf.format(new Date(iso)) : '–');
export const clock = (t) => tf.format(new Date(t));
export const day = (t) => df.format(new Date(t));

export const host = (url) => {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === '/' ? '' : u.pathname) + u.search;
  } catch {
    return url;
  }
};

export const tone = (availability, slo = 0.999) => (availability == null ? 'muted' : availability >= slo ? 'ok' : availability >= slo - 0.02 ? 'warn' : 'err');
