// Export / import of check history. The static site republishes its own
// history as data/export.json; the next scheduled build imports it, appends
// one new round of checks and publishes again. The site is the database.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db/index.js';

const CHECK_COLS = ['id', 'monitor_id', 'started_at', 'outcome', 'status_code', 'error_code', 'error_message', 'duration_ms', 'dns_ms', 'connect_ms', 'tls_ms', 'ttfb_ms', 'transfer_ms', 'response_bytes', 'remote_address', 'redirects', 'probe', 'failed_assertions', 'response_sample'];
const INCIDENT_COLS = ['id', 'monitor_id', 'opened_at', 'resolved_at', 'cause', 'first_check_id', 'last_check_id', 'failed_checks'];

export function exportHistory(db, { sinceIso }) {
  return {
    format: 'ahm-history/1',
    exported_at: new Date().toISOString(),
    checks: db.prepare(`SELECT ${CHECK_COLS.join(', ')} FROM checks WHERE started_at >= ? ORDER BY started_at`).all(sinceIso).map((r) => CHECK_COLS.map((c) => r[c])),
    incidents: db.prepare(`SELECT ${INCIDENT_COLS.join(', ')} FROM incidents WHERE resolved_at IS NULL OR resolved_at >= ?`).all(sinceIso).map((r) => INCIDENT_COLS.map((c) => r[c])),
  };
}

// Imports only rows that belong to known monitors and have the expected
// shape; anything else in the file is ignored.
export function importHistory(db, data, { sinceIso }) {
  if (!data || data.format !== 'ahm-history/1' || !Array.isArray(data.checks)) return { checks: 0, incidents: 0 };
  const known = new Set(db.prepare('SELECT id FROM monitors').all().map((r) => r.id));
  const insC = db.prepare(`INSERT OR IGNORE INTO checks (${CHECK_COLS.join(', ')}) VALUES (${CHECK_COLS.map(() => '?').join(', ')})`);
  const insI = db.prepare(`INSERT OR IGNORE INTO incidents (${INCIDENT_COLS.join(', ')}) VALUES (${INCIDENT_COLS.map(() => '?').join(', ')})`);
  let checks = 0;
  let incidents = 0;
  // SQLite tables here are not STRICT, so a string in a numeric column would
  // be stored as-is and later rendered. Validate every column's type.
  const num = (v) => v === null || (typeof v === 'number' && Number.isFinite(v));
  const str = (v, max) => typeof v === 'string' && v.length <= max;
  const optStr = (v, max) => v === null || str(v, max);
  const json = (v, max) => {
    if (v === null) return true;
    if (!str(v, max)) return false;
    try {
      JSON.parse(v);
      return true;
    } catch {
      return false;
    }
  };
  const checkOk = (r) =>
    str(r[0], 40) && known.has(r[1]) && str(r[2], 30) && !Number.isNaN(Date.parse(r[2])) && r[2] >= sinceIso && ['up', 'degraded', 'down'].includes(r[3]) &&
    num(r[4]) && optStr(r[5], 40) && optStr(r[6], 400) && [7, 8, 9, 10, 11, 12, 13].every((i) => num(r[i])) &&
    optStr(r[14], 64) && Number.isInteger(r[15]) && str(r[16], 40) && json(r[17], 20000) && r[17] !== null && json(r[18], 10000);
  const incidentOk = (r) =>
    str(r[0], 40) && known.has(r[1]) && str(r[2], 30) && optStr(r[3], 30) && str(r[4], 600) && str(r[5], 40) && str(r[6], 40) && Number.isInteger(r[7]);
  db.exec('BEGIN');
  try {
    for (const row of data.checks) {
      if (!Array.isArray(row) || row.length !== CHECK_COLS.length || !checkOk(row)) continue;
      checks += insC.run(...row).changes;
    }
    for (const row of data.incidents ?? []) {
      if (!Array.isArray(row) || row.length !== INCIDENT_COLS.length || !incidentOk(row)) continue;
      try {
        incidents += insI.run(...row).changes;
      } catch { /* a second open incident for a monitor violates the unique index; skip */ }
    }
    // Rebuild each monitor's runtime state from its newest checks.
    for (const id of known) {
      const recent = db.prepare('SELECT outcome, started_at FROM checks WHERE monitor_id = ? ORDER BY started_at DESC LIMIT 20').all(id);
      if (!recent.length) continue;
      let streak = 0;
      while (streak < recent.length && recent[streak].outcome === 'down') streak += 1;
      db.prepare('UPDATE monitors SET last_status = ?, last_checked_at = ?, consecutive_failures = ? WHERE id = ?').run(recent[0].outcome, recent[0].started_at, streak, id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { checks, incidents };
}

// CLI: node scripts/history.js export <db> <out.json> [days]
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , cmd, dbPath, file, days = '8'] = process.argv;
  if (cmd !== 'export' || !dbPath || !file) {
    process.stderr.write('usage: node scripts/history.js export <db> <out.json> [days]\n');
    process.exit(2);
  }
  const db = openDb(dbPath);
  const data = exportHistory(db, { sinceIso: new Date(Date.now() - Number(days) * 86400e3).toISOString() });
  writeFileSync(file, JSON.stringify(data));
  process.stdout.write(`exported ${data.checks.length} checks, ${data.incidents.length} incidents to ${file}\n`);
}

export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
