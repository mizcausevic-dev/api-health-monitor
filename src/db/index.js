import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Schema migrations keyed by PRAGMA user_version. Append-only: never edit a
// shipped migration, add a new one.
const MIGRATIONS = [
  `
  CREATE TABLE monitors (
    id                   TEXT PRIMARY KEY,
    name                 TEXT NOT NULL,
    url                  TEXT NOT NULL,
    method               TEXT NOT NULL,
    headers              TEXT NOT NULL,
    body                 TEXT,
    interval_s           INTEGER NOT NULL,
    timeout_ms           INTEGER NOT NULL,
    follow_redirects     INTEGER NOT NULL,
    assertions           TEXT NOT NULL,
    failure_threshold    INTEGER NOT NULL,
    slo_target           REAL NOT NULL,
    tags                 TEXT NOT NULL,
    paused               INTEGER NOT NULL,
    version              INTEGER NOT NULL,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    last_status          TEXT NOT NULL DEFAULT 'pending',
    last_checked_at      TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX monitors_created ON monitors (created_at, id);
  CREATE INDEX monitors_name ON monitors (name, id);

  CREATE TABLE checks (
    id                TEXT PRIMARY KEY,
    monitor_id        TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    started_at        TEXT NOT NULL,
    outcome           TEXT NOT NULL CHECK (outcome IN ('up','degraded','down')),
    status_code       INTEGER,
    error_code        TEXT,
    error_message     TEXT,
    duration_ms       REAL,
    dns_ms            REAL,
    connect_ms        REAL,
    tls_ms            REAL,
    ttfb_ms           REAL,
    transfer_ms       REAL,
    response_bytes    INTEGER,
    remote_address    TEXT,
    redirects         INTEGER NOT NULL DEFAULT 0,
    probe             TEXT NOT NULL,
    failed_assertions TEXT NOT NULL DEFAULT '[]',
    response_sample   TEXT
  );
  CREATE INDEX checks_monitor_time ON checks (monitor_id, started_at DESC, id DESC);
  CREATE INDEX checks_time ON checks (started_at);

  CREATE TABLE incidents (
    id             TEXT PRIMARY KEY,
    monitor_id     TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    opened_at      TEXT NOT NULL,
    resolved_at    TEXT,
    cause          TEXT NOT NULL,
    first_check_id TEXT NOT NULL,
    last_check_id  TEXT NOT NULL,
    failed_checks  INTEGER NOT NULL
  );
  CREATE INDEX incidents_monitor ON incidents (monitor_id, opened_at DESC);
  CREATE UNIQUE INDEX incidents_one_open ON incidents (monitor_id) WHERE resolved_at IS NULL;

  CREATE TABLE idempotency_keys (
    principal     TEXT NOT NULL,
    key           TEXT NOT NULL,
    request_hash  TEXT NOT NULL,
    status        INTEGER,
    headers       TEXT,
    body          TEXT,
    created_at    TEXT NOT NULL,
    PRIMARY KEY (principal, key)
  );
  `,
];

export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
