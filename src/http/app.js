// HTTP pipeline: request id -> security headers -> CORS -> static files or
// API (rate limit -> auth -> content negotiation -> routing -> body parsing
// -> handler -> conditional GET). Handlers return { status, body, headers }
// or throw HttpError; this file turns both into wire responses.
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Router } from './router.js';
import { HttpError, httpError } from './problem.js';
import { RateLimiter } from './ratelimit.js';
import { EventHub } from './events.js';
import { registerRoutes } from '../api/routes.js';

const MAX_BODY = 64 * 1024;
const JSON_TYPE = 'application/json; charset=utf-8';
const PROBLEM_TYPE = 'application/problem+json; charset=utf-8';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    // style-src-attr allows style="" attributes (chart geometry and colors)
    // but not <style> elements or inline event handlers; scripts stay 'self'.
    "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function drain(req) {
  return new Promise((resolve) => {
    let seen = 0;
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 2000);
    req.on('data', (c) => {
      seen += c.length;
      if (seen > MAX_BODY) {
        req.pause();
        done();
      }
    });
    req.on('end', done);
    req.on('error', done);
    req.resume();
  });
}

export const etagOf =(text) => `"${createHash('sha256').update(text).digest('base64url').slice(0, 27)}"`;

// RFC 9110 If-None-Match: comma-separated list, weak comparison, "*".
export function noneMatch(header, etag) {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const bare = etag.replace(/^W\//, '');
  return header.split(',').some((t) => t.trim().replace(/^W\//, '') === bare);
}

const sha256 = (s) => createHash('sha256').update(s).digest();

function acceptsJson(accept) {
  if (!accept) return true;
  return accept.split(',').some((part) => {
    const [type, ...params] = part.trim().split(';');
    if (params.some((p) => /^\s*q=0(\.0*)?\s*$/.test(p))) return false;
    return ['*/*', 'application/*', 'application/json', 'application/problem+json'].includes(type.trim().toLowerCase());
  });
}

export function createApp({ db, config, scheduler = null, publicDir = null, clock = () => Date.now() }) {
  const router = new Router();
  const events = new EventHub();
  const limiter = new RateLimiter(config.rateLimit, clock);
  const keyDigest = config.apiKey ? sha256(config.apiKey) : null;
  scheduler?.on('event', (e) => events.publish(e));
  registerRoutes(router, { db, config, scheduler, events, clock });
  const publicRoot = publicDir ? resolve(publicDir) : null;

  function clientIp(req) {
    if (config.trustProxy) {
      // Rightmost entry: the one our own proxy appended. Leftmost entries
      // are client-supplied and would let anyone mint fresh rate buckets.
      const fwd = req.headers['x-forwarded-for'];
      if (fwd) return fwd.split(',').at(-1).trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function authenticate(req) {
    const header = req.headers.authorization || '';
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    if (!keyDigest) return { principal: 'local', authenticated: true };
    // Compare digests so the comparison is constant-time regardless of the
    // presented key's length.
    if (m && timingSafeEqual(sha256(m[1]), keyDigest)) return { principal: 'api-key', authenticated: true };
    return { principal: `ip:${clientIp(req)}`, authenticated: false };
  }

  function applyCors(req, res) {
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Expose-Headers', 'ETag, Location, Link, RateLimit, RateLimit-Policy, Retry-After, X-Request-Id, Idempotent-Replayed');
      res.setHeader('Vary', 'Origin');
      return true;
    }
    return false;
  }

  function send(req, res, status, body, headers = {}) {
    for (const [k, v] of Object.entries(headers)) if (v != null) res.setHeader(k, v);
    if (body === undefined || status === 204 || status === 304) {
      res.writeHead(status);
      return res.end();
    }
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', JSON_TYPE);
    res.setHeader('Content-Length', Buffer.byteLength(text));
    res.writeHead(status);
    res.end(req.method === 'HEAD' ? undefined : text);
  }

  function sendProblem(req, res, err, requestId, path) {
    const e = err instanceof HttpError ? err : httpError('internal-error', 'An unexpected error occurred.');
    send(req, res, e.status, JSON.stringify(e.toProblem(path, requestId)), { 'Content-Type': PROBLEM_TYPE, ...e.headers });
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw httpError('payload-too-large', `Body exceeds ${MAX_BODY} bytes.`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  // Keyless mode trusts everything on loopback. A DNS-rebinding page would
  // reach us under its own hostname, so only loopback Host values pass.
  function hostAllowed(req) {
    if (keyDigest) return true;
    const host = String(req.headers.host || '').toLowerCase();
    const port = req.socket.localPort;
    return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host);
  }

  async function serveStatic(req, res, path) {
    if (!publicRoot || !['GET', 'HEAD'].includes(req.method)) return false;
    let decoded;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      throw httpError('bad-request', 'Malformed percent-encoding in path.');
    }
    const rel = path === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    const file = resolve(join(publicRoot, normalize(rel)));
    if (file !== publicRoot && !file.startsWith(publicRoot + sep)) return false; // traversal
    let info;
    try {
      info = await stat(file);
    } catch {
      return false;
    }
    if (!info.isFile()) return false;
    const etag = `"${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-cache');
    if (noneMatch(req.headers['if-none-match'], etag)) {
      res.writeHead(304);
      res.end();
      return true;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Content-Length': info.size });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
    return true;
  }

  async function handle(req, res) {
    const started = process.hrtime.bigint();
    const incoming = req.headers['x-request-id'];
    const requestId = typeof incoming === 'string' && /^[\w.-]{1,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', requestId);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    let url;
    try {
      url = new URL(req.url, 'http://local');
    } catch {
      return sendProblem(req, res, httpError('bad-request', 'Malformed request target.'), requestId, '/');
    }
    const path = url.pathname;
    res.on('finish', () => {
      if (!config.logRequests) return;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      process.stdout.write(`${JSON.stringify({ level: 'info', msg: 'request', request_id: requestId, method: req.method, path, status: res.statusCode, ms: Math.round(ms * 10) / 10 })}\n`);
    });

    try {
      if (!hostAllowed(req)) throw httpError('bad-request', 'Unexpected Host header. Without AHM_API_KEY the server only answers to 127.0.0.1, localhost or [::1].');
      const cors = applyCors(req, res);
      if (!path.startsWith('/v1')) {
        if (await serveStatic(req, res, path)) return;
        throw httpError('not-found', `No resource at ${path}.`);
      }

      const auth = authenticate(req);
      // Representations differ for anonymous and authenticated readers.
      res.setHeader('Vary', cors ? 'Origin, Authorization' : 'Authorization');
      const rl = limiter.take(auth.principal, 1);
      for (const [k, v] of Object.entries(rl.headers)) res.setHeader(k, v);
      if (!rl.allowed) throw httpError('rate-limited', 'Request quota exhausted.', { headers: { 'Retry-After': String(rl.retryAfterS) } });

      const match = router.match(req.method, path);
      if (!match) throw httpError('not-found', `No resource at ${path}.`);

      if (req.method === 'OPTIONS') {
        const h = { Allow: match.allow.join(', ') };
        if (cors) {
          h['Access-Control-Allow-Methods'] = match.allow.join(', ');
          h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type, If-Match, If-None-Match, Idempotency-Key, Last-Event-ID, X-Request-Id';
          h['Access-Control-Max-Age'] = '600';
        }
        return send(req, res, 204, undefined, h);
      }
      if (!match.handler) {
        throw httpError('method-not-allowed', `${req.method} is not supported on ${path}.`, {
          headers: { Allow: match.allow.join(', ') },
          extensions: { allowed_methods: match.allow },
        });
      }

      const unsafe = !['GET', 'HEAD'].includes(req.method);
      if ((unsafe || !config.publicRead || match.meta.private) && !auth.authenticated && !match.meta.public) {
        throw httpError('unauthorized', 'A valid API key is required for this request.', {
          headers: { 'WWW-Authenticate': 'Bearer realm="api-health-monitor"' },
        });
      }

      if (match.meta.cost > 1) {
        const extra = limiter.take(auth.principal, match.meta.cost - 1);
        for (const [k, v] of Object.entries(extra.headers)) res.setHeader(k, v);
        if (!extra.allowed) throw httpError('rate-limited', 'This operation costs more quota than remains.', { headers: { 'Retry-After': String(extra.retryAfterS) } });
      }

      if (match.meta.stream) {
        if (!(req.headers.accept || '').includes('text/event-stream') && !acceptsJson(req.headers.accept)) throw httpError('not-acceptable');
      } else if (!acceptsJson(req.headers.accept)) {
        throw httpError('not-acceptable', 'This API produces application/json.');
      }

      let body;
      if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
        const raw = await readBody(req);
        const ctype = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (raw.length || match.meta.bodyRequired) {
          const accepted = match.meta.contentTypes || ['application/json'];
          if (!accepted.includes(ctype)) throw httpError('unsupported-media-type', `Expected ${accepted.join(' or ')}.`, { headers: { [req.method === 'PATCH' ? 'Accept-Patch' : 'Accept-Post']: accepted.join(', ') } });
          try {
            body = JSON.parse(raw);
          } catch {
            throw httpError('bad-request', 'Body is not valid JSON.');
          }
        }
      }

      const ctx = { req, res, url, path, params: match.params, query: url.searchParams, body, auth, requestId, method: req.method };
      const result = await match.handler(ctx);
      if (result?.streaming) return; // handler owns the response (SSE)

      const status = result.status ?? 200;
      const headers = { 'Cache-Control': 'no-cache', ...result.headers };
      if (result.body !== undefined && status === 200 && ['GET', 'HEAD'].includes(req.method)) {
        const text = JSON.stringify(result.body);
        headers.ETag ??= etagOf(text);
        if (noneMatch(req.headers['if-none-match'], headers.ETag)) return send(req, res, 304, undefined, headers);
        return send(req, res, status, text, headers);
      }
      return send(req, res, status, result.body, headers);
    } catch (err) {
      if (!(err instanceof HttpError)) {
        process.stderr.write(`${JSON.stringify({ level: 'error', msg: 'unhandled', request_id: requestId, error: err.stack })}\n`);
      }
      if (res.headersSent) return res.destroy();
      // Rejected before the body was read (401, 405, 429...): consume the
      // body first. Answering with unread bytes in the socket buffer makes
      // the kernel send a reset, and the client sees ECONNRESET instead of
      // our problem response. Bounded by the same 64 KiB / 2 s limits.
      if (!req.readableEnded) await drain(req);
      return sendProblem(req, res, err, requestId, path);
    }
  }

  return { handle, router, events, limiter };
}
