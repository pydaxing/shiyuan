import http from 'node:http';
import { readFile } from 'node:fs/promises';

const routes = new Map([
  ['/', [new URL('./detached-sheet.html', import.meta.url), 'text/html; charset=utf-8']],
  ['/native', [new URL('./detached-sheet.html', import.meta.url), 'text/html; charset=utf-8']],
  ['/styles.css', [new URL('../../src/styles.css', import.meta.url), 'text/css; charset=utf-8']],
  ['/native.css', [new URL('../../dist/build/mp-weixin/app.wxss', import.meta.url), 'text/css; charset=utf-8']],
]);
http.createServer(async (request, response) => {
  const route = routes.get(request.url);
  if (!route) { response.writeHead(404); response.end(); return; }
  try {
    const content = await readFile(route[0], 'utf8');
    response.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-store' });
    response.end(request.url === '/native' ? content.replace('/styles.css', '/native.css') : content);
  } catch { response.writeHead(500); response.end(); }
}).listen(4191, '127.0.0.1', () => console.log('独立弹层复现：http://127.0.0.1:4191/'));
