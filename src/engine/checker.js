// Executes one HTTP check with a phase-level timing breakdown.
//
// fetch() hides connection phases, so this uses node:http(s) directly and
// listens to socket events: lookup -> connect -> secureConnect -> response
// -> end. Each check gets its own agent, so every check measures a cold
// connection, which is what a new client of the API experiences.
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { guardedLookup, isBlockedAddress, isIpLiteral, BlockedTargetError } from './ssrf.js';
import { evaluateAssertions, classify } from './assertions.js';
import { newId } from '../ids.js';

export const USER_AGENT = 'api-health-monitor/1.0 (+https://github.com/mizcausevic-dev/api-health-monitor)';
const MAX_REDIRECTS = 5;
const SAMPLE_BODY_BYTES = 2048;
const SAMPLE_HEADERS = ['content-type', 'content-length', 'cache-control', 'retry-after', 'server', 'date', 'location', 'x-ratelimit-remaining', 'ratelimit', 'via', 'cf-ray', 'x-request-id'];

const ERROR_CODES = {
  ENOTFOUND: 'dns_failure',
  EAI_AGAIN: 'dns_failure',
  ECONNREFUSED: 'connection_refused',
  ECONNRESET: 'connection_reset',
  EHOSTUNREACH: 'host_unreachable',
  ENETUNREACH: 'host_unreachable',
  EPIPE: 'connection_reset',
  EBLOCKEDTARGET: 'blocked_target',
  ECHECKTIMEOUT: 'timeout',
  ERR_TLS_CERT_ALTNAME_INVALID: 'tls_error',
  CERT_HAS_EXPIRED: 'tls_error',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'tls_error',
  SELF_SIGNED_CERT_IN_CHAIN: 'tls_error',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'tls_error',
  HPE_INVALID_CONSTANT: 'protocol_error',
};

const round = (n) => (n == null ? null : Math.round(n * 10) / 10);

function requestOnce(url, monitor, { allowPrivate, maxBodyBytes, deadline, method, sendBody, sendHeaders = true }) {
  return new Promise((resolve) => {
    const isHttps = url.protocol === 'https:';
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // Node skips the lookup hook for IP literals, so check those here.
    if (!allowPrivate && isIpLiteral(host)) {
      const verdict = isBlockedAddress(host);
      if (verdict.blocked) {
        const e = new BlockedTargetError(host, host, verdict.reason);
        return resolve({ error: e, timings: {} });
      }
    }
    const t = { start: performance.now() };
    const headers = { 'user-agent': USER_AGENT, accept: '*/*', ...(sendHeaders ? monitor.headers : {}) };
    const body = sendBody && monitor.body != null ? Buffer.from(monitor.body) : null;
    if (body) headers['content-length'] = String(body.length);

    // A fresh single-socket agent per check: no pooled connection and no
    // TLS session reuse, so every check pays the full DNS+TCP+TLS cost.
    // (agent:false would do the same but sends "Connection: close", which
    // some servers answer with a reset on Windows.)
    const agent = new (isHttps ? https : http).Agent({ keepAlive: true, maxSockets: 1, lookup: guardedLookup({ allowPrivate }) });
    const req = (isHttps ? https : http).request(url, {
      method,
      headers,
      agent,
      lookup: guardedLookup({ allowPrivate }),
    });

    let settled = false;
    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      agent.destroy();
      resolve(out);
    };
    const timer = setTimeout(() => {
      const e = new Error(`no complete response within ${monitor.timeout_ms} ms`);
      e.code = 'ECHECKTIMEOUT';
      req.destroy(e);
    }, Math.max(1, deadline - Date.now()));

    req.on('socket', (socket) => {
      socket.once('lookup', () => (t.lookup = performance.now()));
      socket.once('connect', () => {
        t.connect = performance.now();
        t.remote = socket.remoteAddress;
      });
      socket.once('secureConnect', () => (t.tls = performance.now()));
    });

    req.on('response', (res) => {
      t.response = performance.now();
      const chunks = [];
      let bytes = 0;
      let captured = 0;
      let truncated = false;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (captured < maxBodyBytes) {
          const take = chunk.subarray(0, maxBodyBytes - captured);
          chunks.push(take);
          captured += take.length;
          if (take.length < chunk.length) truncated = true;
        } else truncated = true;
      });
      res.on('end', () => {
        t.end = performance.now();
        finish({ res, body: Buffer.concat(chunks), bytes, truncated, timings: t });
      });
      res.on('error', (error) => finish({ error, timings: t }));
    });
    req.on('error', (error) => finish({ error, timings: t }));
    req.end(body ?? undefined);
  });
}

function phases(t) {
  const connectedFrom = t.lookup ?? t.start;
  const handshakeDone = t.tls ?? t.connect;
  return {
    dns_ms: round(t.lookup != null ? t.lookup - t.start : 0),
    connect_ms: round(t.connect != null ? t.connect - connectedFrom : null),
    tls_ms: round(t.tls != null && t.connect != null ? t.tls - t.connect : null),
    ttfb_ms: round(t.response != null && handshakeDone != null ? t.response - handshakeDone : null),
    transfer_ms: round(t.end != null && t.response != null ? t.end - t.response : null),
  };
}

// Returns a check record ready for persistence (see db/repo.js insertCheck).
export async function runCheck(monitor, { allowPrivate = false, maxBodyBytes = 256 * 1024, probe = 'local', now = new Date() } = {}) {
  const startedAt = now;
  const t0 = performance.now();
  const deadline = Date.now() + monitor.timeout_ms;
  let url = new URL(monitor.url);
  let method = monitor.method;
  let sendBody = true;
  let sendHeaders = true;
  let redirects = 0;
  let out;

  for (;;) {
    out = await requestOnce(url, monitor, { allowPrivate, maxBodyBytes, deadline, method, sendBody, sendHeaders });
    const status = out.res?.statusCode;
    const location = out.res?.headers.location;
    if (!monitor.follow_redirects || out.error || !location || status < 300 || status > 399 || status === 304) break;
    if (redirects >= MAX_REDIRECTS) {
      out = { error: Object.assign(new Error(`more than ${MAX_REDIRECTS} redirects`), { code: 'ETOOMANYREDIRECTS' }), timings: out.timings };
      break;
    }
    const next = new URL(location, url);
    if (!['http:', 'https:'].includes(next.protocol)) {
      out = { error: Object.assign(new Error(`redirect to unsupported scheme ${next.protocol}`), { code: 'EBADREDIRECT' }), timings: out.timings };
      break;
    }
    if (url.protocol === 'https:' && next.protocol === 'http:') {
      out = { error: Object.assign(new Error('redirect downgrades https to http'), { code: 'EBADREDIRECT' }), timings: out.timings };
      break;
    }
    if ([301, 302, 303].includes(status) && method !== 'HEAD') {
      method = 'GET';
      sendBody = false;
    }
    // Configured headers and body may carry credentials for the original
    // origin. Like browsers and curl, never forward them to another origin.
    if (next.origin !== url.origin) {
      sendHeaders = false;
      sendBody = false;
    }
    url = next;
    redirects += 1;
  }

  const total = performance.now() - t0;
  const headers = out.res?.headers ?? {};
  const bodyText = out.body ? out.body.toString('utf8') : '';
  const error = out.error
    ? { code: ERROR_CODES[out.error.code] || (out.error.code === 'ETOOMANYREDIRECTS' ? 'too_many_redirects' : out.error.code === 'EBADREDIRECT' ? 'bad_redirect' : 'request_failed'), message: String(out.error.message).slice(0, 300) }
    : null;
  const failures = error
    ? []
    : evaluateAssertions(monitor.assertions, { status_code: out.res.statusCode, total_ms: total, headers, bodyText, truncated: out.truncated });
  const outcome = classify(error, failures);

  // Unexpected responses keep a bounded sample for the log; healthy ones
  // keep none, which keeps the table small and avoids storing payloads.
  let response_sample = null;
  if (outcome !== 'up' && out.res) {
    response_sample = {
      headers: Object.fromEntries(SAMPLE_HEADERS.filter((h) => headers[h] !== undefined).map((h) => [h, String(headers[h]).slice(0, 200)])),
      body: bodyText.slice(0, SAMPLE_BODY_BYTES),
      body_truncated: bodyText.length > SAMPLE_BODY_BYTES || out.truncated,
    };
  }

  return {
    id: newId('chk', startedAt.getTime()),
    monitor_id: monitor.id,
    started_at: startedAt.toISOString(),
    outcome,
    status_code: out.res?.statusCode ?? null,
    error,
    timings: { total_ms: round(total), ...phases(out.timings ?? {}) },
    response_bytes: out.res ? out.bytes : null,
    remote_address: out.timings?.remote ?? null,
    redirects,
    probe,
    failed_assertions: failures,
    response_sample,
  };
}
