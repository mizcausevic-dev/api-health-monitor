import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startApi, startTarget, monitorBody, API_KEY } from './helpers.js';
import { openApiDocument } from '../src/api/openapi.js';
import { runCheck } from '../src/engine/checker.js';

let api;
let target;
before(async () => {
  target = await startTarget();
  api = await startApi();
});
after(async () => {
  await api.close();
  await target.close();
});

const create = async (extra = {}, headers = {}) => api.call('POST', '/v1/monitors', { body: monitorBody(`${target.url}/ok`, extra), headers });

test('root, health and auth model', async () => {
  const root = await api.call('GET', '/v1', { auth: false });
  assert.equal(root.status, 200);
  assert.equal(root.json.auth.required_for_writes, true);
  assert.equal((await api.call('GET', '/v1/health', { auth: false })).json.status, 'ok');
  const denied = await api.call('POST', '/v1/monitors', { body: monitorBody('https://a.example'), auth: false });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('www-authenticate'), 'Bearer realm="api-health-monitor"');
  assert.match(denied.headers.get('content-type'), /application\/problem\+json/);
  assert.equal(denied.json.type.endsWith('#unauthorized'), true);
  assert.ok(denied.json.request_id);
  const wrongKey = await api.call('POST', '/v1/monitors', { body: monitorBody('https://a.example'), auth: false, headers: { authorization: 'Bearer nope' } });
  assert.equal(wrongKey.status, 401);
  // With a key configured, reads need it too unless AHM_PUBLIC_READ=true.
  assert.equal((await api.call('GET', '/v1/monitors', { auth: false })).status, 401);
  assert.equal((await api.call('GET', '/v1/monitors')).status, 200);
});

test('anonymous public reads: header allowlist, redacted query and body, distinct ETag', async () => {
  const pub = await startApi({ publicRead: true });
  try {
    const { json: m } = await pub.call('POST', '/v1/monitors', {
      body: monitorBody('https://api.example.com/v1/token?api_key=s3cret&region=eu', { method: 'POST', body: 'client_secret=abc', headers: { 'DD-API-KEY': 'dd', apikey: 'x', 'Content-Type': 'application/x-www-form-urlencoded' } }),
    });
    assert.deepEqual(m.headers, { 'DD-API-KEY': '[redacted]', apikey: '[redacted]', 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.equal(m.body, 'client_secret=abc', 'the key holder sees the body');
    const anon = await pub.call('GET', `/v1/monitors/${m.id}`, { auth: false });
    assert.equal(anon.status, 200);
    assert.equal(anon.json.url, 'https://api.example.com/v1/token?api_key=[redacted]&region=[redacted]');
    assert.equal(anon.json.body, '[redacted]');
    assert.equal(anon.headers.get('etag'), '"v1-public"');
    assert.match(anon.headers.get('vary'), /Authorization/);
    const list = await pub.call('GET', '/v1/monitors', { auth: false });
    assert.doesNotMatch(list.text, /s3cret|client_secret/);
  } finally {
    await pub.close();
  }
});

test('re-pointing a monitor to another origin drops its credentials', async () => {
  const { json: m } = await create({ name: 'Repoint', headers: { Authorization: 'Bearer prod', Accept: 'application/json' } });
  const res = await api.call('PATCH', `/v1/monitors/${m.id}`, { body: { url: 'https://other.example/health' }, headers: { 'if-match': '"v1"', 'content-type': 'application/merge-patch+json' } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.headers, { Accept: 'application/json' });
  const stored = JSON.parse(api.db.prepare('SELECT headers FROM monitors WHERE id = ?').get(m.id).headers);
  assert.equal(stored.Authorization, undefined);
});

test('keyless mode answers only to loopback Host values (DNS rebinding)', async () => {
  const local = await startApi({ apiKey: '' });
  try {
    const status = (host) => new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: local.port, path: '/v1/monitors', headers: { host } }, (r) => {
        r.resume();
        resolve(r.statusCode);
      });
    });
    assert.equal(await status(`127.0.0.1:${local.port}`), 200);
    assert.equal(await status(`localhost:${local.port}`), 200);
    assert.equal(await status(`attacker.example:${local.port}`), 400);
  } finally {
    await local.close();
  }
});

test('malformed percent-encoding is a 4xx, not a 500', async () => {
  for (const p of ['/v1/monitors/%E0%A4%A', '/%E0%A4%A']) {
    const code = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: api.port, path: p, headers: { authorization: `Bearer ${API_KEY}` } }, (r) => { r.resume(); resolve(r.statusCode); }));
    assert.ok(code === 400 || code === 404, `${p} -> ${code}`);
  }
});

test('create: 201 + Location + ETag; 415, 400, 413 and 422 problem details', async () => {
  const res = await create();
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('location'), `/v1/monitors/${res.json.id}`);
  assert.equal(res.headers.get('etag'), '"v1"');
  assert.equal(res.json.links.self, `/v1/monitors/${res.json.id}`);
  assert.equal(res.json.last_status, undefined, 'runtime state lives at /state, not on the monitor');

  const wrongType = await api.call('POST', '/v1/monitors', { raw: 'name=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(wrongType.status, 415);
  assert.equal(wrongType.headers.get('accept-post'), 'application/json');
  assert.equal((await api.call('POST', '/v1/monitors', { raw: '{"name":', headers: { 'content-type': 'application/json' } })).status, 400);
  assert.equal((await api.call('POST', '/v1/monitors', { raw: JSON.stringify({ name: 'x'.repeat(70000) }), headers: { 'content-type': 'application/json' } })).status, 413);

  const invalid = await api.call('POST', '/v1/monitors', { body: { name: 'x', url: 'https://a.example', interval_s: 5, colour: 'red' } });
  assert.equal(invalid.status, 422);
  assert.deepEqual(invalid.json.errors.map((e) => e.pointer).sort(), ['/colour', '/interval_s']);
});

test('Idempotency-Key replays the first response and rejects a different payload', async () => {
  const key = 'create-once-1';
  const first = await create({ name: 'Idem' }, { 'idempotency-key': key });
  const again = await create({ name: 'Idem' }, { 'idempotency-key': key });
  assert.equal(first.status, 201);
  assert.equal(again.status, 201);
  assert.equal(again.json.id, first.json.id);
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  const list = await api.call('GET', '/v1/monitors?q=Idem');
  assert.equal(list.json.data.length, 1, 'retry did not create a duplicate');
  const conflict = await create({ name: 'Different' }, { 'idempotency-key': key });
  assert.equal(conflict.status, 422);
  assert.match(conflict.json.type, /idempotency-key-reused/);
  // A failed request does not burn the key.
  const bad = await api.call('POST', '/v1/monitors', { body: { name: '' }, headers: { 'idempotency-key': 'k2' } });
  assert.equal(bad.status, 422);
  assert.equal((await create({ name: 'Fixed' }, { 'idempotency-key': 'k2' })).status, 201);
});

test('conditional requests: 304, 428, 412 and lost-update protection', async () => {
  const { json: m } = await create({ name: 'Concurrency', headers: { Authorization: 'Bearer secret', 'X-Env': 'prod' } });
  assert.equal(m.headers.Authorization, '[redacted]');
  const got = await api.call('GET', `/v1/monitors/${m.id}`);
  const etag = got.headers.get('etag');
  assert.equal((await api.call('GET', `/v1/monitors/${m.id}`, { headers: { 'if-none-match': etag } })).status, 304);

  const noMatch = await api.call('PATCH', `/v1/monitors/${m.id}`, { body: { name: 'A' }, headers: { 'content-type': 'application/merge-patch+json' } });
  assert.equal(noMatch.status, 428);
  assert.equal(noMatch.json.current_etag, '"v1"');

  const ok = await api.call('PATCH', `/v1/monitors/${m.id}`, { body: { name: 'A', headers: { 'X-Env': null, Authorization: '[redacted]' } }, headers: { 'content-type': 'application/merge-patch+json', 'if-match': etag } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('etag'), '"v2"');
  assert.deepEqual(ok.json.headers, { Authorization: '[redacted]' });
  // The secret survived the round trip through the redacted value.
  const stored = api.db.prepare('SELECT headers FROM monitors WHERE id = ?').get(m.id);
  assert.equal(JSON.parse(stored.headers).Authorization, 'Bearer secret');

  const stale = await api.call('PATCH', `/v1/monitors/${m.id}`, { body: { name: 'B' }, headers: { 'content-type': 'application/merge-patch+json', 'if-match': etag } });
  assert.equal(stale.status, 412);
  const weak = await api.call('PATCH', `/v1/monitors/${m.id}`, { body: { name: 'B' }, headers: { 'content-type': 'application/merge-patch+json', 'if-match': 'W/"v2"' } });
  assert.equal(weak.status, 412);
  const readOnly = await api.call('PATCH', `/v1/monitors/${m.id}`, { body: { version: 99 }, headers: { 'if-match': '"v2"' } });
  assert.equal(readOnly.status, 422);

  assert.equal((await api.call('DELETE', `/v1/monitors/${m.id}`, { headers: { 'if-match': '"v1"' } })).status, 412);
  assert.equal((await api.call('DELETE', `/v1/monitors/${m.id}`, { headers: { 'if-match': '"v2"' } })).status, 204);
  assert.equal((await api.call('GET', `/v1/monitors/${m.id}`)).status, 404);
});

test('method semantics: 405 + Allow, OPTIONS, HEAD, 406', async () => {
  const { json: m } = await create();
  const put = await api.call('PUT', `/v1/monitors/${m.id}`, { body: {} });
  assert.equal(put.status, 405);
  assert.equal(put.headers.get('allow'), 'GET, PATCH, DELETE, HEAD, OPTIONS');
  const opts = await api.call('OPTIONS', '/v1/monitors');
  assert.equal(opts.status, 204);
  assert.equal(opts.headers.get('allow'), 'GET, POST, HEAD, OPTIONS');
  const head = await api.call('HEAD', `/v1/monitors/${m.id}`);
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.ok(head.headers.get('etag'));
  assert.equal((await api.call('GET', '/v1/monitors', { headers: { accept: 'text/html' } })).status, 406);
  assert.equal((await api.call('GET', '/v1/nope')).status, 404);
});

test('keyset pagination: Link header, no duplicates, cursor bound to sort, strict params', async () => {
  for (let i = 0; i < 5; i++) await create({ name: `Page ${i}`, tags: ['paging'] });
  const seen = [];
  let next = '/v1/monitors?tag=paging&sort=name&limit=2';
  let pages = 0;
  while (next) {
    const res = await api.call('GET', next);
    assert.equal(res.status, 200);
    seen.push(...res.json.data.map((m) => m.name));
    const link = res.headers.get('link');
    next = res.json.page.next;
    if (next) assert.equal(link, `<${next}>; rel="next"`);
    pages += 1;
  }
  assert.equal(pages, 3);
  assert.deepEqual(seen, ['Page 0', 'Page 1', 'Page 2', 'Page 3', 'Page 4']);
  const first = await api.call('GET', '/v1/monitors?tag=paging&sort=name&limit=2');
  const swapped = await api.call('GET', `/v1/monitors?tag=paging&sort=-created_at&limit=2&cursor=${first.json.page.next_cursor}`);
  assert.equal(swapped.status, 400, 'a cursor from one sort order cannot be replayed under another');
  assert.equal((await api.call('GET', '/v1/monitors?cursor=garbage')).status, 400);
  const typo = await api.call('GET', '/v1/monitors?stauts=down');
  assert.equal(typo.status, 400);
  assert.equal(typo.json.parameter, 'stauts');
  assert.equal((await api.call('GET', '/v1/monitors?limit=1000')).status, 400);
  const expanded = await api.call('GET', '/v1/monitors?tag=paging&expand=state&limit=1');
  assert.equal(expanded.json.data[0].state.status, 'pending');
});

test('checks: run now (201), unexpected-response log, incidents open and resolve', async () => {
  const { json: m } = await api.call('POST', '/v1/monitors', { body: monitorBody(`${target.url}/fail`, { failure_threshold: 2, assertions: [{ source: 'status', op: 'eq', target: 200 }] }) });
  const run = async (key) => api.call('POST', `/v1/monitors/${m.id}/checks`, { headers: key ? { 'idempotency-key': key } : {} });
  const c1 = await run('run-1');
  assert.equal(c1.status, 201);
  assert.equal(c1.headers.get('location'), `/v1/checks/${c1.json.id}`);
  assert.equal(c1.json.outcome, 'down');
  assert.equal(c1.json.status_code, 503);
  assert.equal(c1.json.response_sample.headers['retry-after'], '30');
  assert.match(c1.json.response_sample.body, /maintenance/);
  assert.equal((await run('run-1')).json.id, c1.json.id, 'replayed, not re-run');
  let incidents = await api.call('GET', `/v1/incidents?monitor_id=${m.id}`);
  assert.equal(incidents.json.data.length, 0, 'one failure is below the threshold');
  await run();
  incidents = await api.call('GET', `/v1/incidents?monitor_id=${m.id}&state=open`);
  assert.equal(incidents.json.data.length, 1);
  assert.match(incidents.json.data[0].cause, /expected status eq 200, got 503/);
  const st = await api.call('GET', `/v1/monitors/${m.id}/state`);
  assert.equal(st.json.status, 'down');
  assert.equal(st.json.consecutive_failures, 2);

  const etag = (await api.call('GET', `/v1/monitors/${m.id}`)).headers.get('etag');
  await api.call('PATCH', `/v1/monitors/${m.id}`, { body: { url: `${target.url}/ok` }, headers: { 'if-match': etag } });
  const recovered = await run();
  assert.equal(recovered.json.outcome, 'up');
  assert.equal(recovered.json.response_sample, null, 'healthy responses are not stored');
  const resolved = await api.call('GET', `/v1/incidents?monitor_id=${m.id}`);
  assert.equal(resolved.json.data[0].state, 'resolved');

  const fails = await api.call('GET', `/v1/monitors/${m.id}/checks?outcome=fail`);
  assert.equal(fails.json.data.length, 2);
  const one = await api.call('GET', `/v1/checks/${c1.json.id}`);
  assert.match(one.headers.get('cache-control'), /immutable/);

  const stats = await api.call('GET', `/v1/monitors/${m.id}/stats?window=1h&buckets=6`);
  assert.equal(stats.json.summary.checks, 3);
  assert.equal(stats.json.summary.outcomes.down, 2);
  assert.equal(stats.json.series.length, 6);
  assert.equal(stats.json.status_codes['503'], 2);
  const overview = await api.call('GET', '/v1/overview?window=1h');
  assert.ok(overview.json.recent_failures.some((c) => c.monitor_id === m.id));
});

test('SSRF: private targets refused at validation and at connect time', async () => {
  const strict = await startApi({ allowPrivateTargets: false });
  try {
    const res = await strict.call('POST', '/v1/monitors', { body: monitorBody('http://127.0.0.1:9/') });
    assert.equal(res.status, 422);
    assert.match(res.json.errors[0].detail, /private|loopback/);
    // A hostname that resolves to loopback passes validation (DNS can change)
    // but is blocked when the socket resolves it.
    const check = await runCheck({ id: 'mon_x', url: 'http://localtest.me/', method: 'GET', headers: {}, timeout_ms: 2000, assertions: [], follow_redirects: false }, { allowPrivate: false });
    if (check.error?.code !== 'dns_failure') assert.equal(check.error.code, 'blocked_target');
  } finally {
    await strict.close();
  }
});

test('rate limiting: 429 with Retry-After and RateLimit fields', async () => {
  const tiny = await startApi({ rateLimit: { capacity: 3, windowS: 60 } });
  try {
    const statuses = [];
    let last;
    for (let i = 0; i < 4; i++) {
      last = await tiny.call('GET', '/v1/health');
      statuses.push(last.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429]);
    assert.ok(Number(last.headers.get('retry-after')) >= 1);
    assert.match(last.headers.get('ratelimit'), /^"default";r=0;t=\d+$/);
    assert.equal(last.headers.get('ratelimit-policy'), '"default";q=3;w=60');
  } finally {
    await tiny.close();
  }
});

test('static files: served with security headers; traversal is not possible', async () => {
  const index = await api.call('GET', '/', { auth: false });
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
  for (const p of ['/..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/js/..%2f..%2fsrc%2fconfig.js']) {
    const res = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: api.port, path: p }, (r) => {
        r.resume();
        resolve(r.statusCode);
      });
    });
    assert.equal(res, 404, p);
  }
});

test('SSE: check.completed is pushed to subscribers', async () => {
  const { json: m } = await create({ name: 'Streamed' });
  const ac = new AbortController();
  const res = await fetch(`${api.url}/v1/events`, { headers: { accept: 'text/event-stream', authorization: `Bearer ${API_KEY}` }, signal: ac.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body.getReader();
  await api.call('POST', `/v1/monitors/${m.id}/checks`);
  let buf = '';
  while (!buf.includes('event: check.completed')) buf += new TextDecoder().decode((await reader.read()).value);
  ac.abort();
  assert.match(buf, new RegExp(m.id));
});

test('OpenAPI document covers exactly the routes the server implements', () => {
  const toOas = (p) => p.replace(/:(\w+)/g, '{$1}');
  const implemented = api.app.router.list().map((r) => `${r.method} ${toOas(r.pattern)}`).sort();
  const documented = Object.entries(openApiDocument.paths).flatMap(([p, item]) => Object.keys(item).filter((k) => k !== 'parameters').map((k) => `${k.toUpperCase()} ${p}`)).sort();
  assert.deepEqual(implemented, documented);
});

test('API key must be long enough and non-loopback binding requires one', async () => {
  const { assertSafeBinding } = await import('../src/config.js');
  assert.throws(() => assertSafeBinding({ host: '0.0.0.0', apiKey: '' }), /Refusing/);
  assert.throws(() => assertSafeBinding({ host: '127.0.0.1', apiKey: 'short' }), /24 characters/);
  assert.doesNotThrow(() => assertSafeBinding({ host: '0.0.0.0', apiKey: API_KEY }));
});
