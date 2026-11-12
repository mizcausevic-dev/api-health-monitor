// Post-deploy notifier for the GitHub Pages pipeline. The build job records
// the incident transitions that happened in its own run; this script delivers
// them only after the site deployed, so a failed build never alerts on state
// that was not published (and the next run would otherwise re-open it).
//
//   AHM_ALERTS_B64=<base64 JSON array> node scripts/deliver-alerts.js
//
// Skips cleanly when AHM_WEBHOOK_URL is not configured (forks, or before the
// repository secrets are added). Exits 1 if any delivery ultimately fails.
import { parseWebhookConfig, deliver, NOTIFY_EVENTS } from '../src/engine/notify.js';

const log = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const raw = process.env.AHM_ALERTS_B64 ? Buffer.from(process.env.AHM_ALERTS_B64, 'base64').toString('utf8') : '[]';
let events;
try {
  events = JSON.parse(raw).filter((e) => e && NOTIFY_EVENTS.has(e.type) && e.data && typeof e.data.id === 'string');
} catch {
  log({ level: 'error', msg: 'alerts payload is not valid JSON' });
  process.exit(1);
}
const cfg = parseWebhookConfig(process.env);
if (!cfg) {
  log({ msg: 'no webhook configured; skipping', events: events.length });
  process.exit(0);
}
// In parallel with short backoff, so a slow receiver cannot push the job past
// its 5-minute timeout (worst case ~12 s of waits + 3 x 10 s timeouts).
const results = await Promise.all(events.map((e) => deliver(cfg, e, { siteUrl: process.env.AHM_PUBLIC_URL, log, delays: [0, 2000, 10000] })));
const failed = results.filter((r) => !r.ok).length;
log({ msg: 'alerts processed', events: events.length, failed });
process.exit(failed ? 1 : 0);
