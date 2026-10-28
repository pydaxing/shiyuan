import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAuthorizedImport } from '../server/authorized-import.mjs';
import { createApplication } from '../server/application.mjs';
import { memoryRepository } from './helpers/memory-repository.js';
import { sourceDigest, assertCompletedTasks, assertProcessAllowed, insertBatches, buildImportedPost } from '../scripts/bulk-publish-authorized.mjs';
import { buildStagedRecipe } from '../scripts/admin-recipe-import.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const clock = 1789090000000;
const stamp = 'a'.repeat(32);
const jobId = `import-job-${stamp}`;
const taskId = `import-task-${stamp}-0`;
const storageRoot = `cloud://test-env.bucket/authorized-import/${stamp}`;

async function fixture(payload = { type: 'images', assets: [{ uploadHash: hash('photo'), rawFileId: `${storageRoot}/${hash('photo')}.jpg` }] }, overrides = {}) {
  const repository = memoryRepository();
  const context = { userId: 'owner', family: { id: 'family', ownerId: 'owner' } };
  const job = { _id: jobId, kind: 'authorized_import_job_v1', state: 'active', userId: context.userId, familyId: context.family.id, expiresAt: clock + 100000, storageRoot };
  const task = { _id: taskId, kind: 'authorized_import_task_v1', jobId, payload, payloadHash: hash(JSON.stringify(payload)), state: 'queued', expiresAt: clock + 100000 };
  await repository.set('imports', jobId, job);
  await repository.set('imports', taskId, task);
  const stored = [];
  const handler = createAuthorizedImport({ repository, now: () => clock, readImportImage: async () => Buffer.from('photo'), storeImageBytes: async (bytes, owner) => {
    stored.push({ bytes, owner });
    return { fileId: `cloud://test-env.bucket/approved/${hash(bytes)}.bin`, encryptionKey: 'private-key' };
  }, ...overrides });
  return { repository, context, job, task, stored, run: () => handler({ jobId, taskId }, context) };
}

test('source digest binds every staged document identity and content digest', () => {
  const documents = [{ _id: 'source-one', contentDigest: hash('first') }, { _id: 'source-two', contentDigest: hash('second') }];
  assert.equal(sourceDigest(documents), sourceDigest(structuredClone(documents)));
  assert.notEqual(sourceDigest(documents), sourceDigest(documents.slice(0, 1)));
  assert.notEqual(sourceDigest(documents), sourceDigest([{ ...documents[0], contentDigest: hash('changed') }, documents[1]]));
  assert.notEqual(sourceDigest(documents), sourceDigest([{ ...documents[0], _id: 'other' }, documents[1]]));
});

test('authorized image processing stores once and persists an idempotent receipt', async () => {
  const server = await fixture();
  assert.deepEqual(await server.run(), { completed: true, replay: false });
  assert.deepEqual(await server.run(), { completed: true, replay: true });
  assert.equal(server.stored.length, 1);
  assert.deepEqual(server.stored[0].owner, { userId: 'owner', familyId: 'family' });
  const result = await server.repository.get('imports', taskId);
  assert.equal(result.state, 'completed');
  assert.equal(result.payloadHash, server.task.payloadHash);
  assert.equal((await server.repository.list('posts')).length, 0);
});

test('missing, expired, mismatched, revoked, and nonowner import grants cannot run', async () => {
  for (const mutate of [
    server => server.repository.remove('imports', jobId),
    server => server.repository.set('imports', jobId, { ...server.job, state: 'completed' }),
    server => server.repository.set('imports', jobId, { ...server.job, expiresAt: clock }),
    server => server.repository.set('imports', jobId, { ...server.job, familyId: 'other' }),
    server => server.repository.set('imports', taskId, { ...server.task, jobId: 'other' }),
    server => { server.context.family.ownerId = 'other'; },
    server => { server.context.userId = 'other'; },
  ]) {
    const server = await fixture();
    await mutate(server);
    await assert.rejects(server.run(), { code: 'FORBIDDEN' });
    assert.equal(server.stored.length, 0);
  }
});

test('payload tampering, concurrent lease and oversized batches cannot write images', async () => {
  const server = await fixture();
  await server.repository.set('imports', taskId, { ...server.task, payload: { type: 'images', assets: [] } });
  await assert.rejects(server.run(), /摘要/);
  await server.repository.set('imports', taskId, { ...server.task, state: 'running', leaseUntil: clock + 100 });
  await assert.rejects(server.run(), { code: 'IMPORT_BUSY' });
  const oversized = await fixture({ type: 'images', assets: Array.from({ length: 9 }, (_, index) => ({ uploadHash: hash(String(index)), rawFileId: `${storageRoot}/${hash(String(index))}.jpg` })) });
  await assert.rejects(oversized.run(), { code: 'INVALID' });
  assert.equal(oversized.stored.length, 0);
});

test('storage failures persist as failures rather than completed tasks', async () => {
  const error = Object.assign(new Error('storage unavailable'), { code: 'STORAGE_UNAVAILABLE', errCode: 500 });
  const server = await fixture(undefined, { storeImageBytes: async () => { throw error; } });
  await assert.rejects(server.run(), error);
  const result = await server.repository.get('imports', taskId);
  assert.equal(result.state, 'failed');
  assert.equal(result.error.serviceCode, 500);
  assert.equal(result.error.code, 'STORAGE_UNAVAILABLE');
  assert.throws(() => assertCompletedTasks([result], [server.task]), /未完成/);
});

test('failed tasks can resume but cannot be published before completion', async () => {
  const server = await fixture();
  const failed = { ...server.task, state: 'failed', error: { code: 'STORAGE_UNAVAILABLE' } };
  assert.doesNotThrow(() => assertProcessAllowed(server.job, [failed], clock));
  assert.throws(() => assertCompletedTasks([failed], [server.task]), /未完成/);
  assert.doesNotThrow(() => assertProcessAllowed(server.job, [{ ...failed, state: 'completed' }], clock));
});

test('resuming never bypasses expired grants or running cloud tasks', async () => {
  const server = await fixture();
  assert.throws(() => assertProcessAllowed({ ...server.job, expiresAt: clock }, [server.task], clock), /授权已失效/);
  assert.throws(() => assertProcessAllowed({ ...server.job, state: 'completed' }, [server.task], clock), /授权已失效/);
  assert.throws(() => assertProcessAllowed(server.job, [{ ...server.task, expiresAt: clock }], clock), /过期/);
  assert.throws(() => assertProcessAllowed(server.job, [{ ...server.task, state: 'running', leaseUntil: clock + 1 }], clock), /执行中/);
  assert.doesNotThrow(() => assertProcessAllowed(server.job, [{ ...server.task, state: 'running', leaseUntil: clock - 1 }], clock));
});

test('legacy text tasks are not executed or rewritten as successful checks', async () => {
  const server = await fixture({ type: 'text', content: '旧文本任务' });
  await assert.rejects(server.run(), { code: 'INVALID' });
  assert.equal((await server.repository.get('imports', taskId)).state, 'failed');
  assert.equal(server.stored.length, 0);
});

test('image batches retain successes, verify bytes, encrypt and resume only missing images', async () => {
  const images = [Buffer.from('photo-one'), Buffer.from('photo-two')];
  const assets = images.map(bytes => ({ uploadHash: hash(bytes), rawFileId: `${storageRoot}/${hash(bytes)}.jpg` }));
  let fail = true;
  const calls = [];
  const server = await fixture({ type: 'images', assets }, {
    readImportImage: async fileId => images[assets.findIndex(asset => asset.rawFileId === fileId)],
    storeImageBytes: async bytes => {
      calls.push(bytes.toString());
      if (bytes.toString() === 'photo-two' && fail) throw new Error('network');
      return { fileId: `cloud://test-env.bucket/approved/${hash(bytes)}.bin`, encryptionKey: 'private-key', variants: { card: { fileId: 'card' }, detail: { fileId: 'detail' } } };
    },
  });
  await assert.rejects(server.run(), /network/);
  const partial = await server.repository.get('imports', taskId);
  assert.equal(Object.keys(partial.results).length, 1);
  assert.ok(!JSON.stringify(partial.results).includes('private-key'));
  fail = false;
  await server.run();
  assert.equal(calls.filter(value => value === 'photo-one').length, 1);
  assert.equal(calls.filter(value => value === 'photo-two').length, 2);
  const media = await server.repository.list('media');
  assert.equal(media.length, 2);
  assert.ok(media.every(item => item.confirmed && item.familyId === 'family' && item.importJobId === jobId && item.variants.card));
});

test('images from another prefix or with different bytes are rejected before storage', async () => {
  for (const rawFileId of [`${storageRoot}/wrong.jpg`, `${storageRoot}/${hash('expected')}.jpg`]) {
    let stored = false;
    const server = await fixture({ type: 'images', assets: [{ uploadHash: hash('expected'), rawFileId }] }, { readImportImage: async () => Buffer.from('unexpected'), storeImageBytes: async () => { stored = true; } });
    await assert.rejects(server.run(), { code: 'FORBIDDEN' });
    assert.equal(stored, false);
  }
});

test('batch inserts are bounded insert-only operations with no missing rows', () => {
  const documents = Array.from({ length: 8 }, (_, index) => ({ _id: `post-${index}`, title: '菜'.repeat(100) }));
  const batches = insertBatches('posts', documents, 1200);
  assert.deepEqual(batches.flatMap(batch => batch.rows), documents);
  assert.ok(batches.every(batch => Buffer.byteLength(batch.command) <= 1200 && JSON.parse(batch.command)[0].CommandType === 'INSERT'));
});

test('completed task verification rejects missing, mutated or unapproved tasks', async () => {
  const server = await fixture();
  await server.run();
  const actual = await server.repository.get('imports', taskId);
  assertCompletedTasks([actual], [server.task]);
  assert.throws(() => assertCompletedTasks([], [server.task]));
  assert.throws(() => assertCompletedTasks([{ ...actual, payload: { type: 'text', content: 'other' } }], [server.task]));
  assert.throws(() => assertCompletedTasks([{ ...actual, state: 'running' }], [server.task]));
});

test('normal clients cannot mint grants or impersonate an import owner', async () => {
  const server = await fixture();
  const app = createApplication({ repository: server.repository, now: () => clock });
  assert.equal((await app({ action: 'authorizedImport', jobId, taskId, userId: 'owner' }, {})).code, 'UNAUTHENTICATED');
  const userId = hash('guest');
  await server.repository.set('users', userId, { familyId: 'family' });
  await server.repository.set('families', 'family', { id: 'family', ownerId: userId, members: [{ id: userId }] });
  assert.equal((await app({ action: 'authorizedImport', jobId, taskId, userId: 'owner' }, { OPENID: 'guest' })).code, 'FORBIDDEN');
});

test('bulk post construction preserves quantities, source, steps and matching feed card', () => {
  const image = 'data:image/jpeg;base64,aW1hZ2U=';
  const sourceUrl = 'https://www.xiachufang.com/recipe/1234/';
  const sourceHash = hash('image');
  const raw = { sourceUrl, sourceHtml: 'original', authorizationId: 'auth', cover: { url: 'https://example.test/image.jpg' }, steps: [{ text: '切块拌匀', images: [{ url: 'https://example.test/image.jpg' }] }] };
  const recipe = { title: '凉拌黄瓜', category: '素菜', servings: 2, minutes: null, image, ingredients: [{ name: '黄瓜', quantity: 1, unit: '根' }, { name: '盐', quantity: null, unit: '', amountText: '适量' }], steps: [{ title: '拌匀', text: '切块拌匀', images: [image] }], provenance: { source: '下厨房', url: sourceUrl, license: '用户授权', attribution: '作者', note: '' } };
  const review = { sourceUrl, sourceHtmlFingerprint: hash('original'), category: '素菜', approved: true };
  const document = buildStagedRecipe({ raw, review, assets: { 'https://example.test/image.jpg': { sha256: sourceHash, fileId: image } }, files: new Map([[sourceHash, { uploadHash: sourceHash }]]), normalized: { ready: true, sourceReview: { matched: true }, completeness: { imageBytesVerified: true }, recipe } }, {}, { appid: 'wx-test', env: 'test-env' });
  const files = { [`sha256:${sourceHash}`]: { confirmed: true, uploadHash: sourceHash, fileId: 'cloud://test-env.bucket/approved/photo.bin' } };
  const family = { id: 'family', name: '我的家', members: [{ id: 'owner', name: '我' }] };
  const before = structuredClone(family);
  const post = buildImportedPost(document, files, family, 'owner', jobId, clock);
  assert.equal(post.title, '凉拌黄瓜');
  assert.equal(post.status, 'published');
  assert.equal(post.publishedAt, new Date(clock).toISOString());
  assert.equal(post.author, '食愿小灶');
  assert.equal(post.publisherType, 'official');
  assert.equal(post.publisherId, 'official:shiyuan');
  assert.equal(post.card.author, post.author);
  assert.equal(post.card.publisherType, post.publisherType);
  assert.equal(post.card.publisherId, post.publisherId);
  assert.equal(post.card.title, post.title);
  assert.equal(post.card.recipes[0].id, post.recipes[0].id);
  assert.deepEqual(post.recipes[0].ingredients, recipe.ingredients);
  assert.deepEqual(post.recipes[0].provenance, recipe.provenance);
  assert.deepEqual(post.categories, ['素菜']);
  assert.deepEqual(family, before);
  assert.deepEqual(post.assetIds, ['cloud://test-env.bucket/approved/photo.bin']);
});
