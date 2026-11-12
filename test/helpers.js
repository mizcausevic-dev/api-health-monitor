import http from 'node:http';
import { openDb } from '../src/db/index.js';
import { startServer } from '../src/server.js';

// Low-entropy on purpose: a test fixture, not a credential.
export const API_KEY = 'k'.repeat(32);

// A local HTTP target with predictable behaviour for check tests.
export async function startTarget() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    switch (url.pathname) {
      case '/ok':
        res.writeHead(200, { 'content-type': 'application/json', 'x-trace': 'abc' });
        return res.end(JSON.stringify({ status: { indicator: 'none' }, items: [{ id: 7 }] }));
      case '/slow':
        return setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('slow but fine');
        }, Number(url.searchParams.get('ms') || 300));
      case '/fail':
        res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '30' });
        return res.end('{"error":"maintenance"}');
      case '/echo':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ headers: req.headers }));
      case '/to':
        res.writeHead(Number(url.searchParams.get('code') || 302), { location: url.searchParams.get('u') });
        return res.end();
      case '/redirect':
        res.writeHead(302, { location: '/ok' });
        return res.end();
      case '/big':
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('x'.repeat(400 * 1024));
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

export async function startApi(overrides = {}, opts = {}) {
  const db = openDb(':memory:');
  const s = await startServer(
    { port: 0, apiKey: API_KEY, logRequests: false, allowPrivateTargets: true, scheduler: true, ...overrides },
    { db, ...opts },
  );
  // Keep tests deterministic: no background ticks firing checks.
  clearInterval(s.scheduler?.timer);
  const call = async (method, path, { body, headers = {}, auth = true, raw } = {}) => {
    const h = { ...headers };
    if (auth) h.authorization = `Bearer ${API_KEY}`;
    if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
    const res = await fetch(s.url + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch { /* not json */ }
    return { status: res.status, headers: res.headers, json, text };
  };
  return { ...s, db, call };
}

export const monitorBody = (url, extra = {}) => ({ name: 'Test monitor', url, interval_s: 60, timeout_ms: 2000, ...extra });
