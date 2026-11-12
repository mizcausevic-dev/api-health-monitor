// Minimal path router. Distinguishes "no such resource" (404) from "resource
// exists, wrong method" (405 + Allow) — a distinction most hand-rolled routers
// get wrong. HEAD is served by GET handlers; OPTIONS is answered automatically.

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, meta = {}) {
    const keys = [];
    const source = pattern
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          keys.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    let entry = this.routes.find((r) => r.pattern === pattern);
    if (!entry) {
      entry = { pattern, regex: new RegExp(`^${source}/?$`), keys, methods: new Map() };
      this.routes.push(entry);
    }
    entry.methods.set(method, { handler, meta });
    return this;
  }

  match(method, path) {
    for (const route of this.routes) {
      const m = route.regex.exec(path);
      if (!m) continue;
      const params = {};
      route.keys.forEach((k, i) => {
        // A malformed escape cannot name a real resource; keep it raw so
        // the handler answers 404 instead of throwing a URIError (500).
        try {
          params[k] = decodeURIComponent(m[i + 1]);
        } catch {
          params[k] = m[i + 1];
        }
      });
      const allow = this.allowFor(route);
      const lookup = method === 'HEAD' ? 'GET' : method;
      const hit = route.methods.get(lookup);
      return { route, params, allow, handler: hit?.handler, meta: hit?.meta ?? {} };
    }
    return null;
  }

  allowFor(route) {
    const methods = [...route.methods.keys()];
    if (methods.includes('GET')) methods.push('HEAD');
    methods.push('OPTIONS');
    return methods;
  }

  // Used by the OpenAPI drift test.
  list() {
    return this.routes.flatMap((r) => [...r.methods.keys()].map((m) => ({ method: m, pattern: r.pattern })));
  }
}
