// Incident webhooks, signed per the Standard Webhooks scheme
// (https://www.standardwebhooks.com/):
//   webhook-id         stable per incident transition (receivers dedupe on it)
//   webhook-timestamp  unix seconds
//   webhook-signature  "v1," + base64(HMAC-SHA256(key, `${id}.${timestamp}.${body}`))
// where key is the base64-decoded part of a `whsec_...` secret.
//
// Only incident transitions are sent (opened / resolved), never individual
// checks, and never response samples: the payload carries what a human needs
// to act on and nothing a failing third-party server put in its body.
//
// The URL and secret come from the environment only. A Slack or Discord
// webhook URL is itself a credential (the token is in the path), so it is
// never stored in the database, returned by the API or published.
import http from 'node:http';
import https from 'node:https';
import { createHash, createHmac } from 'node:crypto';
import { guardedLookup, isBlockedAddress, isIpLiteral } from './ssrf.js';
import { USER_AGENT } from './checker.js';

export const NOTIFY_EVENTS = new Set(['incident.opened', 'incident.resolved']);
const RETRY_DELAYS_MS = [0, 5000, 30000, 120000];

export function parseWebhookConfig(env = process.env, { allowPrivate = false } = {}) {
  const url = env.AHM_WEBHOOK_URL || '';
  if (!url) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('AHM_WEBHOOK_URL is not a valid URL.');
  }
  if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) throw new Error('AHM_WEBHOOK_URL must use https.');
  const secret = env.AHM_WEBHOOK_SECRET || '';
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret) || Buffer.from(secret.slice(6), 'base64').length < 24) {
    throw new Error('AHM_WEBHOOK_SECRET must be whsec_ followed by at least 24 base64-encoded random bytes (e.g. "whsec_" + `openssl rand -base64 32`).');
  }
  const format = env.AHM_WEBHOOK_FORMAT || 'json';
  if (!['json', 'slack', 'discord'].includes(format)) throw new Error('AHM_WEBHOOK_FORMAT must be json, slack or discord.');
  const hosts = (env.AHM_WEBHOOK_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (hosts.length && !hosts.includes(u.hostname.toLowerCase())) throw new Error(`AHM_WEBHOOK_URL host is not in AHM_WEBHOOK_HOSTS.`);
  return { url: u, key: Buffer.from(secret.slice(6), 'base64'), format, allowPrivate };
}

// Deterministic per transition, so a re-delivered event (retry, re-run of a
// pipeline) carries the same id and receivers can drop the duplicate.
export const eventId = (type, incidentId) => `evt_${createHash('sha256').update(`${type}:${incidentId}`).digest('hex').slice(0, 26)}`;

export function sign(key, id, timestamp, body) {
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

// The cause can contain up to 120 characters chosen by the failing server.
// In chat it goes inside a code span, so masked links ([text](url)), bare
// URLs and * _ ~ formatting render as inert text.
const codeSpan = (s) => '`' + String(s).replace(/`/g, "'").replace(/[\r\n]+/g, ' ') + '`';
function summaryLine(type, i) {
  return type === 'incident.opened'
    ? `🔴 ${i.monitor_name} is down: ${codeSpan(i.cause)} (${i.failed_checks} consecutive failed checks)`
    : `🟢 ${i.monitor_name} recovered after ${i.duration_s != null ? `${Math.round(i.duration_s / 60)} min` : 'an unknown duration'}`;
}

export function buildPayload(format, { type, data: incident }, { now = new Date(), siteUrl } = {}) {
  const i = incident;
  const id = eventId(type, i.id);
  const link = siteUrl ? `${siteUrl.replace(/\/$/, '')}/#/monitors/${i.monitor_id}` : null;
  // Slack: escape &, < and > so a cause string taken from a failing server
  // cannot inject mentions (<!channel>) or links.
  const slackEsc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (format === 'slack') return { id, body: { text: `${slackEsc(summaryLine(type, i))}${link ? `\n<${link}|Open monitor>` : ''}` } };
  // Discord: plain content, mentions disabled so a cause string cannot ping anyone.
  if (format === 'discord') return { id, body: { content: `${summaryLine(type, i)}${link ? `\n${link}` : ''}`, allowed_mentions: { parse: [] } } };
  return {
    id,
    body: {
      id,
      type,
      created_at: now.toISOString(),
      data: {
        incident: {
          id: i.id,
          monitor_id: i.monitor_id,
          monitor_name: i.monitor_name,
          state: i.state,
          opened_at: i.opened_at,
          resolved_at: i.resolved_at,
          duration_s: i.duration_s,
          failed_checks: i.failed_checks,
          cause: i.cause,
        },
        ...(link ? { links: { monitor: link } } : {}),
      },
    },
  };
}

function post(cfg, text, headers, timeoutMs) {
  return new Promise((resolve) => {
    const host = cfg.url.hostname.replace(/^\[|\]$/g, '');
    if (!cfg.allowPrivate && isIpLiteral(host) && isBlockedAddress(host).blocked) return resolve({ error: 'blocked_target' });
    const mod = cfg.url.protocol === 'https:' ? https : http;
    // Fresh single-socket agent, destroyed after the response (same pattern
    // as checker.js; "Connection: close" requests were reset on Windows).
    const agent = new mod.Agent({ keepAlive: true, maxSockets: 1, lookup: guardedLookup({ allowPrivate: cfg.allowPrivate }) });
    const req = mod.request(cfg.url, { method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'user-agent': USER_AGENT, ...headers } });
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
    req.on('response', (res) => {
      res.resume(); // receivers' bodies are not needed and not stored
      res.on('end', () => {
        clearTimeout(timer);
        agent.destroy();
        resolve({ status: res.statusCode, retryAfter: Number(res.headers['retry-after']) || 0 });
      });
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      agent.destroy();
      resolve({ error: err.code === 'EBLOCKEDTARGET' ? 'blocked_target' : err.message });
    });
    req.end(text);
  });
}

// Delivers one event with bounded retries. Retries on network errors, 408,
// 429 and 5xx; gives up immediately on other 4xx (a misconfigured receiver
// will not fix itself). Never throws.
export async function deliver(cfg, event, { siteUrl, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), delays = RETRY_DELAYS_MS, timeoutMs = 10000, log = () => {} } = {}) {
  const { id, body } = buildPayload(cfg.format, event, { siteUrl });
  const text = JSON.stringify(body);
  let retryAfterMs = 0;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    // Honor the receiver's Retry-After (capped at 60 s) when it asks for more
    // than the default backoff.
    const wait = Math.max(delays[attempt], attempt ? retryAfterMs : 0);
    if (wait) await sleep(wait);
    const ts = Math.floor(Date.now() / 1000);
    const r = await post(cfg, text, { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': sign(cfg.key, id, ts, text) }, timeoutMs);
    if (r.status >= 200 && r.status < 300) {
      log({ msg: 'webhook delivered', event: event.type, webhook_id: id, attempt: attempt + 1 });
      return { ok: true, id, attempts: attempt + 1 };
    }
    const retryable = r.error ? r.error !== 'blocked_target' : r.status === 408 || r.status === 429 || r.status >= 500;
    log({ level: 'warn', msg: 'webhook attempt failed', event: event.type, webhook_id: id, attempt: attempt + 1, status: r.status ?? null, error: r.error ?? null, retryable });
    if (!retryable) return { ok: false, id, attempts: attempt + 1, status: r.status, error: r.error };
    retryAfterMs = Math.min(60000, (r.retryAfter || 0) * 1000);
  }
  return { ok: false, id, attempts: delays.length };
}

// Subscribes a running scheduler to the webhook. Deliveries run outside the
// check transaction and never block or fail a check.
// Bounded: a dead receiver during a mass outage must not grow memory without
// limit; beyond the cap, events are logged and dropped.
export const MAX_PENDING = 100;
export function attachNotifier(scheduler, cfg, opts = {}) {
  const pending = new Set();
  const log = opts.log || (() => {});
  scheduler.on('event', (e) => {
    if (!NOTIFY_EVENTS.has(e.type)) return;
    if (pending.size >= MAX_PENDING) {
      log({ level: 'warn', msg: 'webhook queue full; event dropped', event: e.type, incident: e.data?.id });
      return;
    }
    const p = deliver(cfg, e, opts).finally(() => pending.delete(p));
    pending.add(p);
  });
  return { pending };
}
