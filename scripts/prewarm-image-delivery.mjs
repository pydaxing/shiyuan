import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, rename, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { decodeDatabaseJson } from './admin-recipe-import.mjs';

const execute = promisify(execFile);
const live = process.argv.includes('--live');
const profilesOnly = process.argv.includes('--profiles-only');
const argument = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const concurrency = Number(argument('--concurrency') || 2);
assert.ok(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 3, '图片处理并发数仅支持 1–3');
let stopping = false;
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });
const output = path.resolve(argument('--output') || 'artifacts/deployment/image-performance-20260930');
const cli = process.env.TCB_CLI;
assert.ok(cli && path.isAbsolute(cli), '请设置已授权的官方 TCB_CLI 绝对路径');
const config = JSON.parse(await readFile('cloudbaserc.json', 'utf8'));
await mkdir(output, { recursive: true, mode: 0o700 });
const lockPath = path.join(output, 'running.lock');
const lock = await open(lockPath, 'wx');
const read = async name => JSON.parse(await readFile(path.join(output, name), 'utf8'));
const optional = name => read(name).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
async function save(name, value) {
  const destination = path.join(output, name);
  await writeFile(`${destination}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(`${destination}.tmp`, destination);
}
async function call(args) {
  const { stdout } = await execute(process.execPath, [cli, ...args, '--env-id', config.envId, '--json'], { timeout: 150000, maxBuffer: 8000000 });
  const response = JSON.parse(stdout.slice(stdout.indexOf('{')));
  if (response.error || response.Error) throw new Error('云开发调用失败，请检查授权及本地回执');
  return response;
}
async function database(collection, type, command) {
  const result = await call(['db', 'nosql', 'execute', '--command', JSON.stringify([{ TableName: collection, CommandType: type, Command: JSON.stringify(command) }])]);
  assert.equal(result.data?.results?.length, 1, '数据库没有返回有效结果');
  const response = result.data.results[0];
  if (type === 'QUERY') return decodeDatabaseJson(response);
  const rows = Array.isArray(response) ? response : [response];
  assert.equal(rows.length, 1, '数据库没有返回单个更新回执');
  assert.equal(decodeDatabaseJson(rows[0].ok), 1, '图片任务状态更新失败');
  assert.ok(!rows[0].writeErrors?.length && !rows[0].writeConcernError, '图片任务状态未完整保存');
  assert.equal(decodeDatabaseJson(rows[0].n), 1, '图片任务状态更新数量不符');
  return rows[0];
}
try {
  let plan = await optional('plan.json');
  if (!plan) {
    const fileIds = [];
    let after = '';
    while (true) {
      const rows = await database('media', 'QUERY', { find: 'media', filter: { confirmed: true, ...(profilesOnly ? { profile: true } : {}), ...(after ? { _id: { $gt: after } } : {}) }, projection: { _id: 1, fileId: 1 }, sort: { _id: 1 }, limit: 100 });
      assert.ok(Array.isArray(rows));
      for (const row of rows) if (typeof row.fileId === 'string' && row.fileId.startsWith('cloud://')) fileIds.push(row.fileId);
      if (rows.length < 100) break;
      assert.notEqual(after, rows.at(-1)._id, '数据库游标未前进');
      after = rows.at(-1)._id;
    }
    const unique = [...new Set(fileIds)];
    plan = { environment: config.envId, profilesOnly, createdAt: new Date().toISOString(), jobs: [] };
    for (let offset = 0; offset < unique.length; offset += 500) plan.jobs.push({ id: `image-job-${randomUUID().replaceAll('-', '')}`, fileIds: unique.slice(offset, offset + 500) });
    await save('plan.json', plan);
  }
  assert.equal(plan.environment, config.envId, '不能跨环境恢复图片任务');
  assert.equal(Boolean(plan.profilesOnly), profilesOnly, '不能更改已有图片任务范围');
  const total = plan.jobs.reduce((count, job) => count + job.fileIds.length, 0);
  console.log(JSON.stringify({ live, total, jobs: plan.jobs.length, output, changes: '仅生成私有缩略图；不修改菜品、头像引用或原图' }));
  if (live) {
    const secrets = await optional('credentials.json') || {};
    const checkpoint = await optional('checkpoint.json') || { completed: [], failures: [] };
    const completed = new Set(checkpoint.completed);
    const failures = new Map(checkpoint.failures.map(entry => [entry.fileId, entry]));
    let checkpointQueue = Promise.resolve();
    const persistProgress = () => {
      checkpointQueue = checkpointQueue.then(() => save('checkpoint.json', { completed: [...completed], failures: [...failures.values()], total, verifiedAt: new Date().toISOString() }));
      return checkpointQueue;
    };
    for (const job of plan.jobs) {
      if (stopping) throw new Error('图片处理已安全停止，已保存断点');
      const remaining = job.fileIds.filter(fileId => !completed.has(fileId));
      if (!remaining.length) continue;
      const token = secrets[job.id] ||= randomBytes(32).toString('hex');
      await save('credentials.json', secrets);
      const document = { kind: 'image_delivery_job_v1', state: 'active', tokenHash: createHash('sha256').update(token).digest('hex'), fileIds: job.fileIds, expiresAt: Date.now() + 86400000 };
      await database('imports', 'UPDATE', { update: 'imports', updates: [{ q: { _id: job.id }, u: { $set: document }, upsert: true }] });
      let nextOffset = 0;
      let failed;
      await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
        while (!failed && !stopping && nextOffset < remaining.length) {
          const offset = nextOffset;
          nextOffset += 3;
          const batch = remaining.slice(offset, offset + 3);
          const filename = `invoke-${worker}.json`;
          try {
            await save(filename, { action: 'prepareImageDelivery', jobId: job.id, token, fileIds: batch });
            const response = await call(['fn', 'invoke', config.functions[0].name, '-d', `@${path.join(output, filename)}`]);
            await save(`last-response-${worker}.json`, response);
            const raw = response.data?.Result?.RetMsg ?? response.data?.result?.RetMsg ?? response.data?.RetMsg ?? response.data;
            const envelope = typeof raw === 'string' ? JSON.parse(raw) : raw;
            assert.equal(envelope?.ok, true, `图片维护失败：${envelope?.code || '请检查函数返回格式'}`);
            const result = envelope.data;
            assert.ok(Array.isArray(result.completed) && Array.isArray(result.failures), '图片维护返回格式无效');
            assert.deepEqual([...result.completed, ...result.failures.map(item => item.fileId)].sort(), [...batch].sort(), '图片批次回执不完整');
            for (const fileId of result.completed) { completed.add(fileId); failures.delete(fileId); }
            for (const failure of result.failures) failures.set(failure.fileId, failure);
            await persistProgress();
            console.log(JSON.stringify({ completed: completed.size, total, failures: failures.size }));
            if (result.failures.some(failure => failure.code === 'IMAGE_DELIVERY_CONFIG')) throw new Error('尚未启用已验证的私有图片直传，请先按部署文档配置');
          } catch (error) { failed ||= error; }
          finally { await unlink(path.join(output, filename)).catch(() => {}); }
        }
      }));
      if (failed) throw failed;
      if (stopping) throw new Error('图片处理已安全停止，已保存断点');
      if (job.fileIds.every(fileId => completed.has(fileId))) await database('imports', 'UPDATE', { update: 'imports', updates: [{ q: { _id: job.id }, u: { $set: { state: 'completed', expiresAt: Date.now() } } }] });
    }
    await unlink(path.join(output, 'invoke.json')).catch(() => {});
    if (failures.size) throw new Error(`仍有 ${failures.size} 张失败；已保存断点，修复后重复同一命令即可`);
    assert.equal(completed.size, total);
    console.log(JSON.stringify({ done: true, completed: completed.size, total }));
  }
} finally { await lock.close(); await unlink(lockPath); }
