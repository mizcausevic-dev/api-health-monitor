// API client. In live mode it talks to /v1 with full HTTP semantics
// (ETag/If-Match, Idempotency-Key, problem+json). In static mode (the
// GitHub Pages snapshot) it reads pre-rendered responses from disk.
import { staticPathFor } from './static-path.js';

export const STATIC = document.querySelector('meta[name="ahm-mode"]')?.content === 'static';

export class ApiError extends Error {
  constructor(status, problem) {
    super(problem?.detail || problem?.title || `HTTP ${status}`);
    this.status = status;
    this.problem = problem || {};
  }
}

const KEY = 'ahm.apiKey';
const getKey = () => {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
};
const setKey = (v) => {
  try {
    if (v) sessionStorage.setItem(KEY, v);
    else sessionStorage.removeItem(KEY);
  } catch { /* storage blocked */ }
};

async function parse(res) {
  if (res.status === 204) return null;
  const type = res.headers.get('content-type') || '';
  const body = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, typeof body === 'object' ? body : { detail: body });
  return body;
}

export async function get(path, retried = false) {
  const url = STATIC ? staticPathFor(path) : path;
  const headers = { Accept: 'application/json' };
  const key = STATIC ? null : getKey();
  if (key) headers.Authorization = `Bearer ${key}`;
  // cache: 'no-cache' revalidates with If-None-Match, so unchanged
  // resources come back as 304 and the browser reuses its copy.
  const res = await fetch(url, { cache: 'no-cache', headers });
  if (STATIC && res.status === 404) throw new ApiError(404, { title: 'Not in snapshot', detail: 'This view is not part of the static snapshot.' });
  if (res.status === 401 && !STATIC && !retried) {
    const entered = window.prompt('This server requires an API key. Enter AHM_API_KEY (kept for this tab only):');
    if (entered) {
      setKey(entered.trim());
      return get(path, true);
    }
  }
  const data = await parse(res);
  return { data, etag: res.headers.get('etag') };
}

export async function send(method, path, body, { etag, idempotencyKey, contentType = 'application/json' } = {}, retried = false) {
  const headers = { Accept: 'application/json' };
  const key = getKey();
  if (key) headers.Authorization = `Bearer ${key}`;
  if (body !== undefined) headers['Content-Type'] = contentType;
  if (etag) headers['If-Match'] = etag;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401 && !retried) {
    const entered = window.prompt('This server requires an API key for changes. Enter AHM_API_KEY (kept for this tab only):');
    if (entered) {
      setKey(entered.trim());
      return send(method, path, body, { etag, idempotencyKey, contentType }, true);
    }
  }
  if (res.status === 401) setKey(null);
  const data = await parse(res);
  return { data, etag: res.headers.get('etag'), status: res.status, replayed: res.headers.get('idempotent-replayed') === 'true' };
}

export function subscribe(onEvent) {
  if (STATIC || !('EventSource' in window)) return () => {};
  const es = new EventSource('/v1/events');
  // EventSource cannot send an Authorization header, so when reads require
  // the key the stream is refused (readyState CLOSED). Fall back to polling.
  let poll = 0;
  es.addEventListener('error', () => {
    if (es.readyState === EventSource.CLOSED && !poll) poll = setInterval(() => onEvent('poll', null), 60000);
  });
  for (const type of ['check.completed', 'incident.opened', 'incident.resolved', 'monitor.created', 'monitor.updated', 'monitor.deleted']) {
    es.addEventListener(type, (e) => onEvent(type, JSON.parse(e.data)));
  }
  return () => es.close();
}
