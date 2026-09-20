#!/usr/bin/env node
// Tiny dependency-free static server for Pentagon Ludo.
// Usage: node ludo/serve.mjs [port]      (default 8080, or $PORT)
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Map a request path to a file inside ROOT, or null if it escapes the root. */
function resolvePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.endsWith('/')) decoded += 'index.html';
  // Refuse any ".." segment outright instead of silently collapsing it, so a
  // traversal attempt is answered with 403 rather than a neighbouring file.
  if (decoded.split(/[/\\]/).some((part) => part === '..')) return null;
  const full = join(ROOT, normalize(decoded));
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null; // belt and braces
  return full;
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed');

  const file = resolvePath(req.url || '/');
  if (!file) return send(res, 403, 'Forbidden');

  try {
    let target = file;
    let info = await stat(target);
    if (info.isDirectory()) {
      target = join(target, 'index.html');
      info = await stat(target);
    }
    const type = MIME[extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': info.size,
      'cache-control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(target).pipe(res);
  } catch {
    send(res, 404, 'Not Found');
  }
});

server.listen(PORT, () => {
  process.stdout.write(`Pentagon Ludo on http://localhost:${PORT}/  (serving ${ROOT})\n`);
});
