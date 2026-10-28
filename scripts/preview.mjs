import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/build/h5/', import.meta.url));
const port = Number(process.env.PORT || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon' };
try { await fs.access(path.join(root, 'index.html')); } catch { console.error('请先执行 npm run build:web，再启动本地预览。'); process.exit(1); }

const server = http.createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const target = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!target.startsWith(root) || pathname.includes('\0')) { response.writeHead(403); response.end(); return; }
    const content = await fs.readFile(target);
    response.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch { response.writeHead(404); response.end('Not found'); }
});
server.on('error', (error) => { console.error(`无法启动预览：${error.message}`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`食愿本地预览：http://127.0.0.1:${port}/（仅本机可访问，Ctrl+C 停止）`));
