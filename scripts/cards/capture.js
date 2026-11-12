// Screenshot helper for the README images. Drives headless Chrome over the
// DevTools protocol with Node's built-in WebSocket (no Puppeteer), so it can
// emulate phone viewports that `chrome --screenshot` cannot go down to.
//
//   node scripts/cards/capture.js <chrome.exe> <jobs.json>
//   jobs.json: [{ "url": "...", "out": "abs.png", "width": 1440, "height": 900, "scale": 1, "mobile": false, "wait": 3000 }]
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [chromePath, jobsFile] = process.argv.slice(2);
const jobs = JSON.parse(readFileSync(jobsFile, 'utf8'));
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'ahm-capture-'));
const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let version;
for (let i = 0; i < 50 && !version; i++) {
  await sleep(200);
  version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null);
}
if (!version) throw new Error('Chrome did not start');

const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

try {
  for (const job of jobs) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width: job.width, height: job.height, deviceScaleFactor: job.scale ?? 1, mobile: !!job.mobile }, sessionId);
    if (job.mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true }, sessionId);
    await send('Page.navigate', { url: job.url }, sessionId);
    await sleep(job.wait ?? 3000);
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
    writeFileSync(job.out, Buffer.from(data, 'base64'));
    process.stdout.write(`${job.out}\n`);
    await send('Target.closeTarget', { targetId });
  }
} finally {
  ws.close();
  chrome.kill();
}
