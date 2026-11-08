import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, mkdir, writeFile, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { deployMealArchive, ARCHIVE_DEPLOYMENT } from './meal-archive-deployment.mjs';

assert.equal(process.argv[2], '--live', '必须显式传入 --live 才部署独立自动归档函数');
const argument = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
assert.ok(argument('--output') && isAbsolute(argument('--output')), '--output 必须是仓库外私有绝对路径');
const output = resolve(argument('--output'));
const rel = relative(process.cwd(), output);
assert.ok(rel.startsWith('..') || isAbsolute(rel), '私有备份和触发令牌不能写入仓库');
await mkdir(output, { recursive: true, mode: 0o700 }); await chmod(output, 0o700);
const cli = process.env.TCB_CLI || execFileSync('which', ['tcb'], { encoding: 'utf8' }).trim();
const config = JSON.parse(await readFile('cloudbaserc.json', 'utf8'));
assert.ok(!config.functions.some(fn => fn.name === ARCHIVE_DEPLOYMENT.functionName), '独立定时函数不能加入主函数批量部署配置');
const source = resolve(argument('--source') || 'cloudfunctions/meal-diary-archive');
const code = await readFile(join(source, 'index.js'), 'utf8');
const tokenFile = resolve(argument('--token-file') || join(output, 'trigger-secret.json'));
const tokenRelative = relative(process.cwd(), tokenFile);
assert.ok(tokenRelative.startsWith('..') || isAbsolute(tokenRelative), '触发令牌必须保存在仓库外');
let token;
try { token = JSON.parse(await readFile(tokenFile, 'utf8')).token; }
catch (error) {
  if (error.code !== 'ENOENT') throw new Error('无法读取私有触发令牌');
  token = randomBytes(32).toString('hex');
  await writeFile(tokenFile, `${JSON.stringify({ token })}\n`, { mode: 0o600, flag: 'wx' });
}
await chmod(tokenFile, 0o600);
const temporary = await mkdtemp(join(tmpdir(), 'shiyuan-archive-deploy-')); await chmod(temporary, 0o700);
let apiNumber = 0;
try {
  const packaged = join(temporary, 'package'); await mkdir(packaged);
  for (const file of ['index.js', 'package.json', 'package-lock.json', 'config.json']) await copyFile(join(source, file), join(packaged, file));
  const lock = JSON.parse(await readFile(join(packaged, 'package-lock.json'), 'utf8'));
  assert.ok(!Object.values(lock.packages).some(entry => entry.resolved && !entry.resolved.startsWith('https://registry.npmjs.org/')), '依赖锁包含非公开来源');
  const npmLog = execFileSync('npm', ['ci', '--ignore-scripts', '--omit=dev', '--registry=https://registry.npmjs.org/'], { cwd: packaged, encoding: 'utf8', timeout: 240000, maxBuffer: 3000000 });
  await writeFile(join(output, 'dependencies.log'), npmLog, { mode: 0o600 });
  const zipPath = join(temporary, 'function.zip'); execFileSync('/usr/bin/zip', ['-qr', zipPath, '.'], { cwd: packaged });
  const zip = await readFile(zipPath);
  const receipt = await deployMealArchive({ namespace: config.envId, code, zip, token, expectedBaseline: argument('--expected-baseline-sha'), api, wait: ms => new Promise(resolve => setTimeout(resolve, ms)), evidence: (name, value) => writeFile(join(output, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }) });
  console.log(JSON.stringify(receipt));
} finally { await rm(temporary, { recursive: true, force: true }); }

async function api(action, body) {
  const stem = `api-${String(++apiNumber).padStart(3, '0')}`;
  const argsPath = join(temporary, `${stem}.json`);
  await writeFile(argsPath, JSON.stringify(['api', 'scf', action, '--api-version', '2018-04-16', '--body', JSON.stringify(body), '--env-id', config.envId, '--json']), { mode: 0o600 });
  let raw;
  try {
    raw = execFileSync(process.execPath, ['-e', 'const fs=require("node:fs");const cli=process.argv[1];process.argv=[process.execPath,cli,...JSON.parse(fs.readFileSync(process.argv[2],"utf8"))];require(cli);', cli, argsPath], { encoding: 'utf8', timeout: 180000, maxBuffer: 5000000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    await writeFile(join(output, `${stem}-failure.log`), `${error.stdout || ''}\n${error.stderr || ''}`, { mode: 0o600 });
    throw new Error(`${action} 调用失败；详细回执已保存在私有目录，触发器不会主动开启`);
  }
  await writeFile(join(output, `${stem}.log`), raw, { mode: 0o600 });
  let parsed;
  try { parsed = JSON.parse(raw.slice(raw.indexOf('{'))); } catch { throw new Error(`${action} 回执无法解析，停止部署`); }
  if (parsed.error || parsed.Error || parsed.Response?.Error) throw new Error(`${action} 返回云端错误，详细回执见私有目录`);
  return parsed.data?.Response || parsed.data || parsed.Response || parsed;
}
