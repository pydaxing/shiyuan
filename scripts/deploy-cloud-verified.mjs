import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

assert.equal(process.argv[2], '--live', '传入 --live 才会更新实际云函数');
const cli = process.env.TCB_CLI || execFileSync('which', ['tcb'], { encoding: 'utf8' }).trim();
const config = JSON.parse(await readFile('cloudbaserc.json', 'utf8'));
const functionName = config.functions[0].name;
const argument = name => { const position = process.argv.indexOf(name); return position >= 0 ? process.argv[position + 1] : undefined; };
const source = resolve(argument('--source') || 'cloudfunctions/kitchen');
const code = await readFile(join(source, 'index.js'), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const expected = hash(code);
const privateImages = process.argv.includes('--private-images');
const output = resolve(argument('--output') || 'artifacts/deployment/image-delivery');
await mkdir(output, { recursive: true, mode: 0o700 });
const temporary = await mkdtemp(join(tmpdir(), 'kitchen-deploy-'));
async function call(args) {
  const argsPath = join(temporary, 'cli-args.json');
  await writeFile(argsPath, JSON.stringify([...args, '--env-id', config.envId, '--json']), { mode: 0o600 });
  const result = execFileSync(process.execPath, ['-e', 'const fs=require("node:fs");const cli=process.argv[1];process.argv=[process.execPath,cli,...JSON.parse(fs.readFileSync(process.argv[2],"utf8"))];require(cli);', cli, argsPath], { encoding: 'utf8', timeout: 180000, maxBuffer: 3000000 });
  const parsed = JSON.parse(result.slice(result.indexOf('{')));
  if (parsed.error || parsed.Error || parsed.Response?.Error) throw new Error(JSON.stringify(parsed));
  return parsed.data || parsed;
}
try {
  if (privateImages) {
    const permissions = await call(['storage', 'rules', 'get']);
    assert.equal(permissions.acl, 'PRIVATE', '须确认生产存储为私有权限，不能公开家庭图片');
    await writeFile(join(output, 'storage-verified.json'), `${JSON.stringify({ environment: config.envId, acl: permissions.acl, verifiedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  }
  const previous = await call(['fn', 'detail', functionName]);
  await writeFile(join(output, `backend-before-${Date.now()}.json`), `${JSON.stringify(previous, null, 2)}\n`, { mode: 0o600 });
  assert.ok(previous.CodeInfo, '未取得线上代码备份，停止部署');
  const baselineHash = hash(previous.CodeInfo);
  if (argument('--expected-baseline-sha')) assert.equal(baselineHash, argument('--expected-baseline-sha'), '线上版本已变化，停止覆盖');
  const zip = join(temporary, 'function.zip');
  const packaged = join(temporary, functionName);
  await mkdir(packaged);
  for (const file of ['index.js', 'package.json', 'package-lock.json', 'config.json']) await copyFile(join(source, file), join(packaged, file));
  execFileSync('npm', ['ci', '--ignore-scripts', '--omit=dev', '--os=linux', '--cpu=x64', '--libc=glibc', '--force', '--registry=https://registry.npmjs.org/'], { cwd: packaged, stdio: 'inherit', timeout: 240000 });
  const native = await readFile(join(packaged, 'node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64.node'));
  assert.equal(native.subarray(0, 4).toString('hex'), '7f454c46', '必须打包 Linux ELF 图片库，不能上传 Mac 库');
  execFileSync('/usr/bin/zip', ['-qr', zip, '.'], { cwd: packaged });
  const bytes = await readFile(zip);
  assert.ok(bytes.length < 20 * 1024 * 1024, '完整云函数压缩包超过接口上限');
  const latest = await call(['fn', 'detail', functionName]);
  assert.equal(latest.Status, 'Active', '线上函数正在变更，停止覆盖');
  assert.equal(hash(latest.CodeInfo || ''), baselineHash, '打包期间线上代码已变化，停止覆盖');
  await call(['api', 'scf', 'UpdateFunctionCode', '--api-version', '2018-04-16', '--body', JSON.stringify({ FunctionName: functionName, Namespace: config.envId, Handler: 'index.main', CodeSource: 'ZipFile', ZipFile: bytes.toString('base64'), InstallDependency: 'FALSE', Publish: 'FALSE' })]);
  const deadline = Date.now() + 240000;
  let verified = false;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const deployed = await call(['fn', 'detail', functionName]);
    console.log(JSON.stringify({ status: deployed.Status, codeMatches: hash(deployed.CodeInfo || '') === expected }));
    if (deployed.Status === 'Active' && hash(deployed.CodeInfo || '') === expected) {
      const receipt = { functionName, environment: config.envId, sha256: expected, codeSize: deployed.CodeSize, zipBytes: bytes.length, bundledLinuxDependencies: true, modifiedAt: deployed.ModTime, verifiedAt: new Date().toISOString() };
      await writeFile(join(output, 'backend-deployed.json'), `${JSON.stringify(receipt, null, 2)}\n`);
      console.log(JSON.stringify(receipt));
      verified = true;
      break;
    }
    if (/Failed|Error/i.test(deployed.Status || '')) throw new Error(JSON.stringify({ status: deployed.Status, reasons: deployed.StatusReasons }));
    if (Date.now() + 5000 >= deadline) throw new Error('部署未通过代码校验，不应发布新版客户端');
  }
  assert.ok(verified, '部署未通过代码校验，不应发布新版客户端');
  if (privateImages) {
    const current = await call(['fn', 'detail', functionName]);
    const variables = current.Environment?.Variables || [];
    if (!variables.some(variable => variable.Key === 'IMAGE_DELIVERY_PRIVATE' && variable.Value === '1')) {
      const next = [...variables.filter(variable => variable.Key !== 'IMAGE_DELIVERY_PRIVATE'), { Key: 'IMAGE_DELIVERY_PRIVATE', Value: '1' }];
      await call(['api', 'scf', 'UpdateFunctionConfiguration', '--api-version', '2018-04-16', '--body', JSON.stringify({ FunctionName: functionName, Namespace: config.envId, Environment: { Variables: next } })]);
    }
    const deadline = Date.now() + 180000;
    let enabled = false;
    while (Date.now() < deadline) {
      const deployed = await call(['fn', 'detail', functionName]);
      if (deployed.Status === 'Active' && hash(deployed.CodeInfo || '') === expected && deployed.Environment?.Variables?.some(variable => variable.Key === 'IMAGE_DELIVERY_PRIVATE' && variable.Value === '1')) { enabled = true; break; }
      if (/Failed|Error/i.test(deployed.Status || '')) throw new Error('图片直传配置未生效，请检查云函数状态');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    assert.ok(enabled, '图片直传配置未通过验证');
    await writeFile(join(output, 'private-delivery-enabled.json'), `${JSON.stringify({ environment: config.envId, functionName, enabled, verifiedAt: new Date().toISOString() }, null, 2)}\n`);
    console.log(JSON.stringify({ privateDeliveryEnabled: true }));
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
