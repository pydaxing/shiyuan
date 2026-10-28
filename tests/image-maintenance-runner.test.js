import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const execute = promisify(execFile);
async function fixture(context, failOnce = false) {
  const directory = await mkdtemp(join(tmpdir(), 'image-maintenance-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'output');
  const log = join(directory, 'calls.jsonl');
  const env = { ...process.env, TCB_CLI: resolve('tests/fixtures/image-maintenance-cli.cjs'), IMAGE_JOB_TEST_LOG: log, ...(failOnce ? { IMAGE_JOB_TEST_FAILURE: join(directory, 'failure') } : {}) };
  return {
    run: live => execute(process.execPath, ['scripts/prewarm-image-delivery.mjs', '--output', output, ...(live ? ['--live'] : [])], { env, timeout: 20000 }),
    read: async name => JSON.parse(await readFile(join(output, name), 'utf8')),
    calls: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
    output,
  };
}

test('historical thumbnail plan is read-only; live batches checkpoint and a completed rerun does not write', async context => {
  const job = await fixture(context);
  await job.run(false);
  assert.deepEqual((await job.calls()).map(call => call.type), ['QUERY']);
  await job.run(true);
  assert.equal((await job.read('checkpoint.json')).completed.length, 8);
  const calls = await job.calls();
  assert.equal(calls.filter(call => call.type === 'INVOKE').length, 3);
  assert.ok(calls.filter(call => call.type === 'INVOKE').every(call => call.fileIds.length <= 3));
  assert.equal((await stat(join(job.output, 'credentials.json'))).mode & 0o777, 0o600);
  await job.run(true);
  assert.equal((await job.calls()).length, calls.length);
});

test('historical thumbnail failures remain resumable and retry only the failed image', async context => {
  const job = await fixture(context, true);
  await assert.rejects(job.run(true), error => /仍有 1 张失败/.test(error.stderr));
  assert.equal((await job.read('checkpoint.json')).completed.length, 7);
  await job.run(true);
  const checkpoint = await job.read('checkpoint.json');
  assert.equal(checkpoint.completed.length, 8);
  assert.deepEqual(checkpoint.failures, []);
  assert.deepEqual((await job.calls()).filter(call => call.type === 'INVOKE').at(-1).fileIds, ['cloud://test/photo-0']);
});
