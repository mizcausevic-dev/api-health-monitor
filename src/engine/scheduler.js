// In-process scheduler. One timer wheel ticking every second; each monitor
// has a next-run time with jitter so 50 monitors created together do not all
// fire in the same second. A bounded worker pool caps outbound concurrency
// and a monitor never overlaps itself.
import { EventEmitter } from 'node:events';
import { allMonitors, getMonitor, recordCheck, pruneChecks, pruneIdempotency } from '../db/repo.js';
import { runCheck as defaultRunCheck } from './checker.js';

export class Scheduler extends EventEmitter {
  constructor({ db, config, runCheck = defaultRunCheck, clock = () => Date.now() }) {
    super();
    this.db = db;
    this.config = config;
    this.runCheck = runCheck;
    this.clock = clock;
    this.next = new Map(); // monitor id -> epoch ms
    this.running = new Set();
    this.timer = null;
    this.lastPrune = 0;
  }

  intervalMs(m) {
    return (this.config.intervalOverrideS || m.interval_s) * 1000;
  }

  start() {
    for (const m of allMonitors(this.db)) this.schedule(m, { initial: true });
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.();
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    // Let in-flight checks land so their results are not lost on shutdown.
    const deadline = Date.now() + 5000;
    while (this.running.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }

  schedule(m, { initial = false } = {}) {
    if (m.paused) return this.next.delete(m.id);
    const interval = this.intervalMs(m);
    const jitter = Math.random() * Math.min(interval * 0.1, initial ? 15000 : 5000);
    this.next.set(m.id, this.clock() + (initial ? jitter : interval + jitter));
  }

  unschedule(id) {
    this.next.delete(id);
  }

  tick() {
    const now = this.clock();
    for (const [id, at] of this.next) {
      if (this.running.size >= this.config.maxConcurrency) break;
      if (at > now || this.running.has(id)) continue;
      const m = getMonitor(this.db, id);
      if (!m || m.paused) {
        this.next.delete(id);
        continue;
      }
      this.next.set(id, now + this.intervalMs(m));
      this.execute(m).catch((err) => this.emit('error', err));
    }
    if (now - this.lastPrune > 3600e3) {
      this.lastPrune = now;
      pruneChecks(this.db, new Date(now - this.config.retentionDays * 86400e3).toISOString());
      pruneIdempotency(this.db, new Date(now - 86400e3).toISOString());
    }
  }

  // Runs one check and records it. Used by the timer and by
  // POST /v1/monitors/{id}/checks.
  async execute(monitor, { now } = {}) {
    this.running.add(monitor.id);
    try {
      const check = await this.runCheck(monitor, {
        allowPrivate: this.config.allowPrivateTargets,
        probe: this.config.probe,
        now: now ?? new Date(this.clock()),
      });
      // Re-read: the monitor may have changed or been deleted while the
      // request was in flight.
      const current = getMonitor(this.db, monitor.id);
      if (!current) return null;
      const { monitor: updated, event } = recordCheck(this.db, current, check);
      this.emit('event', { type: 'check.completed', data: { check: { ...check, response_sample: undefined }, monitor: { id: updated.id, last_status: updated.last_status, consecutive_failures: updated.consecutive_failures } } });
      if (event) this.emit('event', { type: event.type, data: event.incident });
      return check;
    } finally {
      this.running.delete(monitor.id);
    }
  }
}
