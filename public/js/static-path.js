// Maps an API request path to the file name used by the static snapshot.
// Shared by the browser client and scripts/build-pages.js so both sides
// always agree on the mapping.
export function staticPathFor(pathWithQuery) {
  const u = new URL(pathWithQuery, 'http://snapshot.invalid');
  const params = [...u.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.map(([k, v]) => `${k}=${v}`).join('&').replace(/[^\w=&.-]/g, '_');
  return `api${u.pathname}${query ? `__${query}` : ''}.json`;
}
