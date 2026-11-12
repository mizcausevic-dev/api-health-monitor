import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig, assertSafeBinding } from './config.js';
import { openDb } from './db/index.js';
import { allMonitors, insertMonitor } from './db/repo.js';
import { validateMonitor } from './api/validate.js';
import { Scheduler } from './engine/scheduler.js';
import { createApp } from './http/app.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Loads monitors from a JSON file into an empty database. Entries may carry
// a fixed `id` so demo links stay stable across rebuilds.
export function seed(db, file, config) {
  if (allMonitors(db).length) return 0;
  const list = JSON.parse(readFileSync(file, 'utf8'));
  for (const { id, ...input } of list) {
    const { value, errors } = validateMonitor(input, config);
    if (errors) throw new Error(`Seed entry "${input.name}" is invalid: ${JSON.stringify(errors)}`);
    insertMonitor(db, value, id ? { id } : undefined);
  }
  return list.length;
}

export async function startServer(overrides = {}, { seedFile, db: givenDb, runCheck } = {}) {
  const config = loadConfig(process.env, overrides);
  assertSafeBinding(config);
  const db = givenDb ?? openDb(config.dbPath);
  if (seedFile) seed(db, seedFile, config);
  const scheduler = config.scheduler ? new Scheduler({ db, config, ...(runCheck ? { runCheck } : {}) }) : null;
  scheduler?.on('error', (err) => process.stderr.write(`${JSON.stringify({ level: 'error', msg: 'check failed', error: err.stack })}\n`));
  const app = createApp({ db, config, scheduler, publicDir: config.publicDir ?? join(ROOT, 'public') });
  const server = http.createServer(app.handle);
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  scheduler?.start();
  const { port } = server.address();
  const close = async () => {
    await scheduler?.stop();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    if (!givenDb) db.close();
  };
  return { server, app, db, config, scheduler, port, url: `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${port}`, close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--seed');
  const seedFile = i > -1 ? process.argv[i + 1] : process.env.AHM_SEED;
  try {
    const s = await startServer({}, { seedFile });
    process.stdout.write(`${JSON.stringify({ level: 'info', msg: 'listening', url: s.url, auth: s.config.apiKey ? 'api-key' : 'none (loopback only)', private_targets: s.config.allowPrivateTargets })}\n`);
    let stopping = false;
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.on(sig, async () => {
        if (stopping) return;
        stopping = true;
        process.stdout.write(`${JSON.stringify({ level: 'info', msg: 'shutting down', signal: sig })}\n`);
        await s.close();
        process.exit(0);
      });
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
