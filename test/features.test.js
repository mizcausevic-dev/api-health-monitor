// Tests for: error-budget sufficiency, per-monitor capture policy, the
// publication secret gate, and signed incident webhooks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errorBudget } from '../src/engine/stats.js';
import { applyCapture } from '../src/engine/checker.js';
import { parseWebhookConfig, deliver, buildPayload, eventId, sign } from '../src/engine/notify.js';
import { secretValues, secretHits, unservableFiles } from '../scripts/publication-gate.js';
import { startApi, startTarget, monitorBody } from './helpers.js';

const SECRET = `whsec_${randomBytes(32).toString('base64')}`;
const KEY = Buffer.from(SECRET.slice(6), 'base64');

// A local webhook receiver that records requests and answers from a script.
async function startReceiver(statuses = []) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(statuses.shift() ?? 204);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/hook`, received, close: () => new Promise((r) => server.close(r)) };
}

const incident = (over = {}) => ({ id: 'inc_01m7aaaaaaaaaaaaaaaaaaaaaa', monitor_id: 'mon_x', monitor_name: 'Payments', state: 'open', opened_at: '2026-11-12T10:00:00.000Z', resolved_at: null, duration_s: null, failed_checks: 3, cause: 'expected status eq 200, got 503', ...over });

// ------------------------------------------------------------ error budget

test('error budget: insufficient data instead of a misleading percentage', () => {
  // 96 checks/day at 99.5 % allows 0.48 failures: one failure used to read -100 %.
  const thin = errorBudget(96, 1, 0.995);
  assert.equal(thin.status, 'insufficient_data');
  assert.equal(thin.remaining, null);
  assert.equal(thin.min_checks, 200);
  assert.equal(thin.allowed_failures, 0.48);
  assert.equal(errorBudget(0, 0, 0.999).status, 'no_data');
  const ok = errorBudget(1000, 2, 0.995);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.remaining, 0.6);
  const out = errorBudget(1000, 9, 0.995);
  assert.equal(out.status, 'exhausted');
  assert.equal(out.remaining, -0.8);
  assert.equal(errorBudget(1000, 0, 0.999).min_checks, 1000, 'no floating-point off-by-one');
});

// ----------------------------------------------------------------- capture

test('capture policy: status_only drops observed values, none drops details', () => {
  const failures = [{ index: 0, source: 'json', property: 'token', op: 'eq', target: 'x', actual: 'sk_live_leaky', message: 'expected json token eq "x", got "sk_live_leaky"', expected: 'expected json token eq "x"' }];
  const sample = { headers: { 'content-type': 'application/json' }, body: '{"token":"sk_live_leaky"}', body_truncated: false };
  assert.deepEqual(applyCapture('sample', failures, sample).response_sample, sample);
  const s = applyCapture('status_only', failures, sample);
  assert.equal(s.response_sample, null);
  assert.doesNotMatch(JSON.stringify(s), /sk_live_leaky/);
  assert.equal(s.failed_assertions[0].message, 'expected json token eq "x"');
  const n = applyCapture('none', failures, sample);
  assert.deepEqual(n.failed_assertions, [{ index: 0, source: 'json', message: 'assertion 1 (json) failed' }]);
});

test('capture through the API: incidents and the log carry no observed values', async () => {
  const target = await startTarget();
  const api = await startApi();
  try {
    const bad = await api.call('POST', '/v1/monitors', { body: monitorBody(`${target.url}/fail`, { capture: 'verbose' }) });
    assert.equal(bad.status, 422);
    assert.equal(bad.json.errors[0].pointer, '/capture');
    const { json: m } = await api.call('POST', '/v1/monitors', { body: monitorBody(`${target.url}/fail`, { capture: 'status_only', failure_threshold: 1, assertions: [{ source: 'status', op: 'eq', target: 200 }] }) });
    assert.equal(m.capture, 'status_only');
    const run = await api.call('POST', `/v1/monitors/${m.id}/checks`);
    assert.equal(run.json.outcome, 'down');
    assert.equal(run.json.response_sample, null);
    assert.equal(run.json.failed_assertions[0].message, 'expected status eq 200');
    const inc = await api.call('GET', `/v1/incidents?monitor_id=${m.id}`);
    assert.equal(inc.json.data[0].cause, 'expected status eq 200');
    // The status code is kept by design; the response body is not.
    assert.doesNotMatch(JSON.stringify(run.json) + JSON.stringify(inc.json), /maintenance/);
  } finally {
    await api.close();
    await target.close();
  }
});

// -------------------------------------------------------- publication gate

test('secret gate finds raw, JSON-escaped and URL-encoded secrets; ignores safe headers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahm-gate-'));
  try {
    mkdirSync(join(dir, 'api'));
    writeFileSync(join(dir, 'index.html'), '<p>nothing here</p>');
    const secrets = secretValues({ AHM_SECRET_PAYMENTS: 'Bearer p@ss/word"1', AHM_API_KEY: 'k'.repeat(32), AHM_SECRET_PIN: '1234', PATH: '/usr/bin:/bin' }, [{ id: 'mon_a', url: 'https://api.example.com/x?api_key=qwerty123&latitude=51.51', body: 'client_secret=zzz999', headers: { Authorization: 'Bearer abcdef123', Accept: 'application/json' } }]);
    assert.deepEqual(secrets.map((s) => s.label).sort(), ['env AHM_API_KEY', 'env AHM_SECRET_PAYMENTS', 'monitor mon_a header Authorization', 'monitor mon_a query api_key', 'monitor mon_a request body']);
    assert.deepEqual(secrets.skipped, ['env AHM_SECRET_PIN'], 'short values are reported, not silently ignored');
    assert.deepEqual(secretHits(dir, secrets), [], 'clean site passes');
    writeFileSync(join(dir, 'api', 'a.json'), JSON.stringify({ leaked: 'Bearer p@ss/word"1' }));
    writeFileSync(join(dir, 'api', 'b.json'), JSON.stringify({ location: `https://x/?t=${encodeURIComponent('Bearer abcdef123')}&api_key=qwerty123` }));
    writeFileSync(join(dir, 'app.js'), 'const header = "Bearer abcdef123";'); // copied source, not scanned
    const hits = secretHits(dir, secrets);
    assert.equal(hits.length, 3);
    assert.ok(hits.every((h) => h.endsWith('.json')));
    assert.ok(hits.every((h) => !h.includes('p@ss') && !h.includes('abcdef')), 'reports labels, never values');
    writeFileSync(join(dir, '.env'), 'x');
    writeFileSync(join(dir, 'deploy.sh'), 'x');
    assert.deepEqual(unservableFiles(dir).sort(), ['.env', 'deploy.sh']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- webhooks

test('webhook config: https only, whsec_ secret, host allowlist, off when unset', () => {
  assert.equal(parseWebhookConfig({}), null);
  assert.throws(() => parseWebhookConfig({ AHM_WEBHOOK_URL: 'http://hooks.example.com/x', AHM_WEBHOOK_SECRET: SECRET }), /https/);
  assert.throws(() => parseWebhookConfig({ AHM_WEBHOOK_URL: 'https://hooks.example.com/x', AHM_WEBHOOK_SECRET: 'whsec_c2hvcnQ=' }), /24 base64/);
  assert.throws(() => parseWebhookConfig({ AHM_WEBHOOK_URL: 'https://hooks.example.com/x', AHM_WEBHOOK_SECRET: 'plain-secret-value-long-enough' }), /whsec_/);
  assert.throws(() => parseWebhookConfig({ AHM_WEBHOOK_URL: 'https://evil.example/x', AHM_WEBHOOK_SECRET: SECRET, AHM_WEBHOOK_HOSTS: 'hooks.slack.com' }), /AHM_WEBHOOK_HOSTS/);
  assert.throws(() => parseWebhookConfig({ AHM_WEBHOOK_URL: 'https://hooks.example.com/x', AHM_WEBHOOK_SECRET: SECRET, AHM_WEBHOOK_FORMAT: 'teams' }), /FORMAT/);
  const cfg = parseWebhookConfig({ AHM_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x', AHM_WEBHOOK_SECRET: SECRET, AHM_WEBHOOK_FORMAT: 'slack', AHM_WEBHOOK_HOSTS: 'hooks.slack.com' });
  assert.equal(cfg.format, 'slack');
  assert.deepEqual(cfg.key, KEY);
});

test('payloads: stable ids, no samples, Slack/Discord cannot be made to ping', () => {
  const e = { type: 'incident.opened', data: incident({ cause: 'expected json x eq 1, got "<!channel> @everyone"' }) };
  const json = buildPayload('json', e).body;
  assert.equal(json.id, eventId('incident.opened', e.data.id));
  assert.equal(buildPayload('json', e).id, buildPayload('json', e).id, 'deterministic, so receivers can dedupe re-deliveries');
  assert.notEqual(eventId('incident.resolved', e.data.id), json.id);
  assert.deepEqual(Object.keys(json.data.incident).sort(), ['cause', 'duration_s', 'failed_checks', 'id', 'monitor_id', 'monitor_name', 'opened_at', 'resolved_at', 'state']);
  const slack = buildPayload('slack', e, { siteUrl: 'https://x.example/app/' }).body.text;
  assert.match(slack, /&lt;!channel&gt;/);
  assert.match(slack, /<https:\/\/x\.example\/app\/#\/monitors\/mon_x\|Open monitor>/);
  assert.deepEqual(buildPayload('discord', e).body.allowed_mentions, { parse: [] });
});

test('delivery: Standard Webhooks signature verifies; retries 5xx; stops on 4xx', async () => {
  const rx = await startReceiver([503, 200]);
  try {
    const cfg = { url: new URL(rx.url), key: KEY, format: 'json', allowPrivate: true };
    const r = await deliver(cfg, { type: 'incident.opened', data: incident() }, { delays: [0, 0, 0] });
    assert.deepEqual({ ok: r.ok, attempts: r.attempts }, { ok: true, attempts: 2 });
    const { headers, body } = rx.received[1];
    // Verify exactly as a receiver following the spec would.
    const expected = createHmac('sha256', KEY).update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`).digest('base64');
    assert.equal(headers['webhook-signature'], `v1,${expected}`);
    assert.equal(headers['webhook-signature'], sign(KEY, headers['webhook-id'], Number(headers['webhook-timestamp']), body));
    assert.ok(Math.abs(Number(headers['webhook-timestamp']) - Date.now() / 1000) < 10);
    assert.equal(rx.received[0].headers['webhook-id'], headers['webhook-id'], 'retries reuse the id');
    assert.doesNotMatch(body, /response_sample/);
  } finally {
    await rx.close();
  }
  const rx400 = await startReceiver([400, 200]);
  try {
    const r = await deliver({ url: new URL(rx400.url), key: KEY, format: 'json', allowPrivate: true }, { type: 'incident.opened', data: incident() }, { delays: [0, 0, 0] });
    assert.deepEqual({ ok: r.ok, attempts: r.attempts, status: r.status }, { ok: false, attempts: 1, status: 400 });
  } finally {
    await rx400.close();
  }
});

test('delivery goes through the SSRF guard', async () => {
  const r = await deliver({ url: new URL('http://127.0.0.1:9/hook'), key: KEY, format: 'json', allowPrivate: false }, { type: 'incident.opened', data: incident() }, { delays: [0, 0] });
  assert.deepEqual({ ok: r.ok, attempts: r.attempts, error: r.error }, { ok: false, attempts: 1, error: 'blocked_target' });
});

test('end to end: an incident opening and resolving each sends one signed webhook', async () => {
  const target = await startTarget();
  const rx = await startReceiver();
  const api = await startApi({}, { webhook: { url: new URL(rx.url), key: KEY, format: 'json', allowPrivate: true }, webhookOptions: { delays: [0] } });
  try {
    const { json: m } = await api.call('POST', '/v1/monitors', { body: monitorBody(`${target.url}/fail`, { failure_threshold: 1 }) });
    await api.call('POST', `/v1/monitors/${m.id}/checks`);
    await api.call('POST', `/v1/monitors/${m.id}/checks`); // still down: no second "opened"
    await api.call('PATCH', `/v1/monitors/${m.id}`, { body: { url: `${target.url}/ok` }, headers: { 'if-match': '"v1"' } });
    await api.call('POST', `/v1/monitors/${m.id}/checks`);
    await Promise.allSettled([...api.notifier.pending]);
    const types = rx.received.map((r) => JSON.parse(r.body).type);
    assert.deepEqual(types, ['incident.opened', 'incident.resolved']);
    const opened = JSON.parse(rx.received[0].body);
    assert.equal(opened.data.incident.monitor_id, m.id);
    assert.match(opened.data.incident.cause, /got 503/);
  } finally {
    await api.close();
    await rx.close();
    await target.close();
  }
});

// ------------------------------------------------- review follow-up tests

test('signature matches the official Standard Webhooks test vector', () => {
  // From standard-webhooks/libraries/javascript/src/webhook.test.ts ("sign function works").
  const key = Buffer.from('MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'base64');
  assert.equal(sign(key, 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}'), 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE='); // gitleaks:allow (public Standard Webhooks test vector, not a credential)
});

test('tightening capture scrubs what is already stored, including incident causes', async () => {
  const target = await startTarget();
  const api = await startApi();
  try {
    const { json: m } = await api.call('POST', '/v1/monitors', { body: monitorBody(`${target.url}/fail`, { failure_threshold: 1, assertions: [{ source: 'json', property: 'error', op: 'eq', target: 'none' }] }) });
    const first = await api.call('POST', `/v1/monitors/${m.id}/checks`);
    assert.match(JSON.stringify(first.json), /maintenance/, 'sample mode stored the body and observed value');
    const p1 = await api.call('PATCH', `/v1/monitors/${m.id}`, { body: { capture: 'status_only' }, headers: { 'if-match': '"v1"' } });
    assert.equal(p1.status, 200);
    const after = await api.call('GET', `/v1/checks/${first.json.id}`);
    const inc = await api.call('GET', `/v1/incidents?monitor_id=${m.id}`);
    assert.doesNotMatch(JSON.stringify(after.json) + JSON.stringify(inc.json), /maintenance/);
    assert.equal(after.json.response_sample, null);
    assert.equal(after.json.failed_assertions[0].message, 'expected json error eq "none"');
    assert.equal(inc.json.data[0].cause, 'expected json error eq "none"');
    assert.equal(after.json.remote_address, '127.0.0.1', 'status_only keeps the remote address');
    await api.call('PATCH', `/v1/monitors/${m.id}`, { body: { capture: 'none' }, headers: { 'if-match': '"v2"' } });
    const none = await api.call('GET', `/v1/checks/${first.json.id}`);
    assert.equal(none.json.remote_address, null);
    assert.deepEqual(none.json.failed_assertions, [{ index: 0, source: 'json', message: 'assertion 1 (json) failed' }]);
    assert.equal((await api.call('GET', `/v1/incidents?monitor_id=${m.id}`)).json.data[0].cause, 'assertion failed');
    const fresh = await api.call('POST', `/v1/monitors/${m.id}/checks`);
    assert.equal(fresh.json.remote_address, null, 'new checks under none keep no address');
  } finally {
    await api.close();
    await target.close();
  }
});

test('chat formats render the cause inert: no masked links, no formatting', () => {
  const e = { type: 'incident.opened', data: incident({ cause: 'got "[Re-authenticate](https://evil.example) *now* `x`"' }) };
  const discord = buildPayload('discord', e).body.content;
  assert.match(discord, /`got "\[Re-authenticate\]\(https:\/\/evil\.example\) \*now\* 'x'"`/);
  assert.equal((discord.match(/`/g) || []).length, 2, 'exactly one code span; inner backticks neutralised');
  const slack = buildPayload('slack', e).body.text;
  assert.match(slack, /`got "\[Re-authenticate\]\(https:\/\/evil\.example\) \*now\* 'x'"`/);
});

test('delivery honours Retry-After (capped) between attempts', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(server.calls++ ? 200 : 429, { 'retry-after': '7' });
      res.end();
    });
  });
  server.calls = 0;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const waits = [];
    const r = await deliver({ url: new URL(`http://127.0.0.1:${server.address().port}/h`), key: KEY, format: 'json', allowPrivate: true }, { type: 'incident.opened', data: incident() }, { delays: [0, 1000, 1000], sleep: async (ms) => waits.push(ms) });
    assert.equal(r.ok, true);
    assert.deepEqual(waits, [7000]);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
