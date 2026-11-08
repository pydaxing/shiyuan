import test from 'node:test';
import assert from 'node:assert/strict';
import { createFamilyDeletion, familyDeletionTombstone } from '../server/family-deletion.mjs';
import { createFamilyDeletionMedia } from '../server/family-deletion-media.mjs';
import { canReadMealPost } from '../server/meal-access.mjs';
import { memoryRepository } from './helpers/memory-repository.js';

const familyId = 'shared-family';
const now = () => Date.parse('2026-11-07T08:00:00Z');
const file = name => `cloud://test.env/${name}`;

async function fixture({ maxBatches = 30 } = {}) {
  const repository = memoryRepository();
  const removed = [];
  const family = { id: familyId, name: '一起吃饭的小家', revision: 3, ownerId: 'alice', members: [{ id: 'alice' }, { id: 'bob' }] };
  await repository.set('families', familyId, familyDeletionTombstone(family, 'alice', now));
  await repository.set('users', 'alice', { id: 'alice', pendingFamilyDeletions: [familyId] });
  await repository.set('users', 'bob', { id: 'bob' });
  const cleanupMedia = createFamilyDeletionMedia({ repository, now, removeFiles: async ids => {
    removed.push(...ids);
    return { fileList: ids.map(fileID => ({ fileID, status: 0 })) };
  } });
  const cleanup = createFamilyDeletion({ repository, now, cleanupMedia, maxBatches });
  async function record(id, patch = {}, media = {}) {
    const post = { id, spaceId: familyId, authorId: 'alice', author: { mode: 'family', name: family.name, avatar: '' }, kind: 'actual', status: 'published', visibility: 'family', mealSharingVersion: 2, mealContext: 'family', participantUserIds: ['alice', 'bob'], date: '2026-11-06', meal: '晚餐', images: [file(id)], assetIds: [file(id)], createdAt: now() - 1, ...patch };
    await repository.set('meal_posts', id, post);
    await repository.set('media', `media-${id}`, { familyId, userId: 'alice', mealPhoto: true, mealPostId: id, fileId: file(id), confirmed: true, ...media });
    return repository.get('meal_posts', id);
  }
  async function finish() {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const result = await cleanup(familyId, 'alice');
      if (result.status === 'complete') return result;
    }
    throw new Error('Family cleanup did not complete');
  }
  return { repository, removed, cleanup, record, finish };
}

test('family deletion preserves the canonical shared diary and its image variants without making it public', async () => {
  const f = await fixture();
  const shared = await f.record('shared', {}, { variants: { card: { fileId: file('shared-card') }, detail: { fileId: file('shared-detail') } } });
  await f.repository.set('media', 'shared-alias', { familyId, fileId: file('shared-card'), delivery: { fileId: file('shared-display') }, confirmed: true });
  const result = await f.finish();
  assert.equal(result.status, 'complete');
  assert.deepEqual(await f.repository.get('meal_posts', shared.id), shared, 'deleting the family must not rewrite the participants or the shared record');
  assert.equal(result.media.retainedRecords, 2);
  assert.deepEqual(f.removed, []);
  assert.equal((await f.repository.get('media', 'media-shared')).confirmed, true);
  assert.equal((await f.repository.get('media', 'shared-alias')).confirmed, true);
  assert.deepEqual((await f.repository.get('families', familyId)).members, []);
  for (const userId of ['alice', 'bob']) assert.equal(await canReadMealPost(f.repository, shared, userId), true);
  assert.equal(await canReadMealPost(f.repository, shared, 'stranger'), false);
  assert.deepEqual(await f.repository.list('meal_posts', { status: 'published', visibility: 'public' }), []);
});

test('public meals survive while legacy private, withdrawn and unproven family archives are still removed', async () => {
  const f = await fixture();
  const published = await f.record('public', { visibility: 'public', mealSharingVersion: 1, participantUserIds: [] });
  const removedIds = ['legacy-private', 'v2-private', 'withdrawn', 'no-participants', 'wrong-context', 'unversioned-family'];
  await f.record(removedIds[0], { visibility: 'private', mealSharingVersion: 1 });
  await f.record(removedIds[1], { visibility: 'private' });
  await f.record(removedIds[2], { status: 'deleted' });
  await f.record(removedIds[3], { participantUserIds: [] });
  await f.record(removedIds[4], { mealContext: 'personal' });
  await f.record(removedIds[5], { mealSharingVersion: undefined });
  const result = await f.finish();
  assert.equal(result.deletedDocuments, removedIds.length);
  assert.deepEqual(await f.repository.get('meal_posts', published.id), published);
  for (const id of removedIds) {
    const deleted = await f.repository.get('meal_posts', id);
    assert.equal(deleted.status, 'deleted', id);
    assert.equal(deleted.images, undefined, id);
    assert.equal(deleted.participantUserIds, undefined, id);
    assert.equal(await f.repository.get('media', `media-${id}`), null, id);
  }
  assert.deepEqual([...f.removed].sort(), removedIds.map(file).sort());
  assert.equal((await f.repository.get('media', 'media-public')).confirmed, true);
});

test('resumable deletion crosses meal pages without losing archives or recounting deleted records', async () => {
  const f = await fixture({ maxBatches: 1 });
  const sharedIds = [], privateIds = [];
  for (let index = 0; index < 31; index += 1) {
    const id = `meal-${String(index).padStart(2, '0')}`;
    const shared = index % 2 === 0;
    await f.record(id, { visibility: shared ? 'family' : 'private' });
    (shared ? sharedIds : privateIds).push(id);
  }
  const result = await f.finish();
  assert.equal(result.deletedDocuments, privateIds.length);
  const retained = await f.repository.list('meal_posts', { status: 'published' });
  assert.deepEqual(retained.map(post => post.id), sharedIds);
  assert.ok(retained.every(post => post.visibility === 'family' && post.participantUserIds.join(',') === 'alice,bob'));
  const repeated = await f.cleanup(familyId, 'alice');
  assert.deepEqual(repeated, result);
  assert.deepEqual([...f.removed].sort(), privateIds.map(file).sort());
});
