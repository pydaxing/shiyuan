import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryRepository } from './helpers/memory-repository.js';
import { createFamilyMediaOperations } from '../server/family-media-operations.mjs';
import { createFamilyDeletionMedia } from '../server/family-deletion-media.mjs';

async function fixture() {
  const repository = memoryRepository();
  await repository.set('families', 'home', { id: 'home', members: [{ id: 'me' }], revision: 1 });
  await repository.set('users', 'me', { familyId: 'home' });
  const operations = createFamilyMediaOperations({ repository, now: () => 1000 });
  const removeFamily = () => repository.set('families', 'home', { id: 'home', members: [], deletedAt: 1000, deletion: { version: 1, phase: 'media', status: 'pending', requestedBy: 'me' } });
  return { repository, operations, removeFamily };
}

test('a deleted or switched family cannot start an image upload', async () => {
  for (const change of ['delete', 'switch']) {
    const { repository, operations, removeFamily } = await fixture();
    if (change === 'delete') await removeFamily();
    else await repository.set('users', 'me', { familyId: 'other' });
    let produced = false;
    await assert.rejects(operations.store('me', 'home', async () => { produced = true; return {}; }, async () => {}), { code: 'NO_FAMILY' });
    assert.equal(produced, false);
    assert.deepEqual(await repository.list('media'), []);
  }
});

test('deletion waits for an in-flight upload and then reclaims its files without adopting them', async () => {
  const { repository, operations, removeFamily } = await fixture();
  let produced, resume;
  const entered = new Promise(resolve => { produced = resolve; });
  const released = new Promise(resolve => { resume = resolve; });
  let committed = false;
  const pending = operations.store('me', 'home', async () => { produced(); await released; return { fileId: 'cloud://env/image', variants: { card: { fileId: 'cloud://env/card' } } }; }, async () => { committed = true; });
  const rejected = assert.rejects(pending, { code: 'NO_FAMILY' });
  await entered;
  await removeFamily();
  const deleted = [];
  const cleanup = createFamilyDeletionMedia({ repository, now: () => 1000, removeFiles: async files => { deleted.push(...files); return { fileList: files.map(fileID => ({ fileID, status: 0 })) }; } });
  assert.equal((await cleanup('home', { maxSteps: 200 })).reason, 'UPLOAD_IN_FLIGHT');
  assert.deepEqual(deleted, []);
  resume(); await rejected;
  assert.equal(committed, false);
  assert.equal((await repository.list('media'))[0].confirmed, false);
  assert.equal((await cleanup('home', { maxSteps: 200 })).complete, true);
  assert.deepEqual(deleted.sort(), ['cloud://env/card', 'cloud://env/image']);
  assert.deepEqual(await repository.list('media'), []);
});

test('storage failure clears its in-flight placeholder and exposes no image', async () => {
  const { repository, operations } = await fixture();
  await assert.rejects(operations.store('me', 'home', async () => { throw new Error('storage unavailable'); }, async () => assert.fail('must not commit')), /storage unavailable/);
  assert.deepEqual(await repository.list('media'), []);
});

test('an upload adopted by an active family commits its image and clears the placeholder', async () => {
  const { repository, operations } = await fixture();
  await operations.store('me', 'home', async () => ({ fileId: 'cloud://env/image' }), (db, stored) => db.set('media', 'image', { ...stored, familyId: 'home', confirmed: true }));
  const rows = await repository.list('media');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]._id, 'image');
  assert.equal(rows[0].confirmed, true);
});

test('exhausted database contention retries do not repeat physical uploads', async () => {
  const { repository } = await fixture();
  const transaction = repository.transaction.bind(repository);
  let produced = 0, conflicts = 0, inject = false;
  repository.transaction = callback => {
    if (inject && conflicts++ < 2) throw Object.assign(new Error('concurrent media fence'), { errCode: -501001 });
    return transaction(callback);
  };
  const operations = createFamilyMediaOperations({ repository, now: () => 1000 });
  const result = await operations.store('me', 'home', async () => {
    produced += 1;
    inject = true;
    return { fileId: 'cloud://env/once' };
  }, async (db, stored) => db.set('media', 'confirmed', { ...stored, confirmed: true }));
  assert.equal(result.fileId, 'cloud://env/once');
  assert.equal(produced, 1);
  assert.equal((await repository.get('media', 'confirmed')).confirmed, true);
  assert.equal((await repository.list('media')).length, 1);
});
