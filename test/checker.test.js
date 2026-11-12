import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCheck } from '../src/engine/checker.js';
import { Scheduler } from '../src/engine/scheduler.js';
import { openDb } from '../src/db/index.js';
import { insertMonitor, getMonitor, listIncidents } from '../src/db/repo.js';
import { validateMonitor } from '../src/api/validate.js';
import { startTarget } from './helpers.js';

let target;
before(async () => (target = await startTarget()));
after(() => target.close());

const mon = (path, extra = {}) => ({ id: 'mon_t', url: `${target.url}${path}`, method: 'GET', headers: {}, body: null, timeout_ms: 2000, follow_redirects: false, assertions: [], ...extra });

test('phase timings are recorded and add up to the total', async () => {
  const c = await runCheck(mon('/ok'), { allowPrivate: true });
  assert.equal(c.outcome, 'up');
  assert.equal(c.status_code, 200);
  assert.equal(c.remote_address, '127.0.0.1');
  const t = c.timings;
  for (const k of ['connect_ms', 'ttfb_ms', 'transfer_ms']) assert.equal(typeof t[k], 'number', k);
  assert.equal(t.tls_ms, null, 'plain http has no TLS phase');
  const sum = t.dns_ms + t.connect_ms + t.ttfb_ms + t.transfer_ms;
  assert.ok(sum <= t.total_ms + 1, `${sum} <= ${t.total_ms}`);
});

test('timeouts, latency budgets, redirects and body capture limits', async () => {
  const timedOut = await runCheck(mon('/slow?ms=800', { timeout_ms: 200 }), { allowPrivate: true });
  assert.equal(timedOut.outcome, 'down');
  assert.equal(timedOut.error.code, 'timeout');
  assert.ok(timedOut.timings.total_ms < 600);

  const slow = await runCheck(mon('/slow?ms=150', { assertions: [{ source: 'status', op: 'eq', target: 200 }, { source: 'latency_ms', op: 'lt', target: 50 }] }), { allowPrivate: true });
  assert.equal(slow.outcome, 'degraded', 'correct but slow is degraded, not down');
  assert.equal(slow.response_sample.body, 'slow but fine');

  const noFollow = await runCheck(mon('/redirect'), { allowPrivate: true });
  assert.equal(noFollow.status_code, 302);
  const follow = await runCheck(mon('/redirect', { follow_redirects: true, assertions: [{ source: 'json', property: 'items[0].id', op: 'eq', target: 7 }] }), { allowPrivate: true });
  assert.equal(follow.status_code, 200);
  assert.equal(follow.redirects, 1);
  assert.equal(follow.outcome, 'up');

  const big = await runCheck(mon('/big', { assertions: [{ source: 'body', op: 'contains', target: 'y' }] }), { allowPrivate: true });
  assert.equal(big.response_bytes, 400 * 1024, 'byte count covers the whole body');
  assert.equal(big.response_sample.body.length, 2048, 'stored sample is bounded');
  assert.equal(big.response_sample.body_truncated, true);
});

test('redirects never carry credentials to another origin, or downgrade to http', async () => {
  const other = await startTarget();
  try {
    const secret = { Authorization: 'Bearer prod-token', 'X-Api-Key': 'k' };
    const sameOrigin = await runCheck(mon(`/to?u=${encodeURIComponent('/echo')}`, { headers: secret, follow_redirects: true, assertions: [{ source: 'json', property: 'headers.authorization', op: 'eq', target: 'Bearer prod-token' }] }), { allowPrivate: true });
    assert.equal(sameOrigin.outcome, 'up', 'same-origin redirect keeps headers');
    const cross = await runCheck(mon(`/to?code=307&u=${encodeURIComponent(`${other.url}/echo`)}`, { headers: secret, method: 'POST', body: 'client_secret=x', follow_redirects: true, assertions: [{ source: 'json', property: 'headers.authorization', op: 'not_exists' }, { source: 'json', property: 'headers.x-api-key', op: 'not_exists' }] }), { allowPrivate: true });
    assert.equal(cross.redirects, 1);
    assert.equal(cross.outcome, 'up', JSON.stringify(cross.failed_assertions));
  } finally {
    await other.close();
  }
});

test('blocked and unreachable targets produce typed errors', async () => {
  const blocked = await runCheck(mon('/ok'), { allowPrivate: false });
  assert.equal(blocked.error.code, 'blocked_target');
  const refused = await runCheck({ ...mon('/'), url: 'http://127.0.0.1:1/', timeout_ms: 5000 }, { allowPrivate: true });
  assert.equal(refused.error.code, 'connection_refused');
  const dns = await runCheck({ ...mon('/'), url: 'http://does-not-exist.invalid/' }, { allowPrivate: true });
  assert.equal(dns.error.code, 'dns_failure');
});

test('scheduler: interval scheduling, threshold-gated incidents, recovery', async () => {
  const db = openDb(':memory:');
  let now = Date.parse('2026-01-01T00:00:00Z');
  const outcomes = ['down', 'down', 'down', 'up'];
  let calls = 0;
  const fakeRun = async (m, { now: at }) => {
    const outcome = outcomes[calls++] ?? 'up';
    return { id: `chk_${String(calls).padStart(26, '0')}`, monitor_id: m.id, started_at: at.toISOString(), outcome, status_code: outcome === 'up' ? 200 : 500, error: null, timings: { total_ms: 10 }, probe: 'test', failed_assertions: outcome === 'up' ? [] : [{ message: 'expected status lt 400, got 500' }], response_sample: null };
  };
  const config = { maxConcurrency: 4, retentionDays: 30, allowPrivateTargets: true, probe: 'test', intervalOverrideS: 0 };
  const s = new Scheduler({ db, config, runCheck: fakeRun, clock: () => now });
  const events = [];
  s.on('event', (e) => events.push(e.type));
  const { value } = validateMonitor({ name: 'sched', url: 'https://api.example.com', interval_s: 60, failure_threshold: 3 });
  const m = insertMonitor(db, value);
  s.schedule(m, { initial: true });
  for (let i = 0; i < 4; i++) {
    now += 70_000;
    s.tick();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(calls, 4);
  assert.deepEqual(events.filter((e) => e.startsWith('incident')), ['incident.opened', 'incident.resolved']);
  const [inc] = listIncidents(db, {}).items;
  assert.equal(inc.failed_checks, 3);
  assert.equal(inc.state, 'resolved');
  assert.equal(getMonitor(db, m.id).last_status, 'up');
});
