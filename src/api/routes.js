import { createHash } from 'node:crypto';
import { httpError, validationError } from '../http/problem.js';
import { formatSse } from '../http/events.js';
import * as repo from '../db/repo.js';
import { validateMonitor, mergePatch, redactHeaders, redactUrl, restoreRedacted, monitorInputOf, keepSafeHeaders, REDACTED } from './validate.js';
import { WINDOWS, summarize, phaseBreakdown, statusCodes, histogram, series, apdexThreshold } from '../engine/stats.js';
import { openApiDocument } from './openapi.js';

// ------------------------------------------------------------------ helpers

const encodeCursor = (c) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decodeCursor(raw, extra = {}) {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof c.id !== 'string' || !('v' in c)) throw new Error('shape');
    for (const [k, v] of Object.entries(extra)) if (c[k] !== v) throw new Error('mismatch');
    return c;
  } catch {
    throw httpError('bad-request', 'Invalid or expired pagination cursor. Restart from the first page.', { extensions: { parameter: 'cursor' } });
  }
}

// Unknown query parameters are rejected: a misspelled filter that is silently
// ignored returns the wrong data with a 200.
function readQuery(query, spec) {
  const out = {};
  for (const key of query.keys()) {
    if (!(key in spec)) throw httpError('bad-request', `Unknown query parameter "${key}". Allowed: ${Object.keys(spec).join(', ') || 'none'}.`, { extensions: { parameter: key } });
  }
  for (const [key, rule] of Object.entries(spec)) {
    const raw = query.get(key);
    if (raw === null || raw === '') {
      out[key] = rule.default;
      continue;
    }
    if (rule.enum && !rule.enum.includes(raw)) throw httpError('bad-request', `"${key}" must be one of ${rule.enum.join(', ')}.`, { extensions: { parameter: key } });
    if (rule.int) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < rule.int[0] || n > rule.int[1]) throw httpError('bad-request', `"${key}" must be an integer from ${rule.int[0]} to ${rule.int[1]}.`, { extensions: { parameter: key } });
      out[key] = n;
      continue;
    }
    if (rule.date) {
      const t = Date.parse(raw);
      if (Number.isNaN(t)) throw httpError('bad-request', `"${key}" must be an RFC 3339 timestamp.`, { extensions: { parameter: key } });
      out[key] = new Date(t).toISOString();
      continue;
    }
    if (rule.max && raw.length > rule.max) throw httpError('bad-request', `"${key}" is too long.`, { extensions: { parameter: key } });
    out[key] = raw;
  }
  return out;
}

// RFC 8288 Link header for the next page, plus the same URL in the body for
// clients that do not parse headers.
function page(ctx, items, next, cursorExtra = {}) {
  let nextUrl = null;
  if (next) {
    const u = new URL(ctx.url);
    u.searchParams.set('cursor', encodeCursor({ ...next, ...cursorExtra }));
    nextUrl = `${u.pathname}${u.search}`;
  }
  return {
    body: { data: items, page: { next_cursor: next ? encodeCursor({ ...next, ...cursorExtra }) : null, next: nextUrl } },
    headers: nextUrl ? { Link: `<${nextUrl}>; rel="next"` } : {},
  };
}

const monitorEtag = (m) => `"v${m.version}"`;
const monitorLinks = (id) => ({
  self: `/v1/monitors/${id}`,
  state: `/v1/monitors/${id}/state`,
  checks: `/v1/monitors/${id}/checks`,
  stats: `/v1/monitors/${id}/stats`,
  incidents: `/v1/incidents?monitor_id=${id}`,
});

// The monitor resource is its configuration. Runtime health (last status,
// failure streak) is derived data with its own URI, so the monitor's ETag
// changes only when someone edits it. Otherwise every check would bump the
// ETag and make If-Match PATCHes fail for no reason.
//
// Header values are always allowlist-redacted. Anonymous readers (possible
// only when a key is set and AHM_PUBLIC_READ=true) also get query values and
// the request body redacted, and a distinct ETag so caches never mix the two
// representations.
function present(m, { anonymous = false } = {}) {
  const { last_status, last_checked_at, consecutive_failures, ...config } = m;
  const out = { ...config, headers: redactHeaders(m.headers), links: monitorLinks(m.id) };
  if (anonymous) {
    out.url = redactUrl(m.url);
    if (out.body != null) out.body = REDACTED;
  }
  return out;
}
const isAnonymous = (ctx) => !ctx.auth.authenticated;
const etagFor = (m, ctx) => (isAnonymous(ctx) ? `"v${m.version}-public"` : monitorEtag(m));

function stateOf(db, m) {
  return {
    monitor_id: m.id,
    status: m.paused ? 'paused' : m.last_status,
    last_checked_at: m.last_checked_at,
    consecutive_failures: m.consecutive_failures,
    open_incident: repo.openIncidentFor(db, m.id),
  };
}

function loadMonitor(db, id) {
  const m = repo.getMonitor(db, id);
  if (!m) throw httpError('not-found', `Monitor ${id} does not exist.`);
  return m;
}

// Idempotency-Key (draft-ietf-httpapi-idempotency-key-header): a retried
// POST with the same key replays the first response instead of creating a
// duplicate. Same key + different body is a client bug and gets a 422.
async function idempotent(ctx, db, fn) {
  const key = ctx.req.headers['idempotency-key'];
  if (key === undefined) return fn();
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(key)) throw httpError('bad-request', 'Idempotency-Key must be 1-255 visible ASCII characters.');
  const hash = createHash('sha256').update(`${ctx.method} ${ctx.path}\n${JSON.stringify(ctx.body ?? null)}`).digest('hex');
  const principal = ctx.auth.principal;
  const existing = repo.getIdempotency(db, principal, key);
  if (existing) {
    if (existing.request_hash !== hash) throw httpError('idempotency-key-reused', 'This Idempotency-Key was used with a different request.');
    if (existing.status == null) throw httpError('idempotency-conflict', 'The original request is still in progress.');
    return { status: existing.status, body: JSON.parse(existing.body), headers: { ...JSON.parse(existing.headers), 'Idempotent-Replayed': 'true' } };
  }
  try {
    repo.reserveIdempotency(db, principal, key, hash);
  } catch {
    throw httpError('idempotency-conflict', 'The original request is still in progress.');
  }
  try {
    const result = await fn();
    repo.completeIdempotency(db, principal, key, result.status, result.headers ?? {}, JSON.stringify(result.body));
    return result;
  } catch (err) {
    // Failed requests are not cached: the client may fix and retry with the
    // same key.
    repo.releaseIdempotency(db, principal, key);
    throw err;
  }
}

function checkIfMatch(ctx, m, { required }) {
  const header = ctx.req.headers['if-match'];
  if (!header) {
    if (required) throw httpError('precondition-required', 'Send If-Match with the ETag from your last GET of this monitor.', { extensions: { current_etag: monitorEtag(m) } });
    return;
  }
  if (header.trim() === '*') return;
  const tags = header.split(',').map((t) => t.trim());
  if (tags.some((t) => t.startsWith('W/'))) throw httpError('precondition-failed', 'Weak ETags cannot be used with If-Match.');
  if (!tags.includes(monitorEtag(m))) throw httpError('precondition-failed', 'The monitor changed since you read it.', { extensions: { current_etag: monitorEtag(m) } });
}

function windowRange(ctx, windowKey) {
  const to = ctx.clock();
  return { from: to - WINDOWS[windowKey], to };
}

// ------------------------------------------------------------------- routes

const MAX_STREAMS_PER_CLIENT = 5;

export function registerRoutes(router, { db, config, scheduler, events, clock }) {
  const streamsPerClient = new Map();
  const withClock = (fn) => (ctx) => fn({ ...ctx, clock });

  router.add('GET', '/v1', () => ({
    body: {
      name: 'API Health Monitor',
      version: '1.0.0',
      auth: { scheme: 'bearer', required_for_writes: !!config.apiKey, required_for_reads: !!config.apiKey && !config.publicRead },
      links: { monitors: '/v1/monitors', incidents: '/v1/incidents', overview: '/v1/overview', events: '/v1/events', health: '/v1/health', openapi: '/v1/openapi.json' },
    },
  }), { public: true });

  router.add('GET', '/v1/health', () => {
    db.prepare('SELECT 1').get();
    return {
      body: { status: 'ok', checks: { database: 'ok', scheduler: scheduler ? (scheduler.timer ? 'running' : 'stopped') : 'disabled' }, in_flight_checks: scheduler?.running.size ?? 0 },
      headers: { 'Cache-Control': 'no-store' },
    };
  }, { public: true });

  router.add('GET', '/v1/openapi.json', () => ({ body: openApiDocument }), { public: true });

  // ------------------------------------------------------------- monitors
  router.add('GET', '/v1/monitors', (ctx) => {
    const q = readQuery(ctx.query, {
      status: { enum: ['pending', 'up', 'degraded', 'down', 'paused'] },
      tag: { max: 32 },
      q: { max: 100 },
      sort: { enum: ['created_at', '-created_at', 'name', '-name'], default: '-created_at' },
      limit: { int: [1, 100], default: 25 },
      expand: { enum: ['state'] },
      cursor: { max: 512 },
    });
    const after = q.cursor ? decodeCursor(q.cursor, { sort: q.sort }) : undefined;
    const { items, next } = repo.listMonitors(db, { ...q, after });
    const data = items.map((m) => (q.expand === 'state' ? { ...present(m, { anonymous: isAnonymous(ctx) }), state: stateOf(db, m) } : present(m, { anonymous: isAnonymous(ctx) })));
    return page(ctx, data, next, { sort: q.sort });
  });

  router.add('POST', '/v1/monitors', (ctx) =>
    idempotent(ctx, db, async () => {
      const { value, errors } = validateMonitor(ctx.body, config);
      if (errors) throw validationError(errors);
      const m = repo.insertMonitor(db, value);
      scheduler?.schedule(m, { initial: true });
      events.publish({ type: 'monitor.created', data: present(m, { anonymous: true }) });
      return { status: 201, body: present(m), headers: { Location: `/v1/monitors/${m.id}`, ETag: monitorEtag(m) } };
    }), { bodyRequired: true });

  router.add('GET', '/v1/monitors/:id', (ctx) => {
    const m = loadMonitor(db, ctx.params.id);
    return { body: present(m, { anonymous: isAnonymous(ctx) }), headers: { ETag: etagFor(m, ctx) } };
  });

  router.add('PATCH', '/v1/monitors/:id', (ctx) => {
    const m = loadMonitor(db, ctx.params.id);
    checkIfMatch(ctx, m, { required: true });
    if (ctx.body === null || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) throw validationError([{ pointer: '', detail: 'Merge patch must be a JSON object.' }]);
    const current = monitorInputOf(m);
    const merged = mergePatch(current, ctx.body);
    // Fields removed by the patch (null) fall back to defaults; READ_ONLY
    // keys present in the patch are rejected by validateMonitor.
    const originOf = (u) => {
      try {
        return new URL(u).origin;
      } catch {
        return null;
      }
    };
    if (typeof ctx.body.url === 'string' && originOf(ctx.body.url) !== originOf(m.url)) {
      // Credentials were configured for the old origin. Re-pointing a monitor
      // must not carry them to a new host (this also defuses a DNS-rebinding
      // page that edits the URL of a keyless local instance). Keep safe
      // headers and whatever the patch itself sets; drop the body unless the
      // patch supplies one.
      const h = mergePatch(keepSafeHeaders(m.headers), ctx.body.headers ?? {});
      merged.headers = Object.fromEntries(Object.entries(h).filter(([, v]) => v !== REDACTED));
      if (!('body' in ctx.body)) merged.body = null;
    } else if (merged.headers) merged.headers = restoreRedacted(merged.headers, m.headers);
    const { value, errors } = validateMonitor(merged, config);
    if (errors) throw validationError(errors);
    const updated = repo.updateMonitor(db, m.id, value, m.version);
    if (!updated) throw httpError('precondition-failed', 'The monitor changed while this request was processed.');
    if (updated.paused) scheduler?.unschedule(updated.id);
    else scheduler?.schedule(updated, { initial: m.paused });
    events.publish({ type: 'monitor.updated', data: present(updated, { anonymous: true }) });
    return { body: present(updated), headers: { ETag: monitorEtag(updated) } };
  }, { bodyRequired: true, contentTypes: ['application/merge-patch+json', 'application/json'] });

  router.add('DELETE', '/v1/monitors/:id', (ctx) => {
    const m = loadMonitor(db, ctx.params.id);
    checkIfMatch(ctx, m, { required: false });
    repo.deleteMonitor(db, m.id);
    scheduler?.unschedule(m.id);
    events.publish({ type: 'monitor.deleted', data: { id: m.id } });
    return { status: 204 };
  });

  router.add('GET', '/v1/monitors/:id/state', (ctx) => {
    readQuery(ctx.query, {});
    return { body: stateOf(db, loadMonitor(db, ctx.params.id)) };
  });

  // --------------------------------------------------------------- checks
  router.add('GET', '/v1/monitors/:id/checks', (ctx) => {
    loadMonitor(db, ctx.params.id);
    const q = readQuery(ctx.query, {
      since: { date: true },
      until: { date: true },
      outcome: { enum: ['up', 'degraded', 'down', 'fail'] },
      limit: { int: [1, 200], default: 50 },
      cursor: { max: 512 },
    });
    const after = q.cursor ? decodeCursor(q.cursor) : undefined;
    const { items, next } = repo.listChecks(db, { monitorId: ctx.params.id, ...q, after });
    return page(ctx, items, next);
  });

  // Triggers a check now. POST to the collection creates a new check
  // resource, so the response is 201 + Location, not 200.
  router.add('POST', '/v1/monitors/:id/checks', (ctx) =>
    idempotent(ctx, db, async () => {
      const m = loadMonitor(db, ctx.params.id);
      if (!scheduler) throw httpError('method-not-allowed', 'Checks cannot be triggered on this deployment (scheduler disabled).');
      const check = await scheduler.execute(m);
      if (!check) throw httpError('not-found', `Monitor ${m.id} was deleted while the check ran.`);
      return { status: 201, body: check, headers: { Location: `/v1/checks/${check.id}` } };
    }), { cost: 10 });

  router.add('GET', '/v1/checks/:id', (ctx) => {
    const c = repo.getCheck(db, ctx.params.id);
    if (!c) throw httpError('not-found', `Check ${ctx.params.id} does not exist.`);
    return { body: c, headers: { 'Cache-Control': 'max-age=86400, immutable' } };
  });

  router.add('GET', '/v1/monitors/:id/stats', withClock((ctx) => {
    const m = loadMonitor(db, ctx.params.id);
    const q = readQuery(ctx.query, { window: { enum: Object.keys(WINDOWS), default: '24h' }, buckets: { int: [1, 200], default: 48 } });
    const { from, to } = windowRange(ctx, q.window);
    const rows = repo.checksSince(db, m.id, new Date(from).toISOString());
    return {
      body: {
        monitor_id: m.id,
        window: q.window,
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        summary: summarize(rows, { apdexT: apdexThreshold(m), sloTarget: m.slo_target }),
        phases_ms: phaseBreakdown(rows),
        status_codes: statusCodes(rows),
        histogram: histogram(rows),
        series: series(rows, { from, to, buckets: q.buckets }),
      },
    };
  }));

  // -------------------------------------------------------------- incidents
  router.add('GET', '/v1/incidents', (ctx) => {
    const q = readQuery(ctx.query, { state: { enum: ['open', 'resolved'] }, monitor_id: { max: 40 }, limit: { int: [1, 100], default: 50 }, cursor: { max: 512 } });
    const after = q.cursor ? decodeCursor(q.cursor) : undefined;
    const { items, next } = repo.listIncidents(db, { state: q.state, monitorId: q.monitor_id, limit: q.limit, after });
    return page(ctx, items, next);
  });

  router.add('GET', '/v1/incidents/:id', (ctx) => {
    const i = repo.getIncident(db, ctx.params.id);
    if (!i) throw httpError('not-found', `Incident ${ctx.params.id} does not exist.`);
    return { body: i };
  });

  // --------------------------------------------------------------- overview
  // Aggregate read model for the dashboard: one request instead of 1 + 2N.
  router.add('GET', '/v1/overview', withClock((ctx) => {
    const q = readQuery(ctx.query, { window: { enum: ['1h', '6h', '24h', '7d'], default: '24h' } });
    const { from, to } = windowRange(ctx, q.window);
    const fromIso = new Date(from).toISOString();
    const monitors = repo.allMonitors(db);
    let all = [];
    const totals = { monitors: monitors.length, up: 0, degraded: 0, down: 0, pending: 0, paused: 0 };
    const items = monitors.map((m) => {
      const rows = repo.checksSince(db, m.id, fromIso);
      all = all.concat(rows);
      const s = summarize(rows, { apdexT: apdexThreshold(m), sloTarget: m.slo_target });
      const status = m.paused ? 'paused' : m.last_status;
      totals[status] += 1;
      return {
        id: m.id,
        name: m.name,
        url: isAnonymous(ctx) ? redactUrl(m.url) : m.url,
        method: m.method,
        tags: m.tags,
        interval_s: m.interval_s,
        status,
        last_checked_at: m.last_checked_at,
        checks: s.checks,
        availability: s.availability,
        p50_ms: s.latency_ms.p50,
        p95_ms: s.latency_ms.p95,
        apdex: s.apdex,
        recent: rows.slice(-40).map((r) => ({ t: r.started_at, outcome: r.outcome, ms: r.duration_ms, code: r.status_code })),
        trend: series(rows, { from, to, buckets: 24 }).map((b) => b.p50_ms),
      };
    });
    const overall = summarize(all);
    return {
      body: {
        generated_at: new Date(to).toISOString(),
        window: q.window,
        totals: { ...totals, open_incidents: repo.listIncidents(db, { state: 'open', limit: 100 }).items.length },
        availability: overall.availability,
        latency_ms: overall.latency_ms,
        checks: overall.checks,
        trend: series(all, { from, to, buckets: 24 }),
        monitors: items,
        recent_failures: repo.recentFailures(db, fromIso, 12),
      },
    };
  }));

  // ----------------------------------------------------------------- events
  router.add('GET', '/v1/events', (ctx) => {
    const { req, res } = ctx;
    // Per-client cap so one address cannot occupy every stream slot.
    const who = req.socket.remoteAddress || 'unknown';
    const mine = streamsPerClient.get(who) || 0;
    if (events.clients.size >= events.maxClients || mine >= MAX_STREAMS_PER_CLIENT) throw httpError('stream-capacity', undefined, { headers: { 'Retry-After': '30' } });
    streamsPerClient.set(who, mine + 1);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 5000\n\n');
    // A reader that stops consuming is dropped instead of buffering forever.
    const write = (chunk) => {
      if (res.writableLength > 1024 * 1024) return res.destroy();
      res.write(chunk);
    };
    const last = Number(req.headers['last-event-id'] ?? ctx.query.get('last_event_id'));
    if (Number.isInteger(last) && last > 0) for (const e of events.since(last)) write(formatSse(e));
    const unsubscribe = events.subscribe((e) => write(formatSse(e)));
    const heartbeat = setInterval(() => write(': keep-alive\n\n'), 25000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      const n = (streamsPerClient.get(who) || 1) - 1;
      if (n) streamsPerClient.set(who, n);
      else streamsPerClient.delete(who);
    });
    return { streaming: true };
  }, { stream: true });
}
