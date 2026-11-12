// RFC 9457 Problem Details. Every error the API returns is one of these, with
// a stable `type` URI that resolves to human documentation (docs/errors.md,
// published as errors.html on the live site).

export const PROBLEM_BASE =
  process.env.AHM_PROBLEM_BASE || 'https://mizcausevic-dev.github.io/api-health-monitor/errors.html#';

export const PROBLEM_TYPES = {
  'bad-request': { status: 400, title: 'Bad request', help: 'The request was malformed: invalid JSON, an unknown query parameter value, or an invalid pagination cursor.' },
  unauthorized: { status: 401, title: 'Authentication required', help: 'Send `Authorization: Bearer <api key>`. Writes always need the key; reads need it when AHM_PUBLIC_READ=false.' },
  'not-found': { status: 404, title: 'Resource not found', help: 'No resource exists at this URI. IDs are prefixed (`mon_`, `chk_`, `inc_`) and case-sensitive.' },
  'method-not-allowed': { status: 405, title: 'Method not allowed', help: 'The resource exists but does not support this method. The `Allow` header lists the methods it does support.' },
  'not-acceptable': { status: 406, title: 'Not acceptable', help: 'The API only produces `application/json` (and `text/event-stream` on /v1/events). Adjust the `Accept` header.' },
  'idempotency-conflict': { status: 409, title: 'Request with this Idempotency-Key is still in progress', help: 'A request with the same Idempotency-Key is being processed. Retry after it completes.' },
  'precondition-failed': { status: 412, title: 'Precondition failed', help: 'The `If-Match` ETag no longer matches: someone else changed the resource. GET it again, re-apply your change, and retry.' },
  'payload-too-large': { status: 413, title: 'Payload too large', help: 'Request bodies are limited to 64 KiB.' },
  'unsupported-media-type': { status: 415, title: 'Unsupported media type', help: 'POST accepts `application/json`. PATCH accepts `application/merge-patch+json` (RFC 7396) or `application/json`.' },
  'validation-failed': { status: 422, title: 'Validation failed', help: 'The body parsed but violates the schema. `errors[]` lists each problem with an RFC 6901 JSON Pointer to the offending field.' },
  'idempotency-key-reused': { status: 422, title: 'Idempotency-Key reused with a different payload', help: 'An Idempotency-Key identifies one logical operation. Generate a new key for a different request body.' },
  'precondition-required': { status: 428, title: 'Precondition required', help: 'PATCH must carry `If-Match: <etag>` so concurrent edits cannot silently overwrite each other (lost-update protection).' },
  'rate-limited': { status: 429, title: 'Too many requests', help: 'The client exhausted its token bucket. Wait for `Retry-After` seconds. `RateLimit` and `RateLimit-Policy` headers report quota on every response.' },
  'internal-error': { status: 500, title: 'Internal server error', help: 'Unexpected failure. The `request_id` in the body matches the server log line.' },
  'stream-capacity': { status: 503, title: 'Event stream capacity reached', help: 'Too many concurrent /v1/events subscribers. Retry later.' },
};

export class HttpError extends Error {
  constructor(slug, detail, { extensions = {}, headers = {} } = {}) {
    const def = PROBLEM_TYPES[slug] || PROBLEM_TYPES['internal-error'];
    super(detail || def.title);
    this.slug = slug;
    this.status = def.status;
    this.title = def.title;
    this.detail = detail;
    this.extensions = extensions;
    this.headers = headers;
  }

  toProblem(instance, requestId) {
    return {
      type: PROBLEM_BASE + this.slug,
      title: this.title,
      status: this.status,
      ...(this.detail ? { detail: this.detail } : {}),
      instance,
      request_id: requestId,
      ...this.extensions,
    };
  }
}

export const httpError = (slug, detail, opts) => new HttpError(slug, detail, opts);

export const validationError = (errors) =>
  new HttpError('validation-failed', `${errors.length} field${errors.length === 1 ? '' : 's'} failed validation.`, {
    extensions: { errors },
  });
