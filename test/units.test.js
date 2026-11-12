import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedAddress, guardedLookup } from '../src/engine/ssrf.js';
import { evaluateAssertions, classify, getPath } from '../src/engine/assertions.js';
import { percentile, summarize, series, histogram } from '../src/engine/stats.js';
import { validateMonitor, mergePatch, redactHeaders, restoreRedacted, REDACTED } from '../src/api/validate.js';
import { RateLimiter } from '../src/http/ratelimit.js';
import { Router } from '../src/http/router.js';
import { noneMatch } from '../src/http/app.js';
import { ulid, ID_PATTERN, newId } from '../src/ids.js';
import { staticPathFor } from '../public/js/static-path.js';

test('SSRF: blocks private, loopback, metadata and IPv6 embeddings; allows public', () => {
  const blocked = ['127.0.0.1', '10.1.2.3', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe', '2002:7f00:1::', 'fe80::1%eth0', '168.63.129.16', 'fec0::1', '64:ff9b:1::a00:1', '::ffff:0:7f00:1'];
  for (const a of blocked) assert.equal(isBlockedAddress(a).blocked, true, `${a} should be blocked`);
  const allowed = ['8.8.8.8', '1.1.1.1', '151.101.1.69', '2606:4700::6810:84e5', '172.32.0.1', '11.0.0.1'];
  for (const a of allowed) assert.equal(isBlockedAddress(a).blocked, false, `${a} should be allowed`);
  assert.match(isBlockedAddress('169.254.169.254').reason, /metadata/);
});

test('SSRF: lookup fails if ANY resolved record is private (mixed-record trick)', async () => {
  const resolver = (_h, _o, cb) => cb(null, [{ address: '93.184.215.14', family: 4 }, { address: '10.0.0.5', family: 4 }]);
  const err = await new Promise((r) => guardedLookup({ resolver })('evil.test', {}, (e) => r(e)));
  assert.equal(err.code, 'EBLOCKEDTARGET');
  const ok = await new Promise((r) => guardedLookup({ resolver: (_h, _o, cb) => cb(null, [{ address: '93.184.215.14', family: 4 }]) })('fine.test', { all: true }, (e, a) => r([e, a])));
  assert.equal(ok[0], null);
  assert.deepEqual(ok[1], [{ address: '93.184.215.14', family: 4 }]);
  // allowPrivate lets operators monitor their own network deliberately.
  const allowed = await new Promise((r) => guardedLookup({ allowPrivate: true, resolver })('evil.test', {}, (e, a) => r([e, a])));
  assert.equal(allowed[0], null);
});

test('assertions: operators, JSON paths, prototype keys and classification', () => {
  const ctx = { status_code: 200, total_ms: 420, headers: { 'content-type': 'application/json' }, bodyText: '{"a":{"b":[1,{"c":"x"}]},"n":5}', truncated: false };
  assert.deepEqual(evaluateAssertions([
    { source: 'status', op: 'in', target: [200, 204] },
    { source: 'json', property: 'a.b[1].c', op: 'eq', target: 'x' },
    { source: 'json', property: 'n', op: 'gte', target: 5 },
    { source: 'header', property: 'Content-Type', op: 'contains', target: 'json' },
    { source: 'json', property: 'missing', op: 'not_exists' },
    { source: 'body', op: 'contains', target: '"n":5' },
  ], ctx), []);
  const f = evaluateAssertions([{ source: 'latency_ms', op: 'lt', target: 300 }], ctx);
  assert.equal(f.length, 1);
  assert.match(f[0].message, /expected latency_ms lt 300, got 420/);
  assert.equal(classify(null, f), 'degraded');
  assert.equal(classify(null, evaluateAssertions([{ source: 'status', op: 'eq', target: 201 }], ctx)), 'down');
  assert.equal(classify({ code: 'timeout' }, []), 'down');
  assert.equal(getPath({ a: 1 }, '__proto__.polluted').found, false);
  assert.equal(getPath({}, 'constructor').found, false);
  // Default assertion is "status < 400".
  assert.equal(evaluateAssertions([], { ...ctx, status_code: 404 }).length, 1);
  // Truncated bodies are never parsed as JSON.
  assert.match(evaluateAssertions([{ source: 'json', property: 'n', op: 'exists' }], { ...ctx, truncated: true })[0].message, /capture limit/);
});

test('stats: nearest-rank percentiles, error budget, bucketing', () => {
  const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(sorted, 50), 50);
  assert.equal(percentile(sorted, 95), 100);
  assert.equal(percentile([], 50), null);
  const now = Date.parse('2026-01-01T01:00:00Z');
  const rows = Array.from({ length: 100 }, (_, i) => ({
    started_at: new Date(now - 3600e3 + i * 36e3).toISOString(),
    outcome: i < 2 ? 'down' : 'up',
    status_code: i < 2 ? null : 200,
    duration_ms: i < 2 ? 10000 : 100 + i,
    error_code: i < 2 ? 'timeout' : null,
  }));
  const s = summarize(rows, { apdexT: 150, sloTarget: 0.99 });
  assert.equal(s.availability, 0.98);
  assert.equal(s.error_budget.allowed_failures, 1);
  assert.equal(s.error_budget.remaining, -1); // 2 failures vs 1 allowed: budget overspent
  assert.equal(s.latency_ms.min, 102); // transport failures excluded from latency
  const b = series(rows, { from: now - 3600e3, to: now, buckets: 4 });
  assert.equal(b.length, 4);
  assert.equal(b.reduce((a, x) => a + x.checks, 0), 100);
  assert.equal(b[0].failures, 2);
  assert.equal(histogram(rows).reduce((a, x) => a + x.count, 0), 98);
});

test('validation: strict fields, pointers, private targets, header injection', () => {
  const { errors } = validateMonitor({ name: '', url: 'ftp://x', interval: 60, id: 'mon_x', headers: { 'X-A': 'ok\r\nInjected: 1', Host: 'x' }, assertions: [{ source: 'status', op: 'contains', target: 1 }] });
  const pointers = errors.map((e) => e.pointer).sort();
  assert.deepEqual(pointers, ['/assertions/0/op', '/headers/Host', '/headers/X-A', '/id', '/interval', '/name', '/url'].sort());
  assert.ok(validateMonitor({ name: 'x', url: 'http://169.254.169.254/latest/meta-data' }).errors);
  assert.ok(validateMonitor({ name: 'x', url: 'http://[::ffff:127.0.0.1]/' }).errors);
  assert.ok(validateMonitor({ name: 'x', url: 'http://localhost:8080/' }).errors);
  assert.ok(validateMonitor({ name: 'x', url: 'https://user:pw@example.com/' }).errors);
  assert.equal(validateMonitor({ name: 'x', url: 'http://127.0.0.1/' }, { allowPrivateTargets: true }).errors, undefined);
  assert.ok(validateMonitor({ name: 'x', url: 'https://a.example', timeout_ms: 60000, interval_s: 30 }).errors);
  const ok = validateMonitor({ name: ' Trim me ', url: 'https://api.example.com/health', tags: ['a', 'a'] });
  assert.equal(ok.value.name, 'Trim me');
  assert.deepEqual(ok.value.tags, ['a']);
  assert.equal(ok.value.interval_s, 60);
});

test('merge patch (RFC 7396) and secret redaction round-trip', () => {
  assert.deepEqual(mergePatch({ a: 1, h: { x: '1', y: '2' }, arr: [1, 2] }, { a: null, h: { y: null, z: '3' }, arr: [9] }), { h: { x: '1', z: '3' }, arr: [9] });
  const stored = { Authorization: 'Bearer real', Accept: 'application/json', 'Ocp-Apim-Subscription-Key': 'k' };
  const shown = redactHeaders(stored);
  assert.deepEqual(shown, { Authorization: REDACTED, Accept: 'application/json', 'Ocp-Apim-Subscription-Key': REDACTED }, 'allowlist: unknown headers are redacted');
  assert.deepEqual(restoreRedacted({ ...shown, Accept: 'text/plain' }, stored), { Authorization: 'Bearer real', Accept: 'text/plain', 'Ocp-Apim-Subscription-Key': 'k' });
});

test('rate limiter: token bucket refills and reports draft headers', () => {
  let now = 0;
  const rl = new RateLimiter({ capacity: 3, windowS: 3 }, () => now);
  assert.equal(rl.take('a').allowed, true);
  rl.take('a');
  const third = rl.take('a');
  assert.equal(third.headers.RateLimit, '"default";r=0;t=3');
  assert.equal(third.headers['RateLimit-Policy'], '"default";q=3;w=3');
  const denied = rl.take('a');
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterS, 1);
  now = 1000;
  assert.equal(rl.take('a').allowed, true);
  assert.equal(rl.take('b').allowed, true, 'buckets are per key');
});

test('router: 404 vs 405, HEAD falls back to GET', () => {
  const r = new Router().add('GET', '/v1/x/:id', () => 'get').add('PATCH', '/v1/x/:id', () => 'patch');
  assert.equal(r.match('GET', '/v1/y'), null);
  const m = r.match('PUT', '/v1/x/42');
  assert.equal(m.handler, undefined);
  assert.deepEqual(m.allow, ['GET', 'PATCH', 'HEAD', 'OPTIONS']);
  assert.equal(r.match('HEAD', '/v1/x/42').handler(), 'get');
  assert.equal(r.match('GET', '/v1/x/a%2Fb').params.id, 'a/b');
});

test('conditional GET helper and ids', () => {
  assert.equal(noneMatch('"a", W/"b"', '"b"'), true);
  assert.equal(noneMatch('*', '"z"'), true);
  assert.equal(noneMatch('"a"', '"b"'), false);
  assert.match(newId('mon'), ID_PATTERN);
  assert.ok(ulid(1000) < ulid(2000), 'ULIDs sort by time');
});

test('static snapshot path mapping is stable regardless of query order', () => {
  assert.equal(staticPathFor('/v1/monitors'), 'api/v1/monitors.json');
  assert.equal(staticPathFor('/v1/monitors/mon_a/stats?window=24h&buckets=48'), 'api/v1/monitors/mon_a/stats__buckets=48&window=24h.json');
  assert.equal(staticPathFor('/v1/monitors/mon_a/stats?buckets=48&window=24h'), staticPathFor('/v1/monitors/mon_a/stats?window=24h&buckets=48'));
});
