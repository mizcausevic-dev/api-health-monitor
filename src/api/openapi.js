// OpenAPI 3.1 contract. test/openapi.test.js fails the build if a route
// exists in the router but not here, or the reverse.
import { PROBLEM_BASE } from '../http/problem.js';
import { METHODS, SOURCES, OPS } from './validate.js';

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema) => ({ 'application/json': { schema } });
const problem = (description) => ({ description, content: { 'application/problem+json': { schema: ref('Problem') } } });
const P = {
  id: { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
  limit: (max, def) => ({ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: max, default: def } }),
  cursor: { name: 'cursor', in: 'query', description: 'Opaque cursor from `page.next_cursor`.', schema: { type: 'string' } },
  ifMatch: (required) => ({ name: 'If-Match', in: 'header', required, schema: { type: 'string' }, description: 'ETag from the last GET, e.g. `"v3"`.' }),
  ifNoneMatch: { name: 'If-None-Match', in: 'header', schema: { type: 'string' } },
  idem: { name: 'Idempotency-Key', in: 'header', schema: { type: 'string', maxLength: 255 }, description: 'Replays the first response for retries with the same key and body (24 h).' },
};
const common = {
  400: problem('Malformed request, unknown query parameter or invalid cursor.'),
  401: problem('Missing or invalid API key.'),
  406: problem('Accept header excludes application/json.'),
  429: problem('Rate limited; see Retry-After.'),
};
const notFound = { 404: problem('No such resource.') };
const page = (item) => ({
  type: 'object',
  required: ['data', 'page'],
  properties: {
    data: { type: 'array', items: ref(item) },
    page: { type: 'object', properties: { next_cursor: { type: ['string', 'null'] }, next: { type: ['string', 'null'], description: 'Relative URL of the next page; also sent as `Link: <...>; rel="next"`.' } } },
  },
});

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'API Health Monitor',
    version: '1.0.0',
    summary: 'Store endpoint monitors, run scheduled checks with assertions, chart latency and log unexpected responses.',
    license: { name: 'MIT', identifier: 'MIT' },
  },
  servers: [{ url: '/' }],
  security: [{}, { bearer: [] }],
  tags: [
    { name: 'Monitors', description: 'Monitor configuration (CRUD with optimistic concurrency).' },
    { name: 'Checks', description: 'Individual check results, including unexpected responses.' },
    { name: 'Analytics', description: 'Latency percentiles, availability, Apdex and error budget.' },
    { name: 'Incidents', description: 'Opened after N consecutive failures, resolved on the next success.' },
    { name: 'System', description: 'Discovery, health and the event stream.' },
  ],
  paths: {
    '/v1': { get: { tags: ['System'], summary: 'API root with links', operationId: 'getRoot', responses: { 200: { description: 'Entry point.', content: json({ type: 'object' }) } } } },
    '/v1/health': { get: { tags: ['System'], summary: 'Liveness and readiness', operationId: 'getHealth', responses: { 200: { description: 'Healthy.', content: json({ type: 'object' }) } } } },
    '/v1/openapi.json': { get: { tags: ['System'], summary: 'This document', operationId: 'getOpenApi', responses: { 200: { description: 'OpenAPI 3.1.', content: json({ type: 'object' }) } } } },
    '/v1/monitors': {
      get: {
        tags: ['Monitors'], summary: 'List monitors', operationId: 'listMonitors',
        parameters: [
          { name: 'status', in: 'query', schema: { enum: ['pending', 'up', 'degraded', 'down', 'paused'] } },
          { name: 'tag', in: 'query', schema: { type: 'string' } },
          { name: 'q', in: 'query', description: 'Substring match on name or URL.', schema: { type: 'string' } },
          { name: 'sort', in: 'query', schema: { enum: ['created_at', '-created_at', 'name', '-name'], default: '-created_at' } },
          { name: 'expand', in: 'query', schema: { enum: ['state'] }, description: 'Embed each monitor\'s runtime state.' },
          P.limit(100, 25), P.cursor, P.ifNoneMatch,
        ],
        responses: { 200: { description: 'One page of monitors.', headers: { Link: { schema: { type: 'string' } } }, content: json(page('Monitor')) }, 304: { description: 'Not modified.' }, ...common },
      },
      post: {
        tags: ['Monitors'], summary: 'Create a monitor', operationId: 'createMonitor', security: [{ bearer: [] }],
        parameters: [P.idem],
        requestBody: { required: true, content: json(ref('MonitorInput')) },
        responses: {
          201: { description: 'Created.', headers: { Location: { schema: { type: 'string' } }, ETag: { schema: { type: 'string' } } }, content: json(ref('Monitor')) },
          ...common, 409: problem('Same Idempotency-Key still in flight.'), 413: problem('Body over 64 KiB.'), 415: problem('Not application/json.'), 422: problem('Validation failed, or Idempotency-Key reused with a different body.'),
        },
      },
    },
    '/v1/monitors/{id}': {
      parameters: [P.id],
      get: { tags: ['Monitors'], summary: 'Get a monitor', operationId: 'getMonitor', parameters: [P.ifNoneMatch], responses: { 200: { description: 'The monitor. `ETag` is `"v{version}"`.', content: json(ref('Monitor')) }, 304: { description: 'Not modified.' }, ...common, ...notFound } },
      patch: {
        tags: ['Monitors'], summary: 'Update a monitor (JSON Merge Patch)', operationId: 'updateMonitor', security: [{ bearer: [] }],
        parameters: [P.ifMatch(true)],
        requestBody: { required: true, content: { 'application/merge-patch+json': { schema: { type: 'object' } }, 'application/json': { schema: { type: 'object' } } } },
        responses: { 200: { description: 'Updated.', content: json(ref('Monitor')) }, ...common, ...notFound, 412: problem('ETag mismatch: someone else changed it.'), 415: problem('Unsupported content type.'), 422: problem('Validation failed.'), 428: problem('If-Match missing.') },
      },
      delete: { tags: ['Monitors'], summary: 'Delete a monitor and its history', operationId: 'deleteMonitor', security: [{ bearer: [] }], parameters: [P.ifMatch(false)], responses: { 204: { description: 'Deleted.' }, ...common, ...notFound, 412: problem('ETag mismatch.') } },
    },
    '/v1/monitors/{id}/state': {
      parameters: [P.id],
      get: { tags: ['Monitors'], summary: 'Runtime state of a monitor', operationId: 'getMonitorState', responses: { 200: { description: 'Current status, failure streak and open incident.', content: json(ref('MonitorState')) }, ...common, ...notFound } },
    },
    '/v1/monitors/{id}/checks': {
      parameters: [P.id],
      get: {
        tags: ['Checks'], summary: 'List check results, newest first', operationId: 'listChecks',
        parameters: [
          { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'until', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'outcome', in: 'query', schema: { enum: ['up', 'degraded', 'down', 'fail'] }, description: '`fail` = degraded or down (the unexpected-response log).' },
          P.limit(200, 50), P.cursor,
        ],
        responses: { 200: { description: 'One page of checks.', content: json(page('Check')) }, ...common, ...notFound },
      },
      post: {
        tags: ['Checks'], summary: 'Run a check now', operationId: 'runCheck', security: [{ bearer: [] }], parameters: [P.idem],
        description: 'Costs 10 rate-limit tokens. Waits for the result (bounded by the monitor timeout).',
        responses: { 201: { description: 'The new check.', headers: { Location: { schema: { type: 'string' } } }, content: json(ref('Check')) }, ...common, ...notFound },
      },
    },
    '/v1/checks/{id}': { parameters: [P.id], get: { tags: ['Checks'], summary: 'Get one check', operationId: 'getCheck', responses: { 200: { description: 'Immutable once written.', content: json(ref('Check')) }, ...common, ...notFound } } },
    '/v1/monitors/{id}/stats': {
      parameters: [P.id],
      get: {
        tags: ['Analytics'], summary: 'Latency and availability statistics', operationId: 'getMonitorStats',
        parameters: [{ name: 'window', in: 'query', schema: { enum: ['1h', '6h', '24h', '7d', '30d'], default: '24h' } }, { name: 'buckets', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 48 } }],
        responses: { 200: { description: 'Summary, phases, status codes, histogram and time series.', content: json(ref('Stats')) }, ...common, ...notFound },
      },
    },
    '/v1/incidents': {
      get: {
        tags: ['Incidents'], summary: 'List incidents', operationId: 'listIncidents',
        parameters: [{ name: 'state', in: 'query', schema: { enum: ['open', 'resolved'] } }, { name: 'monitor_id', in: 'query', schema: { type: 'string' } }, P.limit(100, 50), P.cursor],
        responses: { 200: { description: 'One page of incidents.', content: json(page('Incident')) }, ...common },
      },
    },
    '/v1/incidents/{id}': { parameters: [P.id], get: { tags: ['Incidents'], summary: 'Get an incident', operationId: 'getIncident', responses: { 200: { description: 'The incident.', content: json(ref('Incident')) }, ...common, ...notFound } } },
    '/v1/overview': {
      get: {
        tags: ['Analytics'], summary: 'Dashboard read model across all monitors', operationId: 'getOverview',
        parameters: [{ name: 'window', in: 'query', schema: { enum: ['1h', '6h', '24h', '7d'], default: '24h' } }],
        responses: { 200: { description: 'Totals, per-monitor summaries, recent failures.', content: json({ type: 'object' }) }, ...common },
      },
    },
    '/v1/events': {
      get: {
        tags: ['System'], summary: 'Server-Sent Events stream', operationId: 'streamEvents',
        description: 'Events: `check.completed`, `incident.opened`, `incident.resolved`, `monitor.created`, `monitor.updated`, `monitor.deleted`. Reconnect with `Last-Event-ID` to replay up to 500 missed events.',
        parameters: [{ name: 'Last-Event-ID', in: 'header', schema: { type: 'string' } }],
        responses: { 200: { description: 'text/event-stream', content: { 'text/event-stream': { schema: { type: 'string' } } } }, 503: problem('Too many subscribers.') },
      },
    },
  },
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'Value of AHM_API_KEY.' } },
    schemas: {
      Problem: {
        type: 'object', description: 'RFC 9457 Problem Details.',
        required: ['type', 'title', 'status'],
        properties: {
          type: { type: 'string', format: 'uri', examples: [`${PROBLEM_BASE}validation-failed`] },
          title: { type: 'string' }, status: { type: 'integer' }, detail: { type: 'string' }, instance: { type: 'string' }, request_id: { type: 'string' },
          errors: { type: 'array', items: { type: 'object', properties: { pointer: { type: 'string', description: 'RFC 6901 JSON Pointer.' }, detail: { type: 'string' } } } },
        },
      },
      Assertion: {
        type: 'object', required: ['source', 'op'],
        properties: { source: { enum: SOURCES }, property: { type: 'string', description: 'Header name (source=header) or dot path (source=json).' }, op: { enum: OPS }, target: {} },
        examples: [{ source: 'status', op: 'in', target: [200, 204] }, { source: 'latency_ms', op: 'lt', target: 800 }, { source: 'json', property: 'status.indicator', op: 'eq', target: 'none' }],
      },
      MonitorInput: {
        type: 'object', required: ['name', 'url'], additionalProperties: false,
        properties: {
          name: { type: 'string', maxLength: 120 },
          url: { type: 'string', format: 'uri', description: 'http(s) only. Private, loopback and link-local targets are refused unless AHM_ALLOW_PRIVATE_TARGETS=true.' },
          method: { enum: METHODS, default: 'GET' },
          headers: { type: 'object', additionalProperties: { type: 'string' }, maxProperties: 20, description: 'Credential-like values are returned as "[redacted]".' },
          body: { type: ['string', 'null'], maxLength: 16384 },
          interval_s: { type: 'integer', minimum: 30, maximum: 86400, default: 60 },
          timeout_ms: { type: 'integer', minimum: 100, maximum: 30000, default: 10000 },
          follow_redirects: { type: 'boolean', default: false },
          assertions: { type: 'array', maxItems: 20, items: ref('Assertion'), description: 'Empty means "status < 400".' },
          failure_threshold: { type: 'integer', minimum: 1, maximum: 10, default: 2 },
          slo_target: { type: 'number', minimum: 0.5, maximum: 0.99999, default: 0.999 },
          tags: { type: 'array', maxItems: 10, items: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,31}$' } },
          paused: { type: 'boolean', default: false },
          capture: { enum: ['sample', 'status_only', 'none'], default: 'sample', description: 'What a failed check stores. sample: 2 KiB body, selected headers and observed values. status_only: which assertion failed, no observed values. none: status and timings only. Use status_only or none for authenticated or private endpoints.' },
        },
      },
      Monitor: {
        allOf: [ref('MonitorInput'), {
          type: 'object',
          properties: {
            id: { type: 'string', examples: ['mon_01jg5n3x8w1q6v2k9d4r7t0yhm'] }, version: { type: 'integer' },
            created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' },
            links: { type: 'object', additionalProperties: { type: 'string' } },
          },
        }],
      },
      MonitorState: {
        type: 'object',
        properties: { monitor_id: { type: 'string' }, status: { enum: ['pending', 'up', 'degraded', 'down', 'paused'] }, last_checked_at: { type: ['string', 'null'] }, consecutive_failures: { type: 'integer' }, open_incident: { oneOf: [ref('Incident'), { type: 'null' }] } },
      },
      Check: {
        type: 'object',
        properties: {
          id: { type: 'string' }, monitor_id: { type: 'string' }, started_at: { type: 'string', format: 'date-time' },
          outcome: { enum: ['up', 'degraded', 'down'], description: 'degraded = only latency budgets failed.' },
          status_code: { type: ['integer', 'null'] },
          error: { oneOf: [{ type: 'null' }, { type: 'object', properties: { code: { enum: ['dns_failure', 'connection_refused', 'connection_reset', 'host_unreachable', 'timeout', 'tls_error', 'blocked_target', 'too_many_redirects', 'bad_redirect', 'protocol_error', 'request_failed'] }, message: { type: 'string' } } }] },
          timings: { type: 'object', properties: { total_ms: { type: 'number' }, dns_ms: { type: 'number' }, connect_ms: { type: 'number' }, tls_ms: { type: ['number', 'null'] }, ttfb_ms: { type: 'number' }, transfer_ms: { type: 'number' } } },
          response_bytes: { type: ['integer', 'null'] }, remote_address: { type: ['string', 'null'] }, redirects: { type: 'integer' }, probe: { type: 'string' },
          failed_assertions: { type: 'array', items: { type: 'object' } },
          response_sample: { type: ['object', 'null'], description: 'Headers subset and first 2 KiB of the body, kept only for unexpected responses.' },
        },
      },
      Stats: {
        type: 'object',
        properties: {
          summary: { type: 'object', description: 'checks, outcomes, availability, apdex, latency_ms {p50,p90,p95,p99,...}, error_budget {slo_target, allowed_failures, failures, min_checks, status: ok|exhausted|insufficient_data|no_data, remaining (null unless the window allows at least one failure)}.' },
          phases_ms: { type: 'object' }, status_codes: { type: 'object', additionalProperties: { type: 'integer' } },
          histogram: { type: 'array', items: { type: 'object' } }, series: { type: 'array', items: { type: 'object' } },
        },
      },
      Incident: {
        type: 'object',
        properties: { id: { type: 'string' }, monitor_id: { type: 'string' }, monitor_name: { type: 'string' }, state: { enum: ['open', 'resolved'] }, opened_at: { type: 'string' }, resolved_at: { type: ['string', 'null'] }, duration_s: { type: ['integer', 'null'] }, cause: { type: 'string' }, failed_checks: { type: 'integer' } },
      },
    },
  },
};
