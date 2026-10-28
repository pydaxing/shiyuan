import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFamilyService } from '../server/families.mjs';
import { createFamilyDeletion, familyDeletionTombstone } from '../server/family-deletion.mjs';
import { memoryRepository } from './helpers/memory-repository.js';

const PRIVATE = ['recipes', 'meal_sets', 'orders', 'inventory', 'purchases', 'invites', 'shares', 'requests'];
const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => Date.parse('2026-10-28T08:00:00Z');

function fixture({ cleanupMedia = async () => ({ complete: true }) } = {}) {
  const repository = memoryRepository();
  const bootstrap = async userId => {
    const account = await repository.get('users', userId);
    return { userId, familyId: account?.familyId || '', needsFamily: !account?.familyId };
  };
  const membership = async (db, userId) => {
    const user = await db.get('users', userId);
    const family = await db.get('families', user?.familyId);
    if (!family || family.deletedAt || !family.members.some(member => member.id === userId)) throw Object.assign(new Error('请先创建或加入家庭'), { code: 'NO_FAMILY' });
    return { user, family };
  };
  const service = createFamilyService({ repository, bootstrap, membership, now, throttle: async () => {}, cleanupMedia });
  let sequence = 0;
  const call = (action, event = {}, userId = 'alice') => service(action, event, userId);
  const create = (name = '准备删除的家', userId = 'alice') => call('createFamily', { familyName: name, name: userId, requestId: `family-deletion-create-${++sequence}` }, userId);
  const finish = async result => {
    for (let attempt = 0; result.deletion?.status === 'pending' && attempt < 50; attempt += 1) result = await call('continueFamilyDeletion', { familyId: result.deletion.familyId });
    assert.equal(result.deletion?.status, 'complete');
    return result;
  };
  return { repository, call, create, finish };
}

test('delete clears all private collections across pages and preserves accounts, other families, public posts and identity', async () => {
  const server = fixture();
  const other = await server.create('保留的家', 'bob');
  const created = await server.create();
  const family = await server.repository.get('families', created.familyId);
  for (const collection of PRIVATE) {
    for (let index = 0; index < 53; index += 1) await server.repository.set(collection, `${collection}-${String(index).padStart(3, '0')}`, { familyId: created.familyId, privateValue: 'remove me' });
    await server.repository.set(collection, `other-${collection}`, { familyId: other.familyId, privateValue: 'keep me' });
  }
  await server.repository.set('posts', 'public', { id: 'public', familyId: created.familyId, status: 'published', author: '准备删除的家', publisherType: 'user', importedFamilyCount: 2, card: { title: '公开菜谱', importedFamilyCount: 2 } });
  await server.repository.set('posts', 'withdrawn', { id: 'withdrawn', familyId: created.familyId, status: 'deleted', title: '已撤回' });
  for (const collection of ['comments', 'reports']) for (let index = 0; index < 30; index += 1) await server.repository.set(collection, `${collection}-${index}`, { postId: 'withdrawn', text: 'remove me' });
  await server.repository.set('comments', 'public-comment', { postId: 'public', text: 'keep me' });
  await server.repository.set('imports', 'my-import', { familyId: created.familyId, postId: 'public' });
  await server.repository.set('imports', 'other-import', { familyId: other.familyId, postId: 'public' });
  await server.repository.set('imports', 'source-job', { familyId: created.familyId, kind: 'authorized_import_job_v1', evidence: 'keep provenance' });
  const result = await server.finish(await server.call('deleteFamily', { familyId: created.familyId, confirmName: '准备删除的家' }));
  assert.equal(result.needsFamily, true);
  for (const collection of PRIVATE) {
    assert.deepEqual(await server.repository.list(collection, { familyId: created.familyId }), [], collection);
    assert.equal((await server.repository.get(collection, `other-${collection}`)).privateValue, 'keep me');
  }
  const tombstone = await server.repository.get('families', created.familyId);
  assert.equal(tombstone.deletedAt, now());
  assert.deepEqual(tombstone.members, []);
  assert.equal(tombstone.name, undefined);
  assert.equal(tombstone.ownerId, undefined);
  assert.equal(tombstone.publicIdentity.name, '准备删除的家');
  assert.equal(tombstone.publicIdentity.publicId, family.publicId);
  assert.equal((await server.repository.get('family_public_ids', family.publicId)).familyId, created.familyId);
  assert.equal((await server.repository.get('families', other.familyId)).name, '保留的家');
  assert.equal((await server.repository.get('users', 'alice')).name, 'alice');
  assert.deepEqual((await server.repository.get('users', 'alice')).pendingFamilyDeletions, []);
  assert.equal((await server.repository.get('users', 'bob')).familyId, other.familyId);
  const post = await server.repository.get('posts', 'public');
  assert.equal(post.importedFamilyCount, 1);
  assert.equal(post.card.importedFamilyCount, 1);
  assert.equal(post.familySnapshot.name, '准备删除的家');
  assert.deepEqual(post.card.familySnapshot, post.familySnapshot);
  assert.equal(await server.repository.get('posts', 'withdrawn'), null);
  assert.deepEqual(await server.repository.list('comments', { postId: 'withdrawn' }), []);
  assert.deepEqual(await server.repository.list('reports', { postId: 'withdrawn' }), []);
  assert.ok(await server.repository.get('comments', 'public-comment'));
  assert.ok(await server.repository.get('imports', 'other-import'));
  assert.ok(await server.repository.get('imports', 'source-job'));
  assert.deepEqual((await server.call('listFamilies')).pendingDeletions, []);
});

test('opaque retired receipts reject delayed creation without retaining household content', async () => {
  const server = fixture();
  const created = await server.create();
  await server.finish(await server.call('deleteFamily', { familyId: created.familyId, confirmName: '准备删除的家' }));
  const receiptId = hash('alice:createFamily:family-deletion-create-1');
  assert.deepEqual(await server.repository.get('requests', receiptId), { _id: receiptId, kind: 'retired_family_request_v1' });
  await assert.rejects(server.call('createFamily', { familyName: '准备删除的家', requestId: 'family-deletion-create-1' }), { code: 'CONFLICT' });
  assert.equal((await server.repository.list('families')).length, 1);
});

test('ordinary exit and owner succession keep shared data and do not run a purge', async () => {
  let mediaCalls = 0;
  const server = fixture({ cleanupMedia: async () => { mediaCalls += 1; return { complete: true }; } });
  const created = await server.create();
  const invitation = await server.call('prepareInvite');
  await server.call('joinFamily', { token: invitation.token }, 'bob');
  await server.repository.set('recipes', 'private-recipe', { familyId: created.familyId, value: { title: '共有菜谱' } });
  const departed = await server.call('leaveFamily', { familyId: created.familyId });
  assert.equal(departed.deletion, undefined);
  const family = await server.repository.get('families', created.familyId);
  assert.equal(family.ownerId, 'bob');
  assert.equal(family.deletedAt, undefined);
  assert.equal(family.members.length, 1);
  assert.ok(await server.repository.get('recipes', 'private-recipe'));
  assert.equal(mediaCalls, 0);
  const last = await server.call('leaveFamily', { familyId: created.familyId }, 'bob');
  assert.equal(last.deletion.status, 'complete');
  assert.equal(await server.repository.get('recipes', 'private-recipe'), null);
  assert.equal(mediaCalls, 1);
});

test('a failed cleanup remains discoverable and authorized continuation resumes without replaying counters', async () => {
  let ready = false;
  const server = fixture({ cleanupMedia: async () => { if (!ready) throw new Error('storage temporarily unavailable'); return { complete: true }; } });
  const created = await server.create();
  await server.repository.set('posts', 'public', { familyId: 'another-family', status: 'published', importedFamilyCount: 3, card: { importedFamilyCount: 3 } });
  await server.repository.set('imports', 'my-import', { familyId: created.familyId, postId: 'public' });
  const result = await server.call('deleteFamily', { familyId: created.familyId, confirmName: '准备删除的家' });
  assert.equal(result.needsFamily, true);
  assert.equal(result.deletion.status, 'pending');
  assert.equal(result.deletion.retryRequired, true);
  assert.equal((await server.call('listFamilies')).pendingDeletions[0].familyId, created.familyId);
  await assert.rejects(server.call('continueFamilyDeletion', { familyId: created.familyId }, 'bob'), { code: 'FORBIDDEN' });
  assert.equal((await server.repository.get('posts', 'public')).importedFamilyCount, 2);
  ready = true;
  await server.finish(await server.call('continueFamilyDeletion', { familyId: created.familyId }));
  assert.equal((await server.repository.get('posts', 'public')).importedFamilyCount, 2);
  assert.deepEqual((await server.call('listFamilies')).pendingDeletions, []);
  const repeated = await server.call('deleteFamily', { familyId: created.familyId, confirmName: 'irrelevant after deletion' });
  assert.equal(repeated.deletion.status, 'complete');
});

test('cleanup never reports complete when media cleanup has not been installed', async () => {
  const server = fixture({ cleanupMedia: null });
  const created = await server.create();
  const result = await server.call('leaveFamily', { familyId: created.familyId });
  assert.equal(result.deletion.phase, 'media');
  assert.equal(result.deletion.privateDataCleared, true);
  assert.equal(result.deletion.status, 'pending');
});

test('a family with only official posts retains their author and drops the unused private identity', async () => {
  const server = fixture();
  const created = await server.create();
  await server.repository.set('posts', 'official', { familyId: created.familyId, publisherType: 'official', author: '原作者', status: 'published', card: { title: '官方菜谱' } });
  const before = await server.repository.get('posts', 'official');
  await server.finish(await server.call('deleteFamily', { familyId: created.familyId, confirmName: '准备删除的家' }));
  assert.deepEqual(await server.repository.get('posts', 'official'), before);
  assert.equal((await server.repository.get('families', created.familyId)).publicIdentity, undefined);
});

test('an existing public identity snapshot does not change to the latest private household appearance', async () => {
  const server = fixture();
  const created = await server.create('新家庭名');
  const familySnapshot = { name: '发布时的家', avatar: 'cloud://env/public-avatar', cover: 'cloud://env/public-cover', publicId: 'sy-abc123' };
  await server.repository.set('posts', 'public', { familyId: created.familyId, status: 'published', publisherType: 'user', author: '发布时的家', familySnapshot, card: { title: '分享' } });
  await server.finish(await server.call('deleteFamily', { familyId: created.familyId, confirmName: '新家庭名' }));
  const retained = await server.repository.get('posts', 'public');
  assert.deepEqual(retained.familySnapshot, familySnapshot);
  assert.deepEqual(retained.card.familySnapshot, familySnapshot);
});

test('one bounded batch rolls back with its cursor and resumes every record', async () => {
  const repository = memoryRepository();
  const family = familyDeletionTombstone({ id: 'family-to-delete', name: '家', members: [{ id: 'alice' }], revision: 1 }, 'alice', now);
  family.deletion.phase = 'private';
  await repository.set('families', family.id, family);
  for (let index = 0; index < 61; index += 1) await repository.set('recipes', `recipe-${index}`, { familyId: family.id, value: { title: `菜${index}` } });
  const transaction = repository.transaction;
  let removals = 0;
  let failOnce = true;
  repository.transaction = work => transaction(db => work({ ...db, remove: async (...args) => {
    if (failOnce && ++removals === 12) { failOnce = false; throw new Error('transaction interrupted'); }
    return db.remove(...args);
  } }));
  const cleanup = createFamilyDeletion({ repository, now, maxBatches: 1, cleanupMedia: async () => ({ complete: true }) });
  await assert.rejects(cleanup(family.id, 'alice'), /transaction interrupted/);
  assert.equal((await repository.list('recipes', { familyId: family.id })).length, 61);
  assert.equal((await repository.get('families', family.id)).deletion.deletedDocuments, 0);
  let result = await cleanup(family.id, 'alice');
  assert.equal(result.status, 'pending');
  assert.equal((await repository.list('recipes', { familyId: family.id })).length, 36);
  for (let attempt = 0; result.status !== 'complete' && attempt < 25; attempt += 1) result = await cleanup(family.id, 'alice');
  assert.equal(result.status, 'complete');
  assert.equal(result.deletedDocuments, 61);
  assert.deepEqual(await repository.list('recipes', { familyId: family.id }), []);
});
