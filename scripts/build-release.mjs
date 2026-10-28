import { readFile, writeFile, cp, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { loadEnv } from 'vite';

const config = { ...loadEnv('production', process.cwd(), ''), ...process.env };
if (!/^wx[0-9a-f]{16}$/.test(config.WEIXIN_APPID || '') || config.WEIXIN_APPID === 'wx064ea991e5e41495') throw new Error('请在 .env.production 配置正式 WEIXIN_APPID，不能使用当前测试号');
if (!/^[\w-]{6,100}$/.test(config.VITE_CLOUD_ENV || '')) throw new Error('请在 .env.production 配置实际 VITE_CLOUD_ENV');
const cloudFunction = config.VITE_CLOUD_FUNCTION || 'kitchen';
if (!/^[a-zA-Z][\w-]{0,58}[a-zA-Z0-9]$/.test(cloudFunction)) throw new Error('VITE_CLOUD_FUNCTION 云函数名称无效');
const cloudLock = JSON.parse(await readFile('cloudfunctions/kitchen/package-lock.json', 'utf8'));
if (Object.values(cloudLock.packages).some(entry => entry.resolved && !entry.resolved.startsWith('https://registry.npmjs.org/'))) throw new Error('云函数依赖锁包含非公开源，不能部署到云端');
for (const script of ['test', 'build:cloud', 'build:weixin']) {
  const result = spawnSync('npm', ['run', script], { stdio: 'inherit', env: { ...process.env, ...config, VITE_DATA_MODE: 'cloud' } });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
const path = 'dist/build/mp-weixin/project.config.json';
const project = JSON.parse(await readFile(path, 'utf8'));
project.appid = config.WEIXIN_APPID;
await writeFile(path, JSON.stringify(project, null, 2));
Object.assign(project, { miniprogramRoot: 'miniprogram/', cloudfunctionRoot: 'cloudfunctions/' });
await rm('dist/release', { recursive: true, force: true });
await mkdir('dist/release', { recursive: true });
await cp('dist/build/mp-weixin', 'dist/release/miniprogram', { recursive: true });
await rm('dist/release/miniprogram/project.config.json', { force: true });
await writeFile('dist/release/project.config.json', JSON.stringify(project, null, 2));
await mkdir('dist/release/cloudfunctions', { recursive: true });
await cp('cloudfunctions/kitchen', `dist/release/cloudfunctions/${cloudFunction}`, { recursive: true, filter: source => !source.split('/').includes('node_modules') });
console.log('正式云端构建就绪：dist/release。尚未部署云函数或发布小程序；请按部署指南配置数据库权限并验收。');
