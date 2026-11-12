// Runtime configuration. Every knob is an environment variable so the same
// build runs locally, in CI and behind a reverse proxy without code changes.

const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const int = (v, d) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
};

export function loadConfig(env = process.env, overrides = {}) {
  const cfg = {
    host: env.AHM_HOST || '127.0.0.1',
    port: int(env.AHM_PORT, 8080),
    dbPath: env.AHM_DB || 'data/ahm.db',
    apiKey: env.AHM_API_KEY || '',
    // Without a key (loopback only) everything is open. With a key, reads
    // require it too unless AHM_PUBLIC_READ=true is set explicitly.
    publicRead: bool(env.AHM_PUBLIC_READ, !env.AHM_API_KEY && !overrides.apiKey),
    allowPrivateTargets: bool(env.AHM_ALLOW_PRIVATE_TARGETS, false),
    corsOrigins: (env.AHM_CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    trustProxy: bool(env.AHM_TRUST_PROXY, false),
    maxConcurrency: int(env.AHM_MAX_CONCURRENCY, 8),
    retentionDays: int(env.AHM_RETENTION_DAYS, 30),
    probe: env.AHM_PROBE || 'local',
    intervalOverrideS: int(env.AHM_INTERVAL_OVERRIDE_S, 0),
    rateLimit: { capacity: int(env.AHM_RATE_LIMIT, 300), windowS: 60 },
    scheduler: true,
    logRequests: bool(env.AHM_LOG_REQUESTS, true),
    ...overrides,
  };
  return cfg;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

// Refuse to expose a write-capable API on a routable interface without a key.
export function assertSafeBinding(cfg) {
  if (!cfg.apiKey && !LOOPBACK.has(cfg.host)) {
    throw new Error(
      `Refusing to listen on ${cfg.host} without AHM_API_KEY. ` +
        'Set an API key or bind to 127.0.0.1.',
    );
  }
  if (cfg.apiKey && cfg.apiKey.length < 24) {
    throw new Error('AHM_API_KEY must be at least 24 characters.');
  }
}
