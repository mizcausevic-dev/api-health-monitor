// Assertion evaluation. Deliberately no regex operator: user-supplied
// patterns evaluated against attacker-influenced response bodies are a
// ReDoS vector. `contains` / `eq` cover the realistic cases.

export const DEFAULT_ASSERTIONS = [{ source: 'status', op: 'lt', target: 400 }];

const SAFE_KEY = (k) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype';

export function getPath(obj, path) {
  const keys = [];
  for (const part of path.split('.')) {
    const m = part.match(/^([^[\]]*)((?:\[\d+\])*)$/);
    if (!m) return { found: false };
    if (m[1]) keys.push(m[1]);
    for (const idx of m[2].matchAll(/\[(\d+)\]/g)) keys.push(Number(idx[1]));
  }
  let cur = obj;
  for (const k of keys) {
    if (cur === null || typeof cur !== 'object' || (typeof k === 'string' && !SAFE_KEY(k)) || !Object.hasOwn(cur, k)) {
      return { found: false };
    }
    cur = cur[k];
  }
  return { found: true, value: cur };
}

const same = (a, b) => (typeof a === 'object' || typeof b === 'object' ? JSON.stringify(a) === JSON.stringify(b) : a === b);

function compare(op, actual, target) {
  switch (op) {
    case 'eq': return same(actual, target);
    case 'neq': return !same(actual, target);
    case 'lt': return Number(actual) < target;
    case 'lte': return Number(actual) <= target;
    case 'gt': return Number(actual) > target;
    case 'gte': return Number(actual) >= target;
    case 'in': return target.some((t) => same(actual, t));
    case 'contains':
      if (Array.isArray(actual)) return actual.some((x) => same(x, target));
      return typeof actual === 'string' && actual.includes(String(target));
    case 'not_contains': return !(typeof actual === 'string' && actual.includes(String(target)));
    default: return false;
  }
}

const show = (v) => (v === undefined ? 'missing' : JSON.stringify(v)?.slice(0, 120));
function boundedActual(v) {
  if (v === undefined || v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  return text.length > 200 ? `${text.slice(0, 200)}…` : v;
}

// ctx: { status_code, total_ms, headers (lowercased keys), bodyText, truncated }
export function evaluateAssertions(assertions, ctx) {
  const list = assertions.length ? assertions : DEFAULT_ASSERTIONS;
  const failures = [];
  let json;
  let jsonError = null;
  const parseJson = () => {
    if (json !== undefined || jsonError) return;
    if (ctx.truncated) jsonError = 'body exceeded the capture limit and was not parsed';
    else {
      try {
        json = JSON.parse(ctx.bodyText);
      } catch {
        jsonError = 'body is not valid JSON';
      }
    }
  };

  list.forEach((a, index) => {
    let actual;
    let ok;
    let note = '';
    switch (a.source) {
      case 'status':
        actual = ctx.status_code;
        ok = compare(a.op, actual, a.target);
        break;
      case 'latency_ms':
        actual = Math.round(ctx.total_ms);
        ok = compare(a.op, actual, a.target);
        break;
      case 'header': {
        actual = ctx.headers[a.property.toLowerCase()];
        if (Array.isArray(actual)) actual = actual.join(', ');
        ok = a.op === 'exists' ? actual !== undefined : a.op === 'not_exists' ? actual === undefined : compare(a.op, actual, a.target);
        break;
      }
      case 'body':
        actual = undefined;
        ok = compare(a.op, ctx.bodyText, a.target);
        break;
      case 'json': {
        parseJson();
        if (jsonError) {
          ok = false;
          note = jsonError;
          break;
        }
        const r = getPath(json, a.property);
        actual = r.found ? r.value : undefined;
        ok = a.op === 'exists' ? r.found : a.op === 'not_exists' ? !r.found : r.found && compare(a.op, actual, a.target);
        break;
      }
      default:
        ok = false;
    }
    if (!ok) {
      const subject = a.property ? `${a.source} ${a.property}` : a.source;
      const expectation = a.target === undefined ? a.op.replace('_', ' ') : `${a.op} ${show(a.target)}`;
      failures.push({
        index,
        source: a.source,
        ...(a.property ? { property: a.property } : {}),
        op: a.op,
        ...(a.target !== undefined ? { target: a.target } : {}),
        // Bounded: a 256 KiB value at a JSON path must not bypass the 2 KiB
        // response-sample cap.
        actual: a.source === 'body' ? undefined : boundedActual(actual),
        message: note ? `${subject}: ${note}` : `expected ${subject} ${expectation}, got ${a.source === 'body' ? 'body without match' : show(actual)}`,
        // Same message without the observed value, for capture=status_only.
        expected: note ? `${subject}: ${note}` : `expected ${subject} ${expectation}`,
      });
    }
  });
  return failures;
}

// up: transport fine, every assertion passed
// degraded: only latency budgets failed (reachable but slow)
// down: transport error, or any non-latency assertion failed
export function classify(error, failures) {
  if (error) return 'down';
  if (!failures.length) return 'up';
  return failures.every((f) => f.source === 'latency_ms') ? 'degraded' : 'down';
}
