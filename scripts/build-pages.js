// Builds the static GitHub Pages snapshot.
//
//   1. Load demo monitors and import history (previous deploy, else the
//      committed seed export).
//   2. Optionally run one real round of checks (--run-checks).
//   3. Start the real API in-process and save its JSON responses to disk at
//      the paths the dashboard's static client expects.
//
// Every JSON file on the site is a byte-for-byte API response produced by the
// same code that serves /v1 — nothing is hand-assembled.
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { openDb } from '../src/db/index.js';
import { allMonitors, scrubHistory } from '../src/db/repo.js';
import { startServer, seed } from '../src/server.js';
import { Scheduler } from '../src/engine/scheduler.js';
import { loadConfig } from '../src/config.js';
import { PROBLEM_TYPES } from '../src/http/problem.js';
import { staticPathFor } from '../public/js/static-path.js';
import { exportHistory, importHistory, readJson } from './history.js';
import { renderIncidentsAtom } from '../src/api/feed.js';
import { recordTranscripts } from './transcripts.js';
import { unservableFiles, secretValues, secretHits } from './publication-gate.js';

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: '_site' },
    previous: { type: 'string' },
    'seed-export': { type: 'string', default: 'demo/seed-export.json' },
    'run-checks': { type: 'boolean', default: false },
    probe: { type: 'string', default: 'gh-actions' },
    'history-days': { type: 'string', default: '8' },
    // Incident transitions from THIS run, written outside the site for the
    // post-deploy notify job. Never inside --out.
    'alerts-out': { type: 'string' },
    'public-url': { type: 'string', default: 'https://mizcausevic-dev.github.io/api-health-monitor' },
  },
});

const log = (msg, extra = {}) => process.stdout.write(`${JSON.stringify({ msg, ...extra })}\n`);
const OUT = args.out;
const sinceIso = new Date(Date.now() - Number(args['history-days']) * 86400e3).toISOString();

const MAX_EXPORT_BYTES = 25 * 1024 * 1024;

// The published site is the only copy of the history. Only a 404 (site not
// deployed yet) may fall back to the seed; any other failure aborts the build
// so the last good deploy stays live instead of being overwritten.
async function loadPrevious() {
  if (args.previous) {
    let res;
    try {
      res = await fetch(args.previous, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    } catch (err) {
      throw new Error(`previous export fetch failed (${err.message}); refusing to overwrite history`);
    }
    if (res.status === 404) log('no previous export yet (404); starting from seed');
    else if (!res.ok) throw new Error(`previous export returned HTTP ${res.status}; refusing to overwrite history`);
    else {
      const text = await res.text();
      if (text.length > MAX_EXPORT_BYTES) throw new Error(`previous export is ${text.length} bytes, over the ${MAX_EXPORT_BYTES} cap`);
      try {
        return { data: JSON.parse(text), source: args.previous };
      } catch {
        throw new Error('previous export is not valid JSON; refusing to overwrite history');
      }
    }
  }
  try {
    return { data: readJson(args['seed-export']), source: args['seed-export'] };
  } catch {
    return { data: null, source: 'none' };
  }
}

const db = openDb(':memory:');
const config = loadConfig(process.env, { allowPrivateTargets: false, probe: args.probe, maxConcurrency: 4 });
seed(db, 'demo/monitors.json', config);
const prev = await loadPrevious();
log('history imported', { source: prev.source, ...importHistory(db, prev.data, { sinceIso }) });
// Published history predates any capture tightening in demo/monitors.json;
// re-apply the current policy so the next deploy stops republishing it.
for (const m of allMonitors(db)) if (m.capture !== 'sample') log('history scrubbed', { monitor: m.id, capture: m.capture, rows: scrubHistory(db, m.id, m.capture) });

const alerts = [];
if (args['run-checks']) {
  const scheduler = new Scheduler({ db, config });
  scheduler.on('event', (e) => {
    if (e.type === 'incident.opened' || e.type === 'incident.resolved') alerts.push(e);
  });
  const results = await Promise.all(allMonitors(db).map((m) => scheduler.execute(m)));
  log('checks complete', { results: results.map((c) => `${c.outcome}:${c.status_code ?? c.error?.code}:${c.timings.total_ms}ms`) });
}

rmSync(OUT, { recursive: true, force: true });
cpSync('public', OUT, { recursive: true });
const indexPath = join(OUT, 'index.html');
writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace('<meta name="ahm-mode" content="live">', '<meta name="ahm-mode" content="static">').replace('href="/v1/feeds/incidents"', 'href="incidents.xml"'));

// The snapshot is rendered as an ANONYMOUS reader of a keyed server, so it
// contains exactly what a public reader of a self-hosted instance would see
// (query values and request bodies redacted), not the operator's view.
const buildKey = randomBytes(24).toString('base64url');
const server = await startServer({ port: 0, scheduler: false, logRequests: false, apiKey: buildKey, publicRead: true, rateLimit: { capacity: 1e6, windowS: 60 } }, { db });
try {
  const paths = ['/v1/openapi.json', '/v1/incidents?limit=100'];
  for (const w of ['6h', '24h', '7d']) paths.push(`/v1/overview?window=${w}`);
  for (const m of allMonitors(db)) {
    paths.push(`/v1/monitors/${m.id}`, `/v1/monitors/${m.id}/state`, `/v1/monitors/${m.id}/checks?outcome=fail&limit=25`, `/v1/monitors/${m.id}/checks?limit=15`, `/v1/incidents?limit=10&monitor_id=${m.id}`);
    paths.push(`/v1/monitors/${m.id}/stats?buckets=72&window=6h`, `/v1/monitors/${m.id}/stats?buckets=48&window=24h`, `/v1/monitors/${m.id}/stats?buckets=56&window=7d`);
  }
  for (const p of paths) {
    const res = await fetch(server.url + p);
    if (!res.ok) throw new Error(`${p} -> ${res.status}`);
    const file = join(OUT, staticPathFor(p));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, await res.text());
  }
  log('api snapshot written', { files: paths.length });
} finally {
  await server.close();
}

writeFileSync(join(OUT, 'openapi.json'), readFileSync(join(OUT, staticPathFor('/v1/openapi.json'))));
// Atom feed, rendered by the same code as GET /v1/feeds/incidents from the
// anonymous /v1/incidents response already written above.
const siteUrl = args['public-url'].replace(/\/$/, '');
const incidentList = JSON.parse(readFileSync(join(OUT, staticPathFor('/v1/incidents?limit=100')), 'utf8')).data.slice(0, 50);
writeFileSync(join(OUT, 'incidents.xml'), renderIncidentsAtom(incidentList, { siteUrl, selfUrl: `${siteUrl}/incidents.xml` }));
mkdirSync(join(OUT, 'data'), { recursive: true });
const history = exportHistory(db, { sinceIso });
writeFileSync(join(OUT, 'data', 'export.json'), JSON.stringify(history));
log('history exported', { checks: history.checks.length, incidents: history.incidents.length });

const transcripts = await recordTranscripts();
writeFileSync(join(OUT, 'transcripts.json'), JSON.stringify(transcripts, null, 2));

// Human-readable targets for the problem `type` URIs.
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
writeFileSync(join(OUT, 'errors.html'), `<!doctype html>
<html lang="en" data-theme="bento" data-scheme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Error catalogue · API Health Monitor</title><meta name="description" content="Problem types returned by the API Health Monitor REST API (RFC 9457).">
<link rel="icon" href="favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="css/app.css"><script src="js/theme-boot.js"></script></head>
<body><header class="topbar"><a class="brand" href="./#/">API Health Monitor</a><nav class="tabs"><a href="./#/api">API</a></nav></header>
<main><div class="page-head"><div><h1>Error catalogue</h1><p>Every error is <code>application/problem+json</code> (RFC 9457). The <code>type</code> member links to an entry below.</p></div></div>
<div class="grid">${Object.entries(PROBLEM_TYPES).map(([slug, d]) => `<section class="card span-6" id="${slug}"><div class="card-head"><h2>${esc(d.title)}</h2><span class="status ${d.status >= 500 ? 'down' : 'degraded'}">${d.status}</span></div><p><code>${slug}</code></p><p>${md(d.help)}</p></section>`).join('')}</div></main></body></html>
`);
// Publication gates: only web-servable files, and no secret value anywhere.
const unservable = unservableFiles(OUT);
if (unservable.length) throw new Error(`publication gate: refusing to publish ${unservable.join(', ')}`);
const secrets = secretValues({ ...process.env, AHM_API_KEY: buildKey }, allMonitors(db));
if (secrets.skipped.length) log('secret gate: values too short to scan', { labels: secrets.skipped });
const leaks = secretHits(OUT, secrets);
if (leaks.length) throw new Error(`secret gate: refusing to publish (${leaks.join('; ')})`);
if (args['alerts-out']) {
  writeFileSync(args['alerts-out'], JSON.stringify(alerts.slice(0, 50)));
  log('alerts recorded', { count: alerts.length, file: args['alerts-out'] });
}
log('site built', { out: OUT, publication_gate: 'pass', secret_gate: 'pass', secret_values_scanned: secrets.length });
