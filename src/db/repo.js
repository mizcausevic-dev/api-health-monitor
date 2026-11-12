// Data access. All SQL lives here, parameterised; handlers never build SQL.
import { newId } from '../ids.js';
import { tx } from './index.js';

const j = (v) => JSON.stringify(v);
const p = (v, d) => (v == null ? d : JSON.parse(v));
const iso = (d = new Date()) => (d instanceof Date ? d : new Date(d)).toISOString();

// ---------------------------------------------------------------- monitors

export function rowToMonitor(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    method: row.method,
    headers: p(row.headers, {}),
    body: row.body,
    interval_s: row.interval_s,
    timeout_ms: row.timeout_ms,
    follow_redirects: !!row.follow_redirects,
    assertions: p(row.assertions, []),
    failure_threshold: row.failure_threshold,
    slo_target: row.slo_target,
    tags: p(row.tags, []),
    paused: !!row.paused,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_status: row.last_status,
    last_checked_at: row.last_checked_at,
    consecutive_failures: row.consecutive_failures,
  };
}

export function insertMonitor(db, input, { id = newId('mon'), now = new Date() } = {}) {
  const ts = iso(now);
  db.prepare(
    `INSERT INTO monitors (id, name, url, method, headers, body, interval_s, timeout_ms, follow_redirects,
       assertions, failure_threshold, slo_target, tags, paused, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id, input.name, input.url, input.method, j(input.headers), input.body ?? null, input.interval_s,
    input.timeout_ms, input.follow_redirects ? 1 : 0, j(input.assertions), input.failure_threshold,
    input.slo_target, j(input.tags), input.paused ? 1 : 0, ts, ts,
  );
  return getMonitor(db, id);
}

export function getMonitor(db, id) {
  return rowToMonitor(db.prepare('SELECT * FROM monitors WHERE id = ?').get(id));
}

export function allMonitors(db) {
  return db.prepare('SELECT * FROM monitors ORDER BY created_at, id').all().map(rowToMonitor);
}

const SORTS = {
  created_at: 'created_at',
  name: 'name',
};

// Keyset pagination: stable under concurrent inserts, O(log n) per page,
// unlike OFFSET which skips or repeats rows when data changes between pages.
export function listMonitors(db, { status, tag, q, sort = '-created_at', limit = 25, after } = {}) {
  const desc = sort.startsWith('-');
  const col = SORTS[sort.replace(/^-/, '')];
  const where = [];
  const args = [];
  if (status) {
    if (status === 'paused') where.push('paused = 1');
    else {
      where.push('last_status = ? AND paused = 0');
      args.push(status);
    }
  }
  if (tag) {
    where.push('EXISTS (SELECT 1 FROM json_each(monitors.tags) WHERE value = ?)');
    args.push(tag);
  }
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(name LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\')");
    args.push(like, like);
  }
  if (after) {
    where.push(`(${col}, id) ${desc ? '<' : '>'} (?, ?)`);
    args.push(after.v, after.id);
  }
  const dir = desc ? 'DESC' : 'ASC';
  const sql = `SELECT * FROM monitors ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY ${col} ${dir}, id ${dir} LIMIT ?`;
  const rows = db.prepare(sql).all(...args, limit + 1);
  const items = rows.slice(0, limit).map(rowToMonitor);
  const last = items.at(-1);
  return { items, next: rows.length > limit ? { v: last[col], id: last.id } : null };
}

// Optimistic concurrency: the UPDATE only lands if the version the client
// read is still current. Returns null on a lost race.
export function updateMonitor(db, id, input, expectedVersion, now = new Date()) {
  const res = db
    .prepare(
      `UPDATE monitors SET name = ?, url = ?, method = ?, headers = ?, body = ?, interval_s = ?, timeout_ms = ?,
         follow_redirects = ?, assertions = ?, failure_threshold = ?, slo_target = ?, tags = ?, paused = ?,
         version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?`,
    )
    .run(
      input.name, input.url, input.method, j(input.headers), input.body ?? null, input.interval_s, input.timeout_ms,
      input.follow_redirects ? 1 : 0, j(input.assertions), input.failure_threshold, input.slo_target, j(input.tags),
      input.paused ? 1 : 0, iso(now), id, expectedVersion,
    );
  return res.changes === 1 ? getMonitor(db, id) : null;
}

export function deleteMonitor(db, id) {
  return db.prepare('DELETE FROM monitors WHERE id = ?').run(id).changes === 1;
}

// ------------------------------------------------------------------ checks

export function rowToCheck(row) {
  if (!row) return null;
  return {
    id: row.id,
    monitor_id: row.monitor_id,
    started_at: row.started_at,
    outcome: row.outcome,
    status_code: row.status_code,
    error: row.error_code ? { code: row.error_code, message: row.error_message } : null,
    timings: {
      total_ms: row.duration_ms,
      dns_ms: row.dns_ms,
      connect_ms: row.connect_ms,
      tls_ms: row.tls_ms,
      ttfb_ms: row.ttfb_ms,
      transfer_ms: row.transfer_ms,
    },
    response_bytes: row.response_bytes,
    remote_address: row.remote_address,
    redirects: row.redirects,
    probe: row.probe,
    failed_assertions: p(row.failed_assertions, []),
    response_sample: p(row.response_sample, null),
  };
}

export function insertCheck(db, c) {
  db.prepare(
    `INSERT INTO checks (id, monitor_id, started_at, outcome, status_code, error_code, error_message, duration_ms,
       dns_ms, connect_ms, tls_ms, ttfb_ms, transfer_ms, response_bytes, remote_address, redirects, probe,
       failed_assertions, response_sample)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.id, c.monitor_id, c.started_at, c.outcome, c.status_code ?? null, c.error?.code ?? null,
    c.error?.message ?? null, c.timings.total_ms ?? null, c.timings.dns_ms ?? null, c.timings.connect_ms ?? null,
    c.timings.tls_ms ?? null, c.timings.ttfb_ms ?? null, c.timings.transfer_ms ?? null, c.response_bytes ?? null,
    c.remote_address ?? null, c.redirects ?? 0, c.probe, j(c.failed_assertions ?? []),
    c.response_sample ? j(c.response_sample) : null,
  );
}

export function getCheck(db, id) {
  return rowToCheck(db.prepare('SELECT * FROM checks WHERE id = ?').get(id));
}

export function listChecks(db, { monitorId, since, until, outcome, limit = 50, after } = {}) {
  const where = ['monitor_id = ?'];
  const args = [monitorId];
  if (since) {
    where.push('started_at >= ?');
    args.push(since);
  }
  if (until) {
    where.push('started_at < ?');
    args.push(until);
  }
  if (outcome === 'fail') where.push("outcome != 'up'");
  else if (outcome) {
    where.push('outcome = ?');
    args.push(outcome);
  }
  if (after) {
    where.push('(started_at, id) < (?, ?)');
    args.push(after.v, after.id);
  }
  const rows = db
    .prepare(`SELECT * FROM checks WHERE ${where.join(' AND ')} ORDER BY started_at DESC, id DESC LIMIT ?`)
    .all(...args, limit + 1);
  const items = rows.slice(0, limit).map(rowToCheck);
  const last = items.at(-1);
  return { items, next: rows.length > limit ? { v: last.started_at, id: last.id } : null };
}

// Lean projection for statistics: no samples, chronological.
export function checksSince(db, monitorId, sinceIso) {
  return db
    .prepare(
      `SELECT started_at, outcome, status_code, error_code, duration_ms, dns_ms, connect_ms, tls_ms, ttfb_ms, transfer_ms
       FROM checks WHERE monitor_id = ? AND started_at >= ? ORDER BY started_at ASC`,
    )
    .all(monitorId, sinceIso);
}

export function recentFailures(db, sinceIso, limit = 12) {
  return db
    .prepare(
      `SELECT c.*, m.name AS monitor_name FROM checks c JOIN monitors m ON m.id = c.monitor_id
       WHERE c.outcome != 'up' AND c.started_at >= ? ORDER BY c.started_at DESC, c.id DESC LIMIT ?`,
    )
    .all(sinceIso, limit)
    .map((r) => ({ ...rowToCheck(r), monitor_name: r.monitor_name }));
}

export function pruneChecks(db, beforeIso) {
  return db.prepare('DELETE FROM checks WHERE started_at < ?').run(beforeIso).changes;
}

// --------------------------------------------------------------- incidents

export function rowToIncident(row) {
  if (!row) return null;
  return {
    id: row.id,
    monitor_id: row.monitor_id,
    monitor_name: row.monitor_name,
    state: row.resolved_at ? 'resolved' : 'open',
    opened_at: row.opened_at,
    resolved_at: row.resolved_at,
    duration_s: row.resolved_at ? Math.round((Date.parse(row.resolved_at) - Date.parse(row.opened_at)) / 1000) : null,
    cause: row.cause,
    first_check_id: row.first_check_id,
    last_check_id: row.last_check_id,
    failed_checks: row.failed_checks,
  };
}

const INCIDENT_SELECT = 'SELECT i.*, m.name AS monitor_name FROM incidents i JOIN monitors m ON m.id = i.monitor_id';

export function getIncident(db, id) {
  return rowToIncident(db.prepare(`${INCIDENT_SELECT} WHERE i.id = ?`).get(id));
}

export function openIncidentFor(db, monitorId) {
  return rowToIncident(db.prepare(`${INCIDENT_SELECT} WHERE i.monitor_id = ? AND i.resolved_at IS NULL`).get(monitorId));
}

export function listIncidents(db, { state, monitorId, limit = 50, after } = {}) {
  const where = [];
  const args = [];
  if (state === 'open') where.push('i.resolved_at IS NULL');
  if (state === 'resolved') where.push('i.resolved_at IS NOT NULL');
  if (monitorId) {
    where.push('i.monitor_id = ?');
    args.push(monitorId);
  }
  if (after) {
    where.push('(i.opened_at, i.id) < (?, ?)');
    args.push(after.v, after.id);
  }
  const rows = db
    .prepare(`${INCIDENT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.opened_at DESC, i.id DESC LIMIT ?`)
    .all(...args, limit + 1);
  const items = rows.slice(0, limit).map(rowToIncident);
  const last = items.at(-1);
  return { items, next: rows.length > limit ? { v: last.opened_at, id: last.id } : null };
}

// Persist one check result and advance the monitor's state machine
// (pending/up/degraded/down + incident open/resolve) atomically.
//
//   up/degraded  -> consecutive_failures = 0; resolve open incident
//   down         -> consecutive_failures += 1; open incident when it reaches
//                   failure_threshold, otherwise extend the open incident
export function recordCheck(db, monitor, check) {
  return tx(db, () => {
    insertCheck(db, check);
    const failed = check.outcome === 'down';
    const consecutive = failed ? monitor.consecutive_failures + 1 : 0;
    db.prepare(
      'UPDATE monitors SET last_status = ?, last_checked_at = ?, consecutive_failures = ? WHERE id = ?',
    ).run(check.outcome, check.started_at, consecutive, monitor.id);

    const open = openIncidentFor(db, monitor.id);
    let event = null;
    if (failed && !open && consecutive >= monitor.failure_threshold) {
      const id = newId('inc');
      const cause = check.error
        ? `${check.error.code}: ${check.error.message}`
        : check.failed_assertions[0]?.message || `HTTP ${check.status_code}`;
      db.prepare(
        `INSERT INTO incidents (id, monitor_id, opened_at, cause, first_check_id, last_check_id, failed_checks)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, monitor.id, check.started_at, cause.slice(0, 500), check.id, check.id, consecutive);
      event = { type: 'incident.opened', incident: getIncident(db, id) };
    } else if (failed && open) {
      db.prepare('UPDATE incidents SET last_check_id = ?, failed_checks = failed_checks + 1 WHERE id = ?').run(check.id, open.id);
    } else if (!failed && open) {
      db.prepare('UPDATE incidents SET resolved_at = ?, last_check_id = ? WHERE id = ?').run(check.started_at, check.id, open.id);
      event = { type: 'incident.resolved', incident: getIncident(db, open.id) };
    }
    return { monitor: getMonitor(db, monitor.id), event };
  });
}

// ------------------------------------------------------------- idempotency

export function getIdempotency(db, principal, key) {
  return db.prepare('SELECT * FROM idempotency_keys WHERE principal = ? AND key = ?').get(principal, key);
}

export function reserveIdempotency(db, principal, key, hash) {
  db.prepare('INSERT INTO idempotency_keys (principal, key, request_hash, created_at) VALUES (?, ?, ?, ?)').run(
    principal, key, hash, iso(),
  );
}

export function completeIdempotency(db, principal, key, status, headers, body) {
  db.prepare('UPDATE idempotency_keys SET status = ?, headers = ?, body = ? WHERE principal = ? AND key = ?').run(
    status, j(headers), body, principal, key,
  );
}

export function releaseIdempotency(db, principal, key) {
  db.prepare('DELETE FROM idempotency_keys WHERE principal = ? AND key = ? AND status IS NULL').run(principal, key);
}

export function pruneIdempotency(db, beforeIso) {
  return db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(beforeIso).changes;
}
