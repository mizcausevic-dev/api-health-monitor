// Token-bucket rate limiter with cost-weighted requests. Reports quota with
// the IETF RateLimit / RateLimit-Policy fields
// (draft-ietf-httpapi-ratelimit-headers; still a draft, not an RFC):
//   RateLimit-Policy: "default";q=300;w=60
//   RateLimit:        "default";r=287;t=4
export class RateLimiter {
  constructor({ capacity = 300, windowS = 60, maxKeys = 10000 } = {}, clock = () => Date.now()) {
    this.capacity = capacity;
    this.windowS = windowS;
    this.refillPerMs = capacity / (windowS * 1000);
    this.buckets = new Map();
    this.maxKeys = maxKeys;
    this.clock = clock;
  }

  take(key, cost = 1) {
    const now = this.clock();
    let b = this.buckets.get(key);
    if (!b) {
      // Bounded memory: evict the oldest key (Map keeps insertion order).
      if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value);
      b = { tokens: this.capacity, at: now };
    } else {
      this.buckets.delete(key);
    }
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.at) * this.refillPerMs);
    b.at = now;
    const allowed = b.tokens >= cost;
    if (allowed) b.tokens -= cost;
    this.buckets.set(key, b);
    const remaining = Math.floor(b.tokens);
    const resetS = Math.ceil((this.capacity - b.tokens) / this.refillPerMs / 1000);
    const retryAfterS = allowed ? 0 : Math.ceil((cost - b.tokens) / this.refillPerMs / 1000);
    return {
      allowed,
      retryAfterS,
      headers: {
        'RateLimit-Policy': `"default";q=${this.capacity};w=${this.windowS}`,
        RateLimit: `"default";r=${remaining};t=${resetS}`,
      },
    };
  }
}
