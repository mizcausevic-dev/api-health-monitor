// Records real HTTP exchanges against a throwaway in-memory server so the
// API page shows actual behaviour, not hand-written examples.
// Usage: node scripts/transcripts.js [outFile]
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db/index.js';
import { startServer } from '../src/server.js';

const SHOWN_HEADERS = ['content-type', 'location', 'etag', 'link', 'allow', 'accept-patch', 'retry-after', 'ratelimit', 'ratelimit-policy', 'idempotent-replayed', 'www-authenticate'];
const STATUS_TEXT = { 200: 'OK', 201: 'Created', 204: 'No Content', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 405: 'Method Not Allowed', 412: 'Precondition Failed', 422: 'Unprocessable Content', 428: 'Precondition Required', 429: 'Too Many Requests' };

export async function recordTranscripts() {
  const key = randomBytes(24).toString('base64url');
  const s = await startServer({ port: 0, apiKey: key, logRequests: false, scheduler: false, rateLimit: { capacity: 300, windowS: 60 } }, { db: openDb(':memory:') });
  const out = [];
  const call = async (title, note, method, path, { body, headers = {}, auth = true } = {}) => {
    const h = { accept: 'application/json', ...headers };
    if (body !== undefined) h['content-type'] ??= 'application/json';
    const sent = { ...h };
    if (auth) {
      h.authorization = `Bearer ${key}`;
      sent.authorization = 'Bearer <AHM_API_KEY>';
    }
    const res = await fetch(s.url + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    const shownHeaders = SHOWN_HEADERS.filter((k) => res.headers.has(k)).map((k) => `${k}: ${res.headers.get(k)}`);
    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch { /* empty or non-JSON body */ }
    if (pretty.length > 1800) pretty = `${pretty.slice(0, 1800)}\n… (truncated for display)`;
    out.push({
      title,
      note,
      request: `${method} ${path} HTTP/1.1\n${Object.entries(sent).map(([k, v]) => `${k}: ${v}`).join('\n')}${body === undefined ? '' : `\n\n${JSON.stringify(body, null, 2)}`}`,
      response: { status: res.status, text: `HTTP/1.1 ${res.status} ${STATUS_TEXT[res.status] || ''}\n${shownHeaders.join('\n')}${pretty ? `\n\n${pretty}` : ''}` },
    });
    return { res, json: text ? JSON.parse(text) : null };
  };

  try {
    const body = {
      name: 'Payments API health',
      url: 'https://api.example.com/v2/health',
      interval_s: 60,
      timeout_ms: 5000,
      headers: { Authorization: 'Bearer upstream-token' },
      assertions: [
        { source: 'status', op: 'eq', target: 200 },
        { source: 'json', property: 'status', op: 'eq', target: 'ok' },
        { source: 'latency_ms', op: 'lt', target: 800 },
      ],
      tags: ['payments'],
    };
    const created = await call('Create a monitor', 'Returns 201 with Location and a version ETag. Credential-like header values are never echoed back.', 'POST', '/v1/monitors', { body, headers: { 'idempotency-key': 'b7c1e9e2-create-payments' } });
    const id = created.json.id;
    await call('Retry with the same Idempotency-Key', 'A network retry replays the original response instead of creating a duplicate monitor.', 'POST', '/v1/monitors', { body, headers: { 'idempotency-key': 'b7c1e9e2-create-payments' } });
    await call('Same key, different payload', 'Reusing a key for a different request is a client bug, rejected with 422.', 'POST', '/v1/monitors', { body: { ...body, name: 'Something else' }, headers: { 'idempotency-key': 'b7c1e9e2-create-payments' } });
    await call('Validation errors point at the field', 'RFC 9457 problem details with RFC 6901 JSON Pointers. Unknown fields are rejected, not ignored.', 'POST', '/v1/monitors', { body: { name: '', url: 'ftp://files.example.com', interval: 5, assertions: [{ source: 'latency_ms', op: 'contains', target: 'fast' }] } });
    await call('SSRF: cloud metadata address refused', 'Private, loopback and link-local targets are refused at validation, and again at DNS resolution time for hostnames.', 'POST', '/v1/monitors', { body: { name: 'metadata', url: 'http://169.254.169.254/latest/meta-data/' } });
    const got = await call('Read with an ETag', null, 'GET', `/v1/monitors/${id}`);
    const etag = got.res.headers.get('etag');
    await call('Conditional GET', 'Unchanged resources cost a 304 with no body.', 'GET', `/v1/monitors/${id}`, { headers: { 'if-none-match': etag } });
    await call('PATCH without If-Match', 'Writes must prove they saw the current version (lost-update protection).', 'PATCH', `/v1/monitors/${id}`, { body: { interval_s: 30 }, headers: { 'content-type': 'application/merge-patch+json' } });
    await call('JSON Merge Patch with If-Match', 'Only the changed fields are sent. The ETag moves to the next version.', 'PATCH', `/v1/monitors/${id}`, { body: { interval_s: 30, tags: ['payments', 'tier-1'] }, headers: { 'content-type': 'application/merge-patch+json', 'if-match': etag } });
    await call('Stale ETag', 'A second writer holding the old ETag gets 412 instead of silently overwriting.', 'PATCH', `/v1/monitors/${id}`, { body: { paused: true }, headers: { 'content-type': 'application/merge-patch+json', 'if-match': etag } });
    for (let i = 0; i < 2; i++) await fetch(`${s.url}/v1/monitors`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...body, name: `Edge region ${i + 1}`, headers: {} }) });
    await call('Keyset pagination', 'Opaque cursor, next link in both the body and an RFC 8288 Link header.', 'GET', '/v1/monitors?sort=name&limit=1');
    await call('Unknown query parameter', 'A misspelled filter fails loudly instead of returning unfiltered data with a 200.', 'GET', '/v1/monitors?stauts=down');
    await call('Wrong method', '405 carries the Allow header, distinct from 404 for a missing resource.', 'PUT', `/v1/monitors/${id}`, { body });
    await call('Missing credentials', null, 'DELETE', `/v1/monitors/${id}`, { auth: false });
  } finally {
    await s.close();
  }

  const tiny = await startServer({ port: 0, logRequests: false, scheduler: false, rateLimit: { capacity: 2, windowS: 60 } }, { db: openDb(':memory:') });
  try {
    await fetch(`${tiny.url}/v1/health`);
    await fetch(`${tiny.url}/v1/health`);
    const res = await fetch(`${tiny.url}/v1/health`, { headers: { accept: 'application/json' } });
    const text = await res.text();
    out.push({
      title: 'Rate limited',
      note: 'Token bucket per client. Quota is reported on every response with the IETF RateLimit fields (draft).',
      request: 'GET /v1/health HTTP/1.1\naccept: application/json',
      response: { status: res.status, text: `HTTP/1.1 ${res.status} ${STATUS_TEXT[res.status]}\n${SHOWN_HEADERS.filter((k) => res.headers.has(k)).map((k) => `${k}: ${res.headers.get(k)}`).join('\n')}\n\n${JSON.stringify(JSON.parse(text), null, 2)}` },
    });
  } finally {
    await tiny.close();
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2] || 'public/transcripts.json';
  const t = await recordTranscripts();
  writeFileSync(file, `${JSON.stringify(t, null, 2)}\n`);
  process.stdout.write(`wrote ${t.length} transcripts to ${file}\n`);
}
