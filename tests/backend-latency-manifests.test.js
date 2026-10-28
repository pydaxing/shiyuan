import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createImageManifestReader } from '../server/image-manifests.mjs';
import { diagnose, measure } from '../server/performance.mjs';

const now = 1700000000000;
const hash = value => createHash('sha256').update(value).digest('hex');
const candidate = (index, variant = 'card') => ({ fileId: `cloud://test/approved/photo-${index}.bin`, variant });
const manifest = overrides => ({ url: 'https://storage.example.test/private', urlExpiresAt: now + 300000, bytes: 17000, contentType: 'image/jpeg', ...overrides });

function fixture(count = 8) {
  const records = new Map();
  const reads = [];
  const databaseReads = [];
  for (let index = 0; index < count; index += 1) {
    const { fileId } = candidate(index);
    records.set(hash(fileId), { confirmed: true, fileId, familyId: 'private-family', encryptionKey: 'must-remain-server-side', variants: { card: { formatVersion: 1, delivery: { version: 1 } }, detail: { formatVersion: 1, delivery: { version: 1 } } } });
  }
  const repository = {
    async get(collection, id) { databaseReads.push({ collection, ids: [id] }); return records.get(id) || null; },
    async getMany(collection, ids) { databaseReads.push({ collection, ids }); return ids.map(id => ({ _id: id, ...records.get(id) })); },
  };
  const readImage = async (fileId, record, variant, options) => { reads.push({ fileId, variant, options }); return manifest(); };
  return { records, repository, reads, databaseReads, readImage };
}

test('inline manifests are deduplicated, limited to six derivatives, explicitly authorized and contain no private metadata', async () => {
  const server = fixture();
  const load = createImageManifestReader({ repository: server.repository, readImage: server.readImage, now: () => now });
  const candidates = [{ fileId: '/static/default.png', variant: 'card' }, candidate(0, 'original'), candidate(0), candidate(0), ...Array.from({ length: 8 }, (_, index) => candidate(index))];
  const images = await load(candidates, record => record.familyId === 'private-family');
  assert.equal(images.length, 6);
  assert.deepEqual(images.map(image => image.fileId), Array.from({ length: 6 }, (_, index) => candidate(index).fileId));
  assert.equal(server.databaseReads.length, 1);
  assert.equal(server.databaseReads[0].ids.length, 6);
  assert.ok(server.reads.every(read => read.variant !== 'original' && read.options.transport === 'url' && read.options.preparedOnly === true));
  assert.ok(images.every(image => image.urlExpiresAt === now + 300000 && image.version === `${image.fileId}#display-card-v1`));
  assert.equal(JSON.stringify(images).includes('must-remain-server-side'), false);
  const reads = server.reads.length;
  assert.deepEqual(await load([candidate(7)], () => false), []);
  assert.equal(server.reads.length, reads);
});

test('missing thumbnails, unconfirmed files, wrong records and unavailable private delivery never fetch originals', async () => {
  const server = fixture(4);
  server.records.get(hash(candidate(0).fileId)).variants.card = undefined;
  server.records.get(hash(candidate(1).fileId)).confirmed = false;
  server.records.get(hash(candidate(2).fileId)).fileId = candidate(3).fileId;
  const load = createImageManifestReader({ repository: server.repository, now: () => now, readImage: async (fileId, record, variant, options) => {
    assert.equal(fileId, candidate(3).fileId);
    assert.equal(options.preparedOnly, true);
    assert.equal(variant, 'card');
    return null;
  } });
  assert.deepEqual(await load(Array.from({ length: 4 }, (_, index) => candidate(index)), () => true), []);
});

test('inline manifests validate HTTPS, byte limits and expiry while stripping base64 and provider extras', async () => {
  const server = fixture(6);
  const responses = [
    manifest({ url: 'http://storage.example.test/insecure' }),
    manifest({ urlExpiresAt: now }),
    manifest({ bytes: 80001 }),
    manifest({ contentType: 'image/heic' }),
    { base64: 'original-bytes', contentType: 'image/jpeg' },
    manifest({ urlExpiresAt: now + 86400000, base64: 'must-not-be-returned', encryptionKey: 'never-return-this' }),
  ];
  const load = createImageManifestReader({ repository: server.repository, now: () => now, readImage: async fileId => responses[Number(fileId.match(/photo-(\d+)/)[1])] });
  const images = await load(Array.from({ length: 6 }, (_, index) => candidate(index)), () => true);
  assert.equal(images.length, 1);
  assert.equal(images[0].fileId, candidate(5).fileId);
  assert.equal(images[0].urlExpiresAt, now + 300000);
  assert.deepEqual(Object.keys(images[0]), ['fileId', 'variant', 'version', 'url', 'urlExpiresAt', 'bytes', 'contentType']);
});

test('a slow optional image has a bounded wait, retains fast images and cannot mutate an already returned response', { timeout: 3000 }, async () => {
  const server = fixture(2);
  let finishSlow;
  const load = createImageManifestReader({ repository: server.repository, now: () => now, readImage: async fileId => {
    if (fileId === candidate(1).fileId) return measure('storage.sign.slow', () => new Promise(resolve => { finishSlow = () => resolve(manifest()); }));
    return manifest();
  } });
  const result = await diagnose(async () => ({ ok: true, data: { title: '正文不受影响', imageManifests: await load([candidate(0), candidate(1)], () => true) } }), false);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.imageManifests.map(image => image.fileId), [candidate(0).fileId]);
  assert.ok(result.diagnostics.serverMs >= 200);
  assert.equal(result.diagnostics.spans.some(span => span.operation === 'storage.sign.slow'), false);
  const before = JSON.stringify(result);
  finishSlow();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(JSON.stringify(result), before);
});

test('failed optional metadata or signing does not fail the content response or suppress another completed image', async () => {
  const server = fixture(2);
  const errors = [];
  const load = createImageManifestReader({ repository: server.repository, now: () => now, onError: error => errors.push(error.code), readImage: async fileId => {
    if (fileId === candidate(1).fileId) throw Object.assign(new Error('temporary signer failure'), { code: 'IMAGE_URL' });
    return manifest();
  } });
  assert.deepEqual((await load([candidate(0), candidate(1)], () => true)).map(image => image.fileId), [candidate(0).fileId]);
  assert.deepEqual(errors, ['IMAGE_URL']);
  const unavailable = createImageManifestReader({ repository: { async get() { throw new Error('database unavailable'); } }, readImage: () => assert.fail('bytes must not be read') });
  assert.deepEqual(await unavailable([candidate(0)], () => true), []);
});
