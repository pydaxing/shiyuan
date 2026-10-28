import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyPreviewTarget } from '../scripts/preview-weixin.mjs';

const execute = promisify(execFile);
async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'shiyuan-release-preview-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const config = { WEIXIN_APPID: 'wx1111111111111111', VITE_CLOUD_ENV: 'cloud-test-environment', VITE_CLOUD_FUNCTION: 'kitchen-v2', VITE_DATA_MODE: 'cloud' };
  const project = { appid: config.WEIXIN_APPID, miniprogramRoot: 'miniprogram/', cloudfunctionRoot: 'cloudfunctions/', projectname: 'Preview fixture' };
  const backend = { envId: config.VITE_CLOUD_ENV, functions: [{ name: config.VITE_CLOUD_FUNCTION }] };
  const client = `exports.cloudMode=!0;exports.cloudEnvironment=${JSON.stringify(config.VITE_CLOUD_ENV)};exports.cloudFunction=${JSON.stringify(config.VITE_CLOUD_FUNCTION)};`;
  async function write(filename, content) {
    const destination = join(root, filename);
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, typeof content === 'string' ? content : JSON.stringify(content));
  }
  await write('dist/release/project.config.json', project);
  await write('dist/release/miniprogram/services/cloud.js', client);
  await write('cloudbaserc.json', backend);
  return { root, config, project, backend, client, write, verify: () => verifyPreviewTarget(root, config) };
}

test('cloud preview selects only the release project with matching production identity', async context => {
  const app = await fixture(context);
  const target = await app.verify();
  assert.equal(target.project, join(app.root, 'dist/release'));
  assert.equal(target.appid, app.config.WEIXIN_APPID);
  assert.equal(target.environment, app.config.VITE_CLOUD_ENV);
  assert.equal(target.functionName, app.config.VITE_CLOUD_FUNCTION);
});

test('a test-account project cannot produce a production cloud preview', async context => {
  const app = await fixture(context);
  await app.write('dist/release/project.config.json', { ...app.project, appid: 'wx064ea991e5e41495' });
  await assert.rejects(app.verify(), /AppID 不匹配/);
  app.config.WEIXIN_APPID = 'wx064ea991e5e41495';
  await assert.rejects(app.verify(), /测试 AppID/);
});

test('a flattened intermediate build cannot masquerade as the release project', async context => {
  const app = await fixture(context);
  await app.write('dist/release/project.config.json', { ...app.project, miniprogramRoot: './' });
  await assert.rejects(app.verify(), /正式目录布局/);
});

test('preview rejects a frontend targeting a different backend environment or function', async context => {
  const app = await fixture(context);
  await app.write('cloudbaserc.json', { ...app.backend, envId: 'another-environment' });
  await assert.rejects(app.verify(), /云环境不一致/);
  await app.write('cloudbaserc.json', { ...app.backend, functions: [{ name: 'another-function' }] });
  await assert.rejects(app.verify(), /云函数名称不一致/);
});

test('preview rejects stale compiled cloud settings', async context => {
  const app = await fixture(context);
  await app.write('dist/release/miniprogram/services/cloud.js', app.client.replace(app.config.VITE_CLOUD_ENV, 'previous-environment'));
  await assert.rejects(app.verify(), /云配置已过期/);
});

test('a local demo build is rejected even when it includes matching cloud names', async context => {
  const app = await fixture(context);
  await app.write('dist/release/miniprogram/services/cloud.js', app.client.replace('!0', '!1'));
  await assert.rejects(app.verify(), /本地演示包/);
});

test('production builds stamp both output layouts with the production AppID', async context => {
  const app = await fixture(context);
  await app.write('dist/build/mp-weixin/project.config.json', { appid: 'wx064ea991e5e41495', projectname: 'Preview fixture' });
  await app.write('dist/build/mp-weixin/services/cloud.js', app.client);
  await app.write('cloudfunctions/kitchen/package-lock.json', { packages: {} });
  await app.write('cloudfunctions/kitchen/index.js', 'exports.main = async () => ({});');
  await app.write('bin/npm', '#!/bin/sh\nexit 0\n');
  await chmod(join(app.root, 'bin/npm'), 0o700);
  await execute(process.execPath, [resolve('scripts/build-release.mjs')], { cwd: app.root, env: { ...process.env, ...app.config, PATH: `${join(app.root, 'bin')}:${process.env.PATH}` }, timeout: 20000 });
  const intermediate = JSON.parse(await readFile(join(app.root, 'dist/build/mp-weixin/project.config.json'), 'utf8'));
  assert.equal(intermediate.appid, app.config.WEIXIN_APPID);
  assert.equal(intermediate.miniprogramRoot, undefined);
  assert.equal((await app.verify()).appid, app.config.WEIXIN_APPID);
});
