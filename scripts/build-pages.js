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
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { openDb } from '../src/db/index.js';
import { allMonitors } from '../src/db/repo.js';
import { startServer, seed } from '../src/server.js';
import { Scheduler } from '../src/engine/scheduler.js';
import { loadConfig } from '../src/config.js';
import { PROBLEM_TYPES } from '../src/http/problem.js';
import { staticPathFor } from '../public/js/static-path.js';
import { exportHistory, importHistory, readJson } from './history.js';
import { recordTranscripts } from './transcripts.js';

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: '_site' },
    previous: { type: 'string' },
    'seed-export': { type: 'string', default: 'demo/seed-export.json' },
    'run-checks': { type: 'boolean', default: false },
    probe: { type: 'string', default: 'gh-actions' },
    'history-days': { type: 'string', default: '8' },
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

if (args['run-checks']) {
  const scheduler = new Scheduler({ db, config });
  const results = await Promise.all(allMonitors(db).map((m) => scheduler.execute(m)));
  log('checks complete', { results: results.map((c) => `${c.outcome}:${c.status_code ?? c.error?.code}:${c.timings.total_ms}ms`) });
}

rmSync(OUT, { recursive: true, force: true });
cpSync('public', OUT, { recursive: true });
const indexPath = join(OUT, 'index.html');
writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace('<meta name="ahm-mode" content="live">', '<meta name="ahm-mode" content="static">'));

const server = await startServer({ port: 0, scheduler: false, logRequests: false, apiKey: '', rateLimit: { capacity: 1e6, windowS: 60 } }, { db });
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
writeFileSync(join(OUT, '.nojekyll'), '');
log('site built', { out: OUT });
