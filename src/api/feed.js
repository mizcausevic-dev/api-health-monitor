// Atom 1.0 (RFC 4287) feed of incidents: one entry per incident, updated
// when it resolves. Used by GET /v1/feeds/incidents and by the static
// snapshot (incidents.xml), so both render through the same code.
//
// Incident causes can contain text chosen by a failing server, so every text
// node is XML-escaped and characters that XML 1.0 forbids are removed (an
// unescaped "<" or a stray control byte would make the whole feed unparsable
// for every subscriber).

// eslint-disable-next-line no-control-regex
const INVALID_XML = /[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/gu;
export const xml = (s) =>
  String(s ?? '')
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const duration = (s) => (s == null ? null : s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

function entryText(i) {
  const lines = [
    i.state === 'open' ? `Down since ${i.opened_at}.` : `Down from ${i.opened_at} to ${i.resolved_at} (${duration(i.duration_s)}).`,
    `Cause: ${i.cause}`,
    `Consecutive failed checks: ${i.failed_checks}`,
  ];
  return lines.join('\n');
}

// siteUrl: absolute base of the dashboard (links and tag: ids derive from it).
// selfUrl: absolute URL of this feed document.
export function renderIncidentsAtom(incidents, { siteUrl, selfUrl, title = 'API Health Monitor incidents', now = new Date() }) {
  const base = siteUrl.replace(/\/$/, '');
  const host = new URL(base).host;
  const updated = incidents.reduce((max, i) => {
    const t = i.resolved_at || i.opened_at;
    return t > max ? t : max;
  }, '') || now.toISOString();
  const entries = incidents.map((i) => {
    const entryUpdated = i.resolved_at || i.opened_at;
    const heading = i.state === 'open' ? `${i.monitor_name} is down` : `${i.monitor_name} recovered after ${duration(i.duration_s)}`;
    return `  <entry>
    <id>tag:${xml(host)},2026:incident/${xml(i.id)}</id>
    <title>${xml(heading)}</title>
    <updated>${xml(entryUpdated)}</updated>
    <published>${xml(i.opened_at)}</published>
    <link rel="alternate" type="text/html" href="${xml(`${base}/#/monitors/${i.monitor_id}`)}"/>
    <category term="${xml(i.state)}"/>
    <content type="text">${xml(entryText(i))}</content>
  </entry>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>tag:${xml(host)},2026:incidents</id>
  <title>${xml(title)}</title>
  <subtitle>Incidents open after consecutive failed checks and resolve on the next passing check.</subtitle>
  <updated>${xml(updated)}</updated>
  <author><name>API Health Monitor</name></author>
  <generator uri="https://github.com/mizcausevic-dev/api-health-monitor">API Health Monitor</generator>
  <link rel="self" type="application/atom+xml" href="${xml(selfUrl)}"/>
  <link rel="alternate" type="text/html" href="${xml(`${base}/#/incidents`)}"/>
${entries.join('\n')}
</feed>
`;
}
