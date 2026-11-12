// Checks run on the built site before anything is uploaded. Both ask the
// negative question: is something reachable that must not be?
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { SAFE_HEADERS } from '../src/api/validate.js';
import { xml } from '../src/api/feed.js';

const SERVABLE = new Set(['.html', '.css', '.js', '.json', '.xml', '.svg', '.png', '.ico']);

const files = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath ?? d.path, d.name));

// 1. Allowlist, not denylist: only web-servable file types, no dotfiles.
export function unservableFiles(dir) {
  return files(dir)
    .map((f) => relative(dir, f))
    .filter((rel) => !SERVABLE.has(extname(rel).toLowerCase()) || rel.split(/[\\/]/).some((seg) => seg.startsWith('.')));
}

// Values that must never appear in the published site: environment secrets
// the build can see, and every monitor header value that is not on the
// safe-header allowlist (i.e. everything the API itself redacts).
// Query parameters whose name suggests a credential (?api_key=, ?token=...).
// Other query values (coordinates, field lists) legitimately appear in
// response samples and would make every build fail.
const CREDENTIAL_PARAM = /key|token|secret|sig|auth|pass|session|credential/i;

export function secretValues(env, monitors) {
  const out = [];
  const skipped = [];
  const add = (label, value, min) => {
    if (typeof value !== 'string' || !value) return;
    if (value.length >= min) out.push({ label, value });
    else skipped.push(label); // too short to scan without false positives
  };
  for (const [name, value] of Object.entries(env)) {
    if (/^AHM_(SECRET_|WEBHOOK_|API_KEY$)/.test(name)) add(`env ${name}`, value, 8);
  }
  for (const m of monitors) {
    for (const [header, value] of Object.entries(m.headers || {})) {
      if (!SAFE_HEADERS.has(header.toLowerCase())) add(`monitor ${m.id} header ${header}`, value, 6);
    }
    try {
      for (const [k, v] of new URL(m.url).searchParams) if (CREDENTIAL_PARAM.test(k)) add(`monitor ${m.id} query ${k}`, v, 6);
    } catch { /* invalid URLs are rejected at validation */ }
    if (m.body != null) add(`monitor ${m.id} request body`, m.body, 8);
  }
  return Object.assign(out, { skipped });
}

// 2. Secret scan: the raw value, its JSON-escaped form and its URL-encoded
// form, in every generated JSON and XML file (the only files built from data; HTML,
// CSS and JS are copied from the repository). Returns labels, never values.
export function secretHits(dir, secrets) {
  const hits = [];
  const forms = secrets.map((s) => ({ ...s, needles: [...new Set([s.value, JSON.stringify(s.value).slice(1, -1), encodeURIComponent(s.value), xml(s.value)])] }));
  for (const file of files(dir).filter((f) => ['.json', '.xml'].includes(extname(f).toLowerCase()))) {
    const text = readFileSync(file, 'utf8');
    for (const s of forms) if (s.needles.some((n) => text.includes(n))) hits.push(`${s.label} in ${relative(dir, file)}`);
  }
  return hits;
}
