import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv } from 'vite';

export async function verifyPreviewTarget(root, config) {
  assert.match(config.WEIXIN_APPID || '', /^wx[0-9a-f]{16}$/, '缺少正式 AppID，请先配置 .env.production');
  assert.notEqual(config.WEIXIN_APPID, 'wx064ea991e5e41495', '测试 AppID 不能生成正式云端预览');
  const project = resolve(root, 'dist/release');
  const settings = JSON.parse(await readFile(join(project, 'project.config.json'), 'utf8'));
  const backend = JSON.parse(await readFile(join(root, 'cloudbaserc.json'), 'utf8'));
  assert.equal(settings.appid, config.WEIXIN_APPID, '预览包 AppID 不匹配，请重新运行 npm run build:release');
  assert.equal(settings.miniprogramRoot, 'miniprogram/', '只能预览 dist/release 的正式目录布局');
  assert.equal(settings.cloudfunctionRoot, 'cloudfunctions/', '正式包云函数目录不正确');
  assert.ok(config.VITE_CLOUD_ENV && backend.envId === config.VITE_CLOUD_ENV, '前端与后端云环境不一致');
  const functionName = config.VITE_CLOUD_FUNCTION || 'kitchen';
  assert.ok(backend.functions?.some(entry => entry.name === functionName), '前端与后端云函数名称不一致');
  const client = await readFile(join(project, 'miniprogram/services/cloud.js'), 'utf8');
  assert.ok(client.includes(JSON.stringify(config.VITE_CLOUD_ENV)) && client.includes(JSON.stringify(functionName)), '预览包的云配置已过期，请重新构建正式包');
  assert.match(client, /exports\.cloudMode\s*=\s*(?:!0|true)\s*[,;]/, '本地演示包不能作为云端手机预览');
  return { project, appid: settings.appid, environment: config.VITE_CLOUD_ENV, functionName };
}

async function preview() {
  const root = process.cwd();
  const config = { ...loadEnv('production', root, ''), ...process.env };
  const target = await verifyPreviewTarget(root, config);
  const outputIndex = process.argv.indexOf('--output');
  assert.ok(outputIndex < 0 || process.argv[outputIndex + 1], '--output 需要目录路径');
  const output = resolve(root, outputIndex < 0 ? 'artifacts/deployment/wechat-preview' : process.argv[outputIndex + 1]);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const cli = process.env.WECHAT_DEVTOOLS_CLI || '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';
  console.log(JSON.stringify({ verifiedTarget: target }));
  execFileSync(cli, ['preview', '--project', target.project, '--qr-format', 'image', '--qr-output', join(output, 'wechat-preview.jpg'), '--info-output', join(output, 'wechat-preview-info.json')], { stdio: 'inherit', timeout: 180000 });
  await writeFile(join(output, 'preview-target.json'), `${JSON.stringify({ ...target, generatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  console.log(`微信预览二维码：${join(output, 'wechat-preview.jpg')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await preview();
