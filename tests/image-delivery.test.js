import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageDelivery, createImageSigner, imageContentType } from '../server/image-delivery.mjs';

test('image detection accepts photo containers but not executable or vector content', () => {
  assert.equal(imageContentType(Buffer.from([255, 216, 255, 224])), 'image/jpeg');
  assert.equal(imageContentType(Buffer.from('<svg onload="alert(1)">')), '');
  assert.equal(imageContentType(Buffer.from('<!doctype html>')), '');
  const heic = Buffer.alloc(24);
  heic.writeUInt32BE(24);
  heic.write('ftypheic', 4);
  heic.write('mif1heic', 16);
  assert.equal(imageContentType(heic), 'image/heic');
  heic.write('mp42', 8);
  heic.write('isommp42', 16);
  assert.equal(imageContentType(heic), '');
});

test('warm image reads sign existing derivatives without downloading or converting bytes', async () => {
  const signings = [];
  const delivery = createImageDelivery({
    now: () => 100,
    source: async () => ({ delivery: { fileId: 'private-card', bytes: 17000, contentType: 'image/jpeg', version: 1 } }),
    read: () => assert.fail('warm reads must not download an archive'),
    upload: () => assert.fail('warm reads must not upload another derivative'),
    sign: async (fileId, maxAge) => { signings.push({ fileId, maxAge }); return { status: 0, tempFileURL: 'https://storage.example.test/signed-card', maxAge: 300 }; },
  });
  const result = await delivery.manifest('archive', {}, 'card');
  assert.deepEqual(signings, [{ fileId: 'private-card', maxAge: 300 }]);
  assert.equal(result.bytes, 17000);
  assert.equal(result.urlExpiresAt, 300100);
  assert.equal(result.base64, undefined);
  assert.equal(JSON.stringify(result).includes('encryptionKey'), false);
});

test('legacy preparation is single-flight and deletes a losing concurrent delivery copy', async () => {
  let reads = 0;
  let writes = 0;
  const deleted = [];
  const winner = { fileId: 'winner', bytes: 5, contentType: 'image/jpeg', version: 1 };
  const delivery = createImageDelivery({
    source: async () => ({ fileId: 'encrypted', encryptionKey: 'private-key' }),
    read: async () => { reads += 1; return Buffer.from('photo'); },
    upload: async () => { writes += 1; return { ...winner, fileId: 'loser' }; },
    commit: async () => winner,
    remove: async fileId => deleted.push(fileId),
  });
  const results = await Promise.all(Array.from({ length: 8 }, () => delivery.prepare('archive', {}, 'detail')));
  assert.equal(reads, 1);
  assert.equal(writes, 1);
  assert.ok(results.every(result => result === winner));
  assert.deepEqual(deleted, ['loser']);
});

test('failed migration removes its unreferenced copy and can be retried', async () => {
  let denied = true;
  const removed = [];
  const delivery = createImageDelivery({
    source: async () => ({ fileId: 'encrypted' }), read: async () => Buffer.from('photo'),
    upload: async () => ({ fileId: 'candidate' }),
    commit: async () => { if (denied) throw new Error('revoked'); return { fileId: 'candidate' }; },
    remove: async fileId => removed.push(fileId),
  });
  await assert.rejects(delivery.prepare('archive', {}, 'card'), /revoked/);
  assert.deepEqual(removed, ['candidate']);
  denied = false;
  assert.equal((await delivery.prepare('archive', {}, 'card')).fileId, 'candidate');
});

test('signed addresses must be HTTPS and successful', async () => {
  let url = 'http://insecure.example.test/photo';
  const delivery = createImageDelivery({
    source: async () => ({ delivery: { version: 1, fileId: 'photo' } }),
    sign: async () => ({ status: 0, tempFileURL: url }),
  });
  await assert.rejects(delivery.manifest('archive', {}, 'card'), { code: 'IMAGE_URL' });
  url = 'https://storage.example.test/photo';
  assert.equal((await delivery.manifest('archive', {}, 'card')).url, url);
});

test('a screenful of images uses one signing request, mapping results by ID rather than order', async () => {
  const calls = [];
  const sign = createImageSigner(async files => {
    calls.push(files);
    return files.toReversed().map(file => ({ fileID: file.fileID, status: 0, tempFileURL: `https://storage.example.test/${file.fileID}` }));
  });
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => sign(`image-${index}`)));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].every(file => file.maxAge === 300));
  results.forEach((result, index) => assert.equal(result.fileID, `image-${index}`));
});

test('signing respects the provider batch size and propagates failures without hanging callers', async () => {
  const sizes = [];
  const sign = createImageSigner(async files => { sizes.push(files.length); return files.map(file => ({ fileID: file.fileID })); });
  await Promise.all(Array.from({ length: 51 }, (_, index) => sign(`image-${index}`)));
  assert.deepEqual(sizes, [50, 1]);
  const failed = createImageSigner(async () => { throw new Error('offline'); });
  await assert.rejects(failed('photo'), /offline/);
});
