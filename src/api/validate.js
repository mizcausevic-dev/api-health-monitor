// Monitor schema validation. Strict by design: unknown fields are rejected
// rather than silently dropped, so a typo like "interval" surfaces as a 422
// instead of a monitor quietly running on the default schedule.
import { isBlockedAddress, isIpLiteral } from '../engine/ssrf.js';

export const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
export const SOURCES = ['status', 'latency_ms', 'header', 'body', 'json'];
export const OPS = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'contains', 'not_contains', 'in', 'exists', 'not_exists'];
const NUMERIC_OPS = new Set(['lt', 'lte', 'gt', 'gte']);
const OPS_BY_SOURCE = {
  status: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in'],
  latency_ms: ['lt', 'lte'],
  header: ['eq', 'neq', 'contains', 'not_contains', 'exists', 'not_exists'],
  body: ['contains', 'not_contains'],
  json: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'contains', 'in', 'exists', 'not_exists'],
};
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer', 'keep-alive', 'proxy-authorization']);
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const TAG = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const DEFAULTS = {
  method: 'GET',
  headers: {},
  body: null,
  interval_s: 60,
  timeout_ms: 10000,
  follow_redirects: false,
  assertions: [],
  failure_threshold: 2,
  slo_target: 0.999,
  tags: [],
  paused: false,
  capture: 'sample',
};
export const CAPTURE = ['sample', 'status_only', 'none'];

const FIELDS = new Set(['name', 'url', ...Object.keys(DEFAULTS)]);
export const READ_ONLY = new Set(['id', 'version', 'created_at', 'updated_at', 'state', 'links', 'last_status', 'last_checked_at', 'consecutive_failures']);

const isInt = (v) => Number.isInteger(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function validateMonitor(input, { allowPrivateTargets = false } = {}) {
  const errors = [];
  const err = (pointer, detail) => errors.push({ pointer, detail });
  if (!isObj(input)) return { errors: [{ pointer: '', detail: 'Body must be a JSON object.' }] };

  for (const key of Object.keys(input)) {
    if (READ_ONLY.has(key)) err(`/${key}`, 'Read-only field; the server sets it.');
    else if (!FIELDS.has(key)) err(`/${key}`, 'Unknown field.');
  }
  const v = { ...DEFAULTS, ...input };

  if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 120) err('/name', 'Required string, 1-120 characters.');

  if (typeof v.url !== 'string' || v.url.length > 2048) err('/url', 'Required string, at most 2048 characters.');
  else {
    let u;
    try {
      u = new URL(v.url);
    } catch {
      err('/url', 'Not a valid absolute URL.');
    }
    if (u) {
      if (!['http:', 'https:'].includes(u.protocol)) err('/url', 'Only http and https URLs can be monitored.');
      if (u.username || u.password) err('/url', 'Credentials in the URL are not allowed; use an Authorization header.');
      const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
      if (!allowPrivateTargets && isIpLiteral(host) && isBlockedAddress(host).blocked) {
        err('/url', 'Target resolves to a private, loopback or reserved address.');
      }
      if (!allowPrivateTargets && /^(localhost|.*\.localhost|.*\.internal|.*\.local)$/i.test(host)) {
        err('/url', 'Target hostname is reserved for internal use.');
      }
    }
  }

  if (!METHODS.includes(v.method)) err('/method', `One of ${METHODS.join(', ')}.`);

  if (!isObj(v.headers)) err('/headers', 'Object of header name to string value.');
  else {
    const entries = Object.entries(v.headers);
    if (entries.length > 20) err('/headers', 'At most 20 headers.');
    for (const [name, value] of entries) {
      const ptr = `/headers/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (!TOKEN.test(name)) err(ptr, 'Invalid header name.');
      else if (FORBIDDEN_HEADERS.has(name.toLowerCase())) err(ptr, 'This header is managed by the HTTP client.');
      if (typeof value !== 'string' || value.length > 1024 || /[\r\n\0]/.test(value)) err(ptr, 'String up to 1024 characters, no control characters.');
    }
  }

  if (v.body !== null) {
    if (typeof v.body !== 'string' || v.body.length > 16384) err('/body', 'String up to 16384 characters, or null.');
    else if (['GET', 'HEAD'].includes(v.method)) err('/body', `A ${v.method} request cannot carry a body.`);
  }

  const intervalOk = isInt(v.interval_s) && v.interval_s >= 30 && v.interval_s <= 86400;
  if (!intervalOk) err('/interval_s', 'Integer between 30 and 86400 seconds.');
  if (!isInt(v.timeout_ms) || v.timeout_ms < 100 || v.timeout_ms > 30000) err('/timeout_ms', 'Integer between 100 and 30000 ms.');
  else if (intervalOk && v.timeout_ms >= v.interval_s * 1000) err('/timeout_ms', 'Must be shorter than the check interval.');
  if (typeof v.follow_redirects !== 'boolean') err('/follow_redirects', 'Boolean.');
  if (!isInt(v.failure_threshold) || v.failure_threshold < 1 || v.failure_threshold > 10) err('/failure_threshold', 'Integer between 1 and 10.');
  if (typeof v.slo_target !== 'number' || !(v.slo_target >= 0.5 && v.slo_target <= 0.99999)) err('/slo_target', 'Number between 0.5 and 0.99999.');
  if (typeof v.paused !== 'boolean') err('/paused', 'Boolean.');
  if (!CAPTURE.includes(v.capture)) err('/capture', `One of ${CAPTURE.join(', ')}.`);

  if (!Array.isArray(v.tags) || v.tags.length > 10) err('/tags', 'Array of at most 10 tags.');
  else v.tags.forEach((t, i) => typeof t === 'string' && TAG.test(t) ? null : err(`/tags/${i}`, 'Lowercase letters, digits and hyphens, 1-32 characters.'));

  if (!Array.isArray(v.assertions) || v.assertions.length > 20) err('/assertions', 'Array of at most 20 assertions.');
  else v.assertions.forEach((a, i) => validateAssertion(a, `/assertions/${i}`, err));

  if (errors.length) return { errors };
  return {
    value: {
      name: v.name.trim(),
      url: v.url,
      method: v.method,
      headers: v.headers,
      body: v.body,
      interval_s: v.interval_s,
      timeout_ms: v.timeout_ms,
      follow_redirects: v.follow_redirects,
      assertions: v.assertions.map(({ source, property, op, target }) => ({ source, ...(property !== undefined ? { property } : {}), op, ...(target !== undefined ? { target } : {}) })),
      failure_threshold: v.failure_threshold,
      slo_target: v.slo_target,
      tags: [...new Set(v.tags)],
      paused: v.paused,
      capture: v.capture,
    },
  };
}

function validateAssertion(a, ptr, err) {
  if (!isObj(a)) return err(ptr, 'Assertion must be an object.');
  for (const k of Object.keys(a)) if (!['source', 'property', 'op', 'target'].includes(k)) err(`${ptr}/${k}`, 'Unknown field.');
  if (!SOURCES.includes(a.source)) return err(`${ptr}/source`, `One of ${SOURCES.join(', ')}.`);
  if (!OPS_BY_SOURCE[a.source].includes(a.op)) return err(`${ptr}/op`, `For source "${a.source}", one of ${OPS_BY_SOURCE[a.source].join(', ')}.`);
  const needsProperty = a.source === 'header' || a.source === 'json';
  if (needsProperty && (typeof a.property !== 'string' || !a.property || a.property.length > 200)) err(`${ptr}/property`, a.source === 'header' ? 'Header name to inspect.' : 'Dot path into the JSON body, e.g. "status.indicator" or "items[0].id".');
  if (!needsProperty && a.property !== undefined) err(`${ptr}/property`, `Not used with source "${a.source}".`);
  const noTarget = a.op === 'exists' || a.op === 'not_exists';
  if (noTarget && a.target !== undefined) err(`${ptr}/target`, `Not used with op "${a.op}".`);
  if (!noTarget) {
    if (a.target === undefined) return err(`${ptr}/target`, 'Required.');
    if (a.op === 'in' && (!Array.isArray(a.target) || a.target.length === 0 || a.target.length > 50)) err(`${ptr}/target`, 'Non-empty array of up to 50 values.');
    if (NUMERIC_OPS.has(a.op) && typeof a.target !== 'number') err(`${ptr}/target`, 'Number.');
    if (['contains', 'not_contains'].includes(a.op) && (typeof a.target !== 'string' || a.target.length > 500)) err(`${ptr}/target`, 'String up to 500 characters.');
    if ((a.source === 'status' || a.source === 'latency_ms') && a.op !== 'in' && typeof a.target !== 'number') err(`${ptr}/target`, 'Number.');
    if (JSON.stringify(a.target).length > 2000) err(`${ptr}/target`, 'Too large.');
  }
}

// RFC 7396 JSON Merge Patch.
export function mergePatch(target, patch) {
  if (!isObj(patch)) return patch;
  const out = isObj(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

// Header values are redacted by default. A denylist ("authorization",
// "*token*") always misses some vendor's credential header (DD-API-KEY,
// Ocp-Apim-Subscription-Key, apikey...), so only headers known to carry no
// secret are echoed back.
export const SAFE_HEADERS = new Set(['accept', 'accept-encoding', 'accept-language', 'cache-control', 'content-type', 'if-none-match', 'if-modified-since', 'origin', 'pragma', 'referer', 'user-agent', 'x-request-id']);
export const REDACTED = '[redacted]';

export function redactHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, SAFE_HEADERS.has(k.toLowerCase()) ? v : REDACTED]));
}

// For anonymous readers: query values and request bodies can carry
// credentials too (?api_key=..., client_secret=...).
export function redactUrl(url) {
  try {
    const u = new URL(url);
    for (const k of [...new Set(u.searchParams.keys())]) u.searchParams.set(k, REDACTED);
    return u.search ? u.toString().replaceAll(encodeURIComponent(REDACTED), REDACTED) : url;
  } catch {
    return url;
  }
}

export const keepSafeHeaders = (headers) => Object.fromEntries(Object.entries(headers).filter(([k]) => SAFE_HEADERS.has(k.toLowerCase())));

// A client that GETs, edits and PATCHes back would otherwise overwrite a real
// secret with the literal "[redacted]". Keep the stored value in that case.
export function restoreRedacted(nextHeaders, storedHeaders) {
  if (!isObj(nextHeaders)) return nextHeaders;
  return Object.fromEntries(
    Object.entries(nextHeaders).map(([k, v]) => [k, v === REDACTED && storedHeaders[k] !== undefined ? storedHeaders[k] : v]),
  );
}

export function monitorInputOf(m) {
  const out = {};
  for (const k of ['name', 'url', ...Object.keys(DEFAULTS)]) out[k] = m[k];
  return out;
}
