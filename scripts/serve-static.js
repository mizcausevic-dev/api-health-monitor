// Serves the built _site/ locally exactly as GitHub Pages would (static files
// only, no API), for previewing the snapshot: npm run preview:pages
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(process.argv[2] || '_site');
const port = Number(process.argv[3] || 8095);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

http
  .createServer((req, res) => {
    let path;
    try {
      path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      return res.writeHead(400).end('bad request');
    }
    let file = resolve(join(root, normalize(path)));
    if (file !== root && !file.startsWith(root + sep)) return res.writeHead(404).end();
    try {
      if (statSync(file).isDirectory()) file = join(file, 'index.html');
      statSync(file);
    } catch {
      return res.writeHead(404).end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    createReadStream(file).pipe(res);
  })
  .listen(port, '127.0.0.1', () => process.stdout.write(`static preview on http://127.0.0.1:${port}/\n`));
