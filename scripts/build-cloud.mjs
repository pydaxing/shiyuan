import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('cloudfunctions/kitchen', { recursive: true });
await build({ entryPoints: ['server/wechat.mjs'], bundle: true, platform: 'node', target: 'node18', format: 'cjs', outfile: 'cloudfunctions/kitchen/index.js', external: ['wx-server-sdk', 'sharp', '@cloudbase/node-sdk'] });
await writeFile('cloudfunctions/kitchen/package.json', JSON.stringify({ name: 'shiyuan-kitchen-cloud', version: '1.0.0', main: 'index.js', dependencies: { 'wx-server-sdk': '4.0.2', '@cloudbase/node-sdk': '3.17.2', sharp: '0.34.3', '@img/sharp-linux-x64': '0.34.3', '@img/sharp-libvips-linux-x64': '1.2.0' } }, null, 2));
await writeFile('cloudfunctions/kitchen/config.json', JSON.stringify({ permissions: { openapi: [] }, timeout: 60, memorySize: 256 }, null, 2));
await mkdir('cloudfunctions/meal-diary-archive', { recursive: true });
await build({ entryPoints: ['server/wechat-meal-archive.mjs'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: 'cloudfunctions/meal-diary-archive/index.js', external: ['wx-server-sdk'] });
await writeFile('cloudfunctions/meal-diary-archive/package.json', JSON.stringify({ name: 'shiyuan-meal-diary-archive', version: '1.0.0', private: true, main: 'index.js', dependencies: { 'wx-server-sdk': '4.0.2' } }, null, 2));
await writeFile('cloudfunctions/meal-diary-archive/config.json', JSON.stringify({ permissions: { openapi: [] }, timeout: 60, memorySize: 256 }, null, 2));
console.log('云函数已构建：cloudfunctions/kitchen（使用 scripts/deploy-cloud-verified.mjs --live 打包 Linux 依赖并校验云端代码）');
