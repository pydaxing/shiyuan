import test from 'node:test';
import assert from 'node:assert/strict';
import { createFamilyDeletionMedia } from '../server/family-deletion-media.mjs';
import { memoryRepository } from './helpers/memory-repository.js';

const familyId = 'family-deleted';
const file = name => `cloud://test.env/${name}`;

async function fixture(options = {}) {
  const repository = memoryRepository();
  await repository.set('families', familyId, { id: familyId, deletedAt: 1, members: [], deletion: { phase: 'media' } });
  const removed = [];
  const removeFiles = options.removeFiles || (async ids => { removed.push(...ids); return { fileList: ids.map(fileID => ({ fileID, status: 0 })) }; });
  const cleanup = createFamilyDeletionMedia({ repository, removeFiles, ...options });
  const media = (id, value = {}) => repository.set('media', id, { familyId, fileId: file(id), confirmed: true, ...value });
  async function finish() {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const result = await cleanup(familyId, { maxSteps: 200 });
      if (result.complete || result.reason) return result;
    }
    throw new Error('Cleanup did not finish');
  }
  return { repository, removed, cleanup, media, finish };
}

test('deletes private original, variants, delivery and ticket metadata after explicit storage success', async () => {
  const f = await fixture({ resolveStoragePath: async path => file(path) });
  await f.media('original', { variants: { card: { fileId: file('card'), delivery: { fileId: file('card-display') } }, detail: { fileId: file('detail') } } });
  await f.media('ticket', { fileId: undefined, path: 'raw', previewPath: 'raw-preview', result: { fileId: file('original') }, confirmed: false });
  const result = await f.finish();
  assert.equal(result.complete, true);
  assert.equal(result.deletedRecords, 2);
  assert.deepEqual([...f.removed].sort(), ['original', 'card', 'card-display', 'detail', 'raw', 'raw-preview'].map(file).sort());
  assert.deepEqual(await f.repository.list('media'), []);
  assert.equal((await f.cleanup(familyId)).deletedFiles, 6);
  assert.equal(f.removed.length, 6);
});

test('preserves public posts and the deleted family public identity including connected aliases', async () => {
  const f = await fixture();
  await f.media('published', { variants: { card: { fileId: file('published-card') } } });
  await f.media('alias', { fileId: file('published-card'), delivery: { fileId: file('alias-display') } });
  await f.media('cover');
  await f.media('private');
  await f.repository.set('posts', 'published', { status: 'published', familyId, assetIds: [file('published')], familySnapshot: { cover: file('cover') } });
  const family = await f.repository.get('families', familyId);
  await f.repository.set('families', familyId, { ...family, publicIdentity: { name: '已删除的小家', cover: file('cover') } });
  const result = await f.finish();
  assert.equal(result.complete, true);
  assert.equal(result.retainedRecords, 3);
  assert.deepEqual(f.removed, [file('private')]);
  for (const id of ['published', 'alias', 'cover']) assert.equal((await f.repository.get('media', id)).confirmed, true);
});

for (const [collection, value] of [
  ['recipes', { familyId: 'other', value: { image: file('shared') } }],
  ['orders', { familyId: 'other', value: { items: [{ recipe: { image: file('shared') } }] } }],
  ['users', { avatar: file('shared') }],
  ['imports', { kind: 'authorized_import_task_v1', payload: { images: [file('shared')] } }],
  ['media', { familyId: 'other', confirmed: true, fileId: file('other-original'), variants: { card: { fileId: file('shared') } } }],
]) {
  test(`retains media referenced by ${collection}`, async () => {
    const f = await fixture();
    await f.media('shared');
    await f.repository.set(collection, 'external', value);
    assert.equal((await f.finish()).complete, true);
    assert.deepEqual(f.removed, []);
    assert.equal((await f.repository.get('media', 'shared')).confirmed, true);
  });
}

test('only storage results matching each file exactly count as success; failures are resumable', async () => {
  let attempt = 0;
  const calls = [];
  const f = await fixture({ removeFiles: async ids => {
    calls.push(ids);
    if (++attempt === 1) return { fileList: [{ fileID: file('original'), status: 0 }, { fileID: file('card'), status: -1 }] };
    return { fileList: ids.map(fileID => ({ fileID, status: 0 })) };
  } });
  await f.media('original', { variants: { card: { fileId: file('card') } } });
  const failed = await f.finish();
  assert.equal(failed.complete, false);
  assert.equal(failed.reason, 'STORAGE_DELETE_FAILED');
  assert.equal((await f.repository.get('media', 'original')).confirmed, false);
  assert.equal((await f.repository.get('media', 'original')).familyDeletionMedia.state, 'deleting');
  const done = await f.finish();
  assert.equal(done.complete, true);
  assert.deepEqual(calls, [[file('original'), file('card')], [file('card')]]);
  assert.equal(await f.repository.get('media', 'original'), null);
});

for (const response of [undefined, {}, { fileList: [] }, { fileList: [{ fileID: file('different'), status: 0 }] }, { fileList: [{ fileID: file('private'), status: 0 }, { fileID: file('private'), status: 0 }] }]) {
  test(`incomplete or ambiguous delete response cannot erase metadata: ${JSON.stringify(response)}`, async () => {
    const f = await fixture({ removeFiles: async () => response });
    await f.media('private');
    const result = await f.finish();
    assert.equal(result.complete, false);
    assert.equal(result.reason, 'STORAGE_DELETE_FAILED');
    assert.ok(await f.repository.get('media', 'private'));
  });
}

test('a new cleanup instance resumes persisted page cursors without holding a full snapshot', async () => {
  const f = await fixture();
  await f.media('private');
  for (let i = 0; i < 123; i += 1) await f.repository.set('users', `user-${String(i).padStart(3, '0')}`, { name: 'someone' });
  const cursors = [];
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const cleanup = createFamilyDeletionMedia({ repository: f.repository, removeFiles: async ids => { f.removed.push(...ids); return ids.map(fileID => ({ fileID, status: 0 })); } });
    const result = await cleanup(familyId, { maxSteps: 1 });
    const state = (await f.repository.get('families', familyId)).deletion.media;
    cursors.push(state.scanAfter);
    if (result.complete) break;
  }
  assert.ok(cursors.includes('user-049'));
  assert.ok(cursors.includes('user-099'));
  assert.equal((await f.repository.get('families', familyId)).deletion.media.phase, 'complete');
  assert.deepEqual(f.removed, [file('private')]);
});

test('rechecks candidate fingerprints before any storage deletion and rescans a changed record', async () => {
  const f = await fixture();
  await f.media('private');
  while (true) {
    await f.cleanup(familyId, { maxSteps: 1 });
    const state = (await f.repository.get('families', familyId)).deletion.media;
    if (state.phase === 'roots' && state.scanCollection === 14) break;
  }
  await f.media('private', { variants: { card: { fileId: file('late-variant') } } });
  await f.cleanup(familyId, { maxSteps: 1 });
  assert.deepEqual(f.removed, []);
  assert.equal((await f.repository.get('families', familyId)).deletion.media.phase, 'select');
  assert.equal((await f.finish()).complete, true);
  assert.deepEqual(f.removed.sort(), [file('late-variant'), file('private')].sort());
});

test('unresolved raw upload paths stay pending and metadata survives for recovery', async () => {
  const f = await fixture();
  await f.media('ticket', { fileId: undefined, path: 'private/raw.jpg', confirmed: false });
  const result = await f.finish();
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'UPLOAD_PATH_UNRESOLVED');
  assert.ok(await f.repository.get('media', 'ticket'));
  assert.deepEqual(f.removed, []);
});

test('in-flight upload operations block cleanup until settled, then their abandoned files are deleted', async () => {
  let time = 10;
  const f = await fixture({ now: () => time });
  await f.media('a-private');
  await f.media('z-upload', { fileId: undefined, confirmed: false, uploadInFlightUntil: 100 });
  assert.equal((await f.finish()).reason, 'UPLOAD_IN_FLIGHT');
  assert.deepEqual(f.removed, []);
  await f.media('z-upload', { fileId: file('abandoned'), confirmed: false, uploadInFlightUntil: 0, abandonedUpload: true });
  time = 20;
  const result = await f.finish();
  assert.equal(result.complete, true);
  assert.deepEqual(f.removed.sort(), [file('a-private'), file('abandoned')].sort());
});

test('active or missing families cannot trigger media deletion', async () => {
  const f = await fixture();
  await f.media('private');
  await f.repository.set('families', familyId, { id: familyId, members: [{ id: 'owner' }] });
  await assert.rejects(f.cleanup(familyId), /尚未停用/);
  await assert.rejects(f.cleanup('another-family'), /尚未停用/);
  assert.deepEqual(f.removed, []);
});

test('account-scoped profile and new-family draft media survive old family deletion', async () => {
  const f = await fixture();
  await f.media('profile', { profile: true, userId: 'owner' });
  await f.media('draft', { familyDraftRequest: 'new-family', userId: 'owner' });
  const result = await f.finish();
  assert.equal(result.complete, true);
  assert.equal(result.retainedRecords, 2);
  assert.deepEqual(f.removed, []);
});

test('reference closure rescans backward links and does not skip unrelated IDs between retained aliases', async () => {
  const f = await fixture();
  await f.media('a', { fileId: file('a') });
  await f.media('b', { fileId: file('b'), alias: file('c') });
  await f.media('c', { fileId: file('c'), alias: file('a') });
  await f.media('d-private');
  await f.repository.set('users', 'public-owner', { avatar: file('b') });
  const result = await f.finish();
  assert.equal(result.complete, true);
  assert.equal(result.retainedRecords, 3);
  assert.deepEqual(f.removed, [file('d-private')]);
  for (const id of ['a', 'b', 'c']) assert.ok(await f.repository.get('media', id));
});
