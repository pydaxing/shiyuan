import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryRepository } from './helpers/memory-repository.js';
import { createFamilyMediaOperations } from '../server/family-media-operations.mjs';
import { createMediaDerivationOperations } from '../server/media-derivation-operations.mjs';
import { createFamilyDeletionMedia } from '../server/family-deletion-media.mjs';
import { uploadTrackedFile, removeTrackedFiles } from '../server/media-upload-tracking.mjs';
import { createImageDelivery } from '../server/image-delivery.mjs';

const file = path => `cloud://env/${path}`;
const bytes = Buffer.from('photo');
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture() {
  const repository = memoryRepository();
  await repository.set('families', 'home', { id: 'home', members: [{ id: 'owner' }] });
  await repository.set('users', 'owner', { familyId: 'home' });
  const operations = createFamilyMediaOperations({ repository, now: () => 1000 });
  const derive = createMediaDerivationOperations({ repository, now: () => 1000 });
  const removed = [];
  const cleanup = createFamilyDeletionMedia({ repository, now: () => 1000, resolveStoragePath: async path => file(path), removeFiles: async ids => { removed.push(...ids); return { fileList: ids.map(fileID => ({ fileID, status: 0 })) }; } });
  const deleteFamily = () => repository.set('families', 'home', { id: 'home', deletedAt: 1, members: [], deletion: { phase: 'media' } });
  const upload = async ({ cloudPath }) => ({ fileID: file(cloudPath) });
  const source = { familyId: 'home', fileId: file('original'), encryptionKey: 'key', confirmed: true };
  return { repository, operations, derive, cleanup, deleteFamily, upload, removed, source };
}

test('persists an upload intent before bytes leave, and adopts all successful files', async () => {
  const f = await fixture();
  await f.operations.store('owner', 'home', async storageTracker => {
    const saved = await uploadTrackedFile(async options => {
      const [operation] = await f.repository.list('media');
      assert.deepEqual(operation.uploadFiles, [{ path: 'approved/original' }]);
      return f.upload(options);
    }, { cloudPath: 'approved/original', fileContent: bytes }, { storageTracker });
    return { fileId: saved.fileID };
  }, (db, stored) => db.set('media', 'saved', { ...stored, familyId: 'home', confirmed: true }));
  assert.deepEqual((await f.repository.list('media')).map(row => row._id), ['saved']);
});

test('a lost upload response keeps its path recoverable even without a returned file ID', async () => {
  const f = await fixture();
  await assert.rejects(f.operations.store('owner', 'home', async storageTracker => {
    await uploadTrackedFile(async () => { throw new Error('response lost after storage accepted bytes'); }, { cloudPath: 'approved/unknown', fileContent: bytes }, { storageTracker });
  }, () => assert.fail('must not adopt')), /response lost/);
  const [operation] = await f.repository.list('media');
  assert.deepEqual(operation.uploadFiles, [{ path: 'approved/unknown' }]);
  assert.equal(operation.abandonedUpload, true);
  assert.equal(operation.uploadInFlightUntil, 0);
  await f.deleteFamily();
  assert.equal((await f.cleanup('home', { maxSteps: 200 })).complete, true);
  assert.deepEqual(f.removed, [file('approved/unknown')]);
});

test('failed generation only forgets positively deleted files and leaves failed compensation recoverable', async () => {
  const f = await fixture();
  await assert.rejects(f.operations.store('owner', 'home', async storageTracker => {
    const ticket = { storageTracker };
    const original = await uploadTrackedFile(f.upload, { cloudPath: 'approved/original' }, ticket);
    const card = await uploadTrackedFile(f.upload, { cloudPath: 'approved/card' }, ticket);
    const result = await removeTrackedFiles(async () => ({ fileList: [{ fileID: original.fileID, status: 0 }, { fileID: card.fileID, status: -1 }] }), [original.fileID, card.fileID], ticket);
    assert.deepEqual(result.remaining, [card.fileID]);
    throw new Error('detail generation failed');
  }, () => assert.fail('must not adopt')), /detail generation failed/);
  const [operation] = await f.repository.list('media');
  assert.deepEqual(operation.uploadFiles, [{ path: 'approved/card', fileId: file('approved/card') }]);
  await f.deleteFamily();
  assert.equal((await f.cleanup('home', { maxSteps: 200 })).complete, true);
  assert.deepEqual(f.removed, [file('approved/card')]);
});

test('deletion during storage waits for its lease, prevents another upload, then reclaims the first file', async () => {
  const f = await fixture(), entered = defer(), release = defer();
  let uploads = 0;
  const pending = f.operations.store('owner', 'home', async storageTracker => {
    const ticket = { storageTracker };
    await uploadTrackedFile(async options => { uploads += 1; entered.resolve(); await release.promise; return f.upload(options); }, { cloudPath: 'approved/first' }, ticket);
    await uploadTrackedFile(async options => { uploads += 1; return f.upload(options); }, { cloudPath: 'approved/second' }, ticket);
  }, () => assert.fail('must not adopt'));
  const failed = assert.rejects(pending, { code: 'NO_FAMILY' });
  await entered.promise;
  await f.deleteFamily();
  assert.equal((await f.cleanup('home', { maxSteps: 200 })).reason, 'UPLOAD_IN_FLIGHT');
  assert.deepEqual(f.removed, []);
  release.resolve(); await failed;
  assert.equal(uploads, 1);
  assert.equal((await f.cleanup('home', { maxSteps: 200 })).complete, true);
  assert.deepEqual(f.removed, [file('approved/first')]);
});

test('metadata commit failure keeps uploaded files and preserves the original error', async () => {
  const f = await fixture();
  const originalError = new Error('metadata write failed');
  await assert.rejects(f.operations.store('owner', 'home', async storageTracker => {
    const saved = await uploadTrackedFile(f.upload, { cloudPath: 'approved/commit-failed' }, { storageTracker });
    return { fileId: saved.fileID };
  }, async () => { throw originalError; }), error => error === originalError);
  const [operation] = await f.repository.list('media');
  assert.equal(operation.fileId, file('approved/commit-failed'));
  assert.equal(operation.abandonedUpload, true);
  await f.deleteFamily();
  assert.equal((await f.cleanup('home', { maxSteps: 200 })).complete, true);
  assert.deepEqual(f.removed, [file('approved/commit-failed')]);
});

test('missing, duplicate, string-status, wrong-file and rejected delete results preserve tracking', async () => {
  for (const response of [undefined, { fileList: [] }, { fileList: [{ fileID: file('a'), status: '0' }] }, { fileList: [{ fileID: file('b'), status: 0 }] }, { fileList: [{ fileID: file('a'), status: 0 }, { fileID: file('a'), status: 0 }] }, new Error('offline')]) {
    const discarded = [];
    const result = await removeTrackedFiles(async () => { if (response instanceof Error) throw response; return response; }, [file('a')], { storageTracker: { discard: async ids => discarded.push(...ids) } });
    assert.deepEqual(result.remaining, [file('a')]);
    assert.deepEqual(discarded, []);
  }
});

test('storage never starts when its durable intent cannot be saved', async () => {
  let uploaded = false;
  await assert.rejects(uploadTrackedFile(async () => { uploaded = true; }, { cloudPath: 'approved/file' }, { storageTracker: { record: async () => { throw new Error('database offline'); } } }), /database offline/);
  assert.equal(uploaded, false);
});

test('lazy generation remains recoverable when family deletion races and compensating delete fails', async () => {
  const f = await fixture(), entered = defer(), release = defer();
  await f.repository.set('media', 'original', f.source);
  const pending = f.derive('original', f.source, async storageTracker => {
    const ticket = { storageTracker };
    await uploadTrackedFile(async options => { entered.resolve(); await release.promise; return f.upload(options); }, { cloudPath: 'approved/lazy' }, ticket);
    await removeTrackedFiles(async () => { throw new Error('delete offline'); }, [file('approved/lazy')], ticket);
    throw new Error('variant commit failed');
  });
  const failed = assert.rejects(pending, /variant commit failed/);
  await entered.promise; await f.deleteFamily();
  assert.equal((await f.cleanup('home', { maxSteps: 200 })).reason, 'UPLOAD_IN_FLIGHT');
  release.resolve(); await failed;
  const source = await f.repository.get('media', 'original');
  assert.equal(source.uploadInFlightUntil, 0);
  assert.equal(source.uploadFiles[0].fileId, file('approved/lazy'));
  assert.equal((await f.cleanup('home', { maxSteps: 200 })).complete, true);
  assert.deepEqual(f.removed.sort(), [file('original'), file('approved/lazy')].sort());
});

test('a source already claimed by deletion cannot begin lazy generation', async () => {
  const f = await fixture();
  await f.repository.set('media', 'original', f.source); await f.deleteFamily();
  for (let count = 0; count < 30; count += 1) {
    await f.cleanup('home', { maxSteps: 1 });
    if ((await f.repository.get('media', 'original'))?.familyDeletionMedia) break;
  }
  assert.equal((await f.repository.get('media', 'original')).confirmed, false);
  await assert.rejects(f.derive('original', f.source, () => assert.fail('must not upload')), { code: 'FORBIDDEN' });
});

test('ending one concurrent lazy upload preserves the other lease and its recoverable file', async () => {
  const f = await fixture(), first = defer(), second = defer(), releaseFirst = defer(), releaseSecond = defer();
  await f.repository.set('media', 'original', f.source);
  const run = (path, entered, release) => f.derive('original', f.source, async storageTracker => { await uploadTrackedFile(f.upload, { cloudPath: path }, { storageTracker }); entered.resolve(); await release.promise; });
  const one = run('approved/one', first, releaseFirst), two = run('approved/two', second, releaseSecond);
  await Promise.all([first.promise, second.promise]);
  releaseFirst.resolve(); await one;
  const source = await f.repository.get('media', 'original');
  assert.equal(Object.keys(source.uploadLeases).length, 1);
  assert.ok(source.uploadInFlightUntil > 1000);
  await f.deleteFamily();
  assert.equal((await f.cleanup('home', { maxSteps: 200 })).reason, 'UPLOAD_IN_FLIGHT');
  releaseSecond.resolve(); await two;
  assert.equal((await f.cleanup('home', { maxSteps: 200 })).complete, true);
  assert.deepEqual(f.removed.sort(), [file('original'), file('approved/one'), file('approved/two')].sort());
});

for (const adopt of [false, true]) {
  test(`delivery candidate ${adopt ? 'adoption releases tracking without removing the file' : 'losing commit with failed removal remains tracked'}`, async () => {
    const f = await fixture(); await f.repository.set('media', 'original', f.source);
    let compensation = 0;
    const delivery = createImageDelivery({
      source: async () => f.source, read: async () => bytes,
      withUpload: (_fileId, record, execute) => f.derive('original', record, storageTracker => execute({ ...record, storageTracker })),
      upload: async (_bytes, ticket) => { const saved = await uploadTrackedFile(f.upload, { cloudPath: 'delivery/candidate' }, ticket); return { fileId: saved.fileID, version: 1 }; },
      commit: async (_fileId, _variant, _source, candidate) => {
        if (!adopt) return { fileId: file('winner'), version: 1 };
        await f.repository.transaction(async db => { const current = await db.get('media', 'original'); await db.set('media', 'original', { ...current, delivery: candidate }); });
        return candidate;
      },
      remove: (fileId, ticket) => { compensation += 1; return removeTrackedFiles(async () => ({ fileList: [{ fileID: fileId, status: -1 }] }), [fileId], ticket); },
    });
    const result = await delivery.prepare(file('original'), f.source, 'original');
    assert.equal(result.fileId, file(adopt ? 'delivery/candidate' : 'winner'));
    const source = await f.repository.get('media', 'original');
    assert.equal(source.uploadFiles.length, adopt ? 0 : 1);
    assert.equal(source.uploadInFlightUntil, 0);
    assert.equal(compensation, adopt ? 0 : 1);
    await f.deleteFamily();
    assert.equal((await f.cleanup('home', { maxSteps: 200 })).complete, true);
    assert.deepEqual(f.removed.sort(), [file('original'), file('delivery/candidate')].sort());
  });
}
