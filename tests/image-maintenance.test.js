import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createImageMaintenance } from '../server/image-maintenance.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function fixture() {
  const token = 'b'.repeat(64);
  const jobId = `image-job-${'a'.repeat(32)}`;
  const fileIds = ['cloud://test/photo-1', 'cloud://test/photo-2'];
  const job = { kind: 'image_delivery_job_v1', state: 'active', tokenHash: hash(token), expiresAt: 2000, fileIds };
  const rows = new Map([[`imports:${jobId}`, job], ...fileIds.map(fileId => [`media:${hash(fileId)}`, { confirmed: true, fileId, encryptionKey: 'private' }])]);
  const calls = [];
  const prepare = async (fileId, record, variant) => { calls.push({ fileId, variant }); };
  return { job, rows, calls, request: { jobId, token, fileIds }, run: createImageMaintenance({ now: () => 1000, repository: { get: async (collection, id) => rows.get(`${collection}:${id}`) }, prepare }) };
}

test('only a bounded administrator-created manifest can prewarm thumbnails, never originals', async () => {
  const app = fixture();
  assert.deepEqual(await app.run(app.request), { completed: app.request.fileIds, failures: [] });
  assert.deepEqual(app.calls.map(call => call.variant), ['card', 'detail', 'card', 'detail']);
  assert.equal(app.job.state, 'active');
});

test('existing bounded variants can copy concurrently, while source images remain serialized', async () => {
  const app = fixture();
  let active = 0;
  let maximum = 0;
  const run = createImageMaintenance({ now: () => 1000, repository: { get: async (collection, id) => app.rows.get(`${collection}:${id}`) }, prepare: async () => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active -= 1;
  } });
  await run(app.request);
  assert.equal(maximum, 1);
  for (const fileId of app.request.fileIds) app.rows.get(`media:${hash(fileId)}`).variants = { card: { formatVersion: 1 }, detail: { formatVersion: 1 } };
  maximum = 0;
  assert.deepEqual((await run(app.request)).completed, app.request.fileIds);
  assert.equal(maximum, 2);
});

test('ordinary mini-program callers, guessed tokens, expired jobs and off-manifest images are rejected', async () => {
  const app = fixture();
  await assert.rejects(app.run(app.request, { OPENID: 'client-user' }), { code: 'FORBIDDEN' });
  await assert.rejects(app.run({ ...app.request, token: 'c'.repeat(64) }), { code: 'FORBIDDEN' });
  await assert.rejects(app.run({ ...app.request, fileIds: ['cloud://test/unlisted'] }), { code: 'FORBIDDEN' });
  await assert.rejects(app.run({ ...app.request, fileIds: Array(4).fill(app.request.fileIds[0]) }), { code: 'FORBIDDEN' });
  app.job.expiresAt = 1000;
  await assert.rejects(app.run(app.request), { code: 'FORBIDDEN' });
  assert.equal(app.calls.length, 0);
});

test('maintenance jobs reject missing expirations and non-array allowlists', async () => {
  const app = fixture();
  for (const expiresAt of [undefined, NaN, Infinity, '2000']) {
    app.job.expiresAt = expiresAt;
    await assert.rejects(app.run(app.request), { code: 'FORBIDDEN' });
  }
  app.job.expiresAt = 2000;
  app.job.fileIds = app.request.fileIds.join(',');
  await assert.rejects(app.run(app.request), { code: 'FORBIDDEN' });
  assert.equal(app.calls.length, 0);
});

test('missing media is reported per file without blocking valid files or leaking key material', async () => {
  const app = fixture();
  app.rows.delete(`media:${hash(app.request.fileIds[0])}`);
  const result = await app.run(app.request);
  assert.deepEqual(result.completed, [app.request.fileIds[1]]);
  assert.equal(result.failures[0].code, 'IMAGE_REUPLOAD');
  assert.equal(JSON.stringify(result).includes('private'), false);
});


test('historical profile images also get an avatar thumbnail without changing their references', async () => {
  const app = fixture();
  const record = app.rows.get(`media:${hash(app.request.fileIds[0])}`);
  record.profile = true;
  const before = structuredClone(record);
  assert.deepEqual((await app.run(app.request)).failures, []);
  assert.deepEqual(app.calls.map(call => call.variant), ['card', 'detail', 'avatar', 'card', 'detail']);
  assert.deepEqual(record, before);
});
