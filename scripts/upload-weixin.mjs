import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadEnv } from 'vite';
import { checkReleaseVersion, validateCompiledVersion } from './check-release-version.mjs';
import { verifyPreviewTarget } from './preview-weixin.mjs';
import { confirmedUploadResult } from './weixin-upload-result.mjs';

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  assert.ok(['--published-version', '--desc', '--output'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--') && options[args[i]] === undefined, '参数无效：需 --published-version、--desc，可选 --output');
  options[args[i]] = args[i + 1];
}
assert.ok(options['--published-version'], '先核实微信后台线上版本，再传入 --published-version；不能从本地版本猜测');
assert.ok(options['--desc']?.trim(), '请提供本次上传说明 --desc');
const root = process.cwd();
const version = await checkReleaseVersion(root, options['--published-version']);
const target = await verifyPreviewTarget(root, { ...loadEnv('production', root, ''), ...process.env });
validateCompiledVersion(await readFile(join(target.project, 'miniprogram/common/vendor.js'), 'utf8'), version);
const output = resolve(options['--output'] || `artifacts/uploads/${version.version}-${Date.now()}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const startedAt = new Date().toISOString();
console.log(JSON.stringify({ uploading: version.version, previousPublishedVersion: version.publishedVersion, project: target.project }));
let raw;
try {
  raw = execFileSync(process.env.WECHAT_IDE_CLI || '/usr/local/bin/wechatide', ['-c', 'Codex', 'upload', '--project', target.project, '--upload-version', version.version, '--desc', options['--desc']], { encoding: 'utf8', timeout: 180000, maxBuffer: 262144, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (error) {
  await writeFile(join(output, 'upload-failure.private.txt'), `${error.stdout || ''}\n${error.stderr || ''}`, { mode: 0o600 });
  throw new Error(`微信上传命令未成功，退出状态 ${error.status ?? '未知'}；详情已保存到 ${output}`);
}
await writeFile(join(output, 'upload-response.private.json'), raw, { mode: 0o600 });
const response = JSON.parse(raw.slice(raw.indexOf('{')));
if (response.result?.taskId && response.result.status !== 'success') {
  await writeFile(join(output, 'upload-pending.json'), JSON.stringify({ taskId: response.result.taskId, status: response.result.status, uploaded: false, reviewSubmitted: false }, null, 2), { mode: 0o600 });
}
const completed = confirmedUploadResult(response);
const receipt = { ...version, ...target, description: options['--desc'], startedAt, completedAt: new Date().toISOString(), uploaded: true, uploadBytes: completed.info?.size?.total, reviewSubmitted: false, productionPublished: false };
await writeFile(join(output, 'upload-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(receipt));
