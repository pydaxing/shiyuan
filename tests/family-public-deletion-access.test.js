import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApplication } from '../server/application.mjs';
import { createFamilyDeletionMedia } from '../server/family-deletion-media.mjs';
import { createSeed } from '../src/data/seed.js';
import { memoryRepository } from './helpers/memory-repository.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const file = name => `cloud://test.env/${name}`;
const recipe = createSeed().recipes[0];

function fixture() {
  const repository = memoryRepository();
  let clock = Date.parse('2026-10-28T08:00:00Z');
  let sequence = 0;
  const removed = [], delivered = [], stored = [];
  const cleanupMedia = createFamilyDeletionMedia({
    repository, now: () => clock, resolveStoragePath: async path => file(path),
    removeFiles: async ids => { removed.push(...ids); return { fileList: ids.map(fileID => ({ fileID, status: 0 })) }; },
  });
  const application = createApplication({
    repository, cleanupMedia, now: () => clock, signFiles: async () => ({}),
    storeImage: async fileId => { stored.push(fileId); return { fileId: file(`approved/${hash(fileId)}`), encryptionKey: 'test-only' }; },
    readImage: async (fileId, media, variant) => {
      assert.equal(media.confirmed, true);
      delivered.push({ fileId, variant });
      return { base64: Buffer.from(`${fileId}:${variant}`).toString('base64'), contentType: 'image/jpeg' };
    },
  });
  const call = (action, payload = {}, openid = 'alice') => application({ action, ...payload }, { OPENID: openid });
  const success = async promise => { const result = await promise; assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
  const create = () => success(call('createFamily', { familyName: '发布时的小家', name: 'Alice', requestId: `deletion-access-create-${++sequence}` }));
  const command = (name, args, revision) => success(call('command', { name, args, revision, requestId: `deletion-access-command-${++sequence}`, includeFeed: false }));
  const finish = async result => {
    for (let attempt = 0; result.deletion?.status === 'pending' && attempt < 50; attempt += 1) result = await success(call('continueFamilyDeletion', { familyId: result.deletion.familyId }));
    assert.equal(result.deletion?.status, 'complete');
    return result;
  };
  const media = (familyId, name) => repository.set('media', hash(file(name)), {
    familyId, userId: hash('alice'), fileId: file(name), confirmed: true,
    variants: { card: { fileId: file(`${name}-card`) } },
  });
  return { repository, call, success, create, command, finish, media, removed, delivered, stored, now: () => clock, setTime: value => { clock = value; } };
}

for (const action of ['deleteFamilyWithCleanup', 'leaveFamilyWithCleanup']) {
  for (const appearance of ['cover', 'avatar']) {
    test(`${action} preserves published ${appearance}, identity and recipe image access for an account without a family`, async () => {
      const server = fixture();
      let current = await server.create();
      const familyId = current.familyId;
      const family = await server.repository.get('families', familyId);
      await server.repository.set('families', familyId, { ...family, cover: '', [appearance]: file('public-family') });
      for (const name of ['public-family', 'public-recipe', 'private-recipe']) await server.media(familyId, name);
      const dish = (title, image) => ({ ...recipe, id: '', title, image, steps: recipe.steps.map(step => ({ ...step, image: '', images: [] })) });
      current = await server.command('saveRecipe', [dish('公开菜品', file('public-recipe'))], current.revision);
      const dishId = current.snapshot.recipes[0].id;
      current = await server.command('saveRecipe', [dish('私有菜品', file('private-recipe'))], current.revision);
      current = await server.command('publishToCommunity', [dishId], current.revision);
      const postId = current.value;
      const published = await server.repository.get('posts', postId);
      const originalIdentity = published.familySnapshot;
      assert.equal(originalIdentity.name, family.name);
      assert.equal(originalIdentity.avatar, file('public-family'));
      assert.equal(originalIdentity.cover, appearance === 'cover' ? file('public-family') : '');
      assert.equal(originalIdentity.publicId, family.publicId);
      assert.deepEqual(new Set(published.assetIds), new Set([file('public-family'), file('public-recipe')]));
      assert.equal((await server.success(server.call('bootstrap', {}, 'reader'))).needsFamily, true);
      assert.equal((await server.call('mediaContent', { fileId: file('private-recipe') }, 'reader')).code, 'FORBIDDEN');

      const deleted = await server.finish(await server.success(server.call(action, { familyId, confirmName: family.name })));
      assert.equal(deleted.needsFamily, true);
      assert.equal(deleted.deletion.privateDataCleared, true);
      assert.deepEqual(await server.repository.list('recipes', { familyId }), []);
      assert.equal((await server.repository.get('families', familyId)).deletion.status, 'complete');

      const retained = await server.repository.get('posts', postId);
      assert.equal(retained.status, 'published');
      assert.equal(retained.author, published.author);
      assert.deepEqual(retained.familySnapshot, originalIdentity);
      assert.deepEqual(retained.card.familySnapshot, originalIdentity);
      assert.deepEqual(new Set(retained.assetIds), new Set(published.assetIds));
      const detail = await server.success(server.call('readPost', { postId }, 'reader'));
      assert.equal(detail.post.author, family.name);
      assert.deepEqual(detail.post.familySnapshot, originalIdentity);
      assert.equal(detail.post.recipes[0].title, '公开菜品');
      assert.equal(detail.post.recipes[0].image, file('public-recipe'));
      for (const privateField of ['familyId', 'familyItemId', 'publisherId', 'assetIds']) assert.equal(detail.post[privateField], undefined);
      for (const name of ['public-family', 'public-recipe']) {
        assert.equal((await server.repository.get('media', hash(file(name)))).confirmed, true);
        for (const variant of ['original', 'card']) {
          for (const hint of [{}, { postId }]) {
            const image = await server.success(server.call('mediaContent', { fileId: file(name), variant, ...hint }, 'reader'));
            assert.equal(Buffer.from(image.base64, 'base64').toString(), `${file(name)}:${variant}`);
          }
        }
      }
      assert.equal(await server.repository.get('media', hash(file('private-recipe'))), null);
      assert.deepEqual(new Set(server.removed), new Set([file('private-recipe'), file('private-recipe-card')]));
      assert.equal((await server.call('mediaContent', { fileId: file('private-recipe'), postId }, 'reader')).code, 'FORBIDDEN');
    });
  }
}

test('family upload tickets reserve their full expiry window and successful confirmation clears the lease', async () => {
  const server = fixture();
  const home = await server.create();
  const issuedAt = server.now();
  const ticket = await server.success(server.call('mediaTicket', { familyId: home.familyId }));
  const reserved = await server.repository.get('media', ticket.id);
  assert.equal(reserved.expiresAt, issuedAt + 3600000);
  assert.equal(reserved.uploadInFlightUntil, reserved.expiresAt);
  server.setTime(reserved.expiresAt - 1);
  const confirmation = await server.success(server.call('mediaConfirm', { familyId: home.familyId, ticket: ticket.id, fileId: file(ticket.path) }));
  const settled = await server.repository.get('media', ticket.id);
  assert.equal(settled.uploadInFlightUntil, 0);
  assert.equal(settled.expiresAt, reserved.expiresAt);
  assert.deepEqual(settled.result, confirmation);
  assert.equal((await server.repository.get('media', hash(confirmation.fileId))).confirmed, true);
  assert.deepEqual(server.stored, [file(ticket.path)]);
});

test('confirmation rejects a ticket exactly at expiry before storing any media', async () => {
  const server = fixture();
  const home = await server.create();
  const ticket = await server.success(server.call('mediaTicket'));
  const reserved = await server.repository.get('media', ticket.id);
  server.setTime(reserved.expiresAt);
  const result = await server.call('mediaConfirm', { familyId: home.familyId, ticket: ticket.id, fileId: file(ticket.path) });
  assert.equal(result.code, 'FORBIDDEN');
  assert.match(result.message, /上传授权已过期/);
  assert.deepEqual(server.stored, []);
  assert.equal((await server.repository.get('media', ticket.id)).result, undefined);
});

for (const elapsed of [0, 1]) test(`deletion waits for an unconfirmed upload until expiry and reclaims it at expiry + ${elapsed} ms`, async () => {
  const server = fixture();
  const home = await server.create();
  const ticket = await server.success(server.call('mediaTicket'));
  const reserved = await server.repository.get('media', ticket.id);
  let result = await server.success(server.call('deleteFamilyWithCleanup', { familyId: home.familyId, confirmName: '发布时的小家' }));
  assert.equal(result.deletion.status, 'pending');
  assert.equal(result.deletion.reason, 'UPLOAD_IN_FLIGHT');
  server.setTime(reserved.expiresAt - 1);
  result = await server.success(server.call('continueFamilyDeletion', { familyId: home.familyId }));
  assert.equal(result.deletion.status, 'pending');
  assert.equal(result.deletion.reason, 'UPLOAD_IN_FLIGHT');
  assert.ok(await server.repository.get('media', ticket.id));
  assert.deepEqual(server.removed, []);
  assert.equal((await server.call('mediaConfirm', { familyId: home.familyId, ticket: ticket.id, fileId: file(ticket.path) })).code, 'NO_FAMILY');
  assert.deepEqual(server.stored, []);
  server.setTime(reserved.expiresAt + elapsed);
  result = await server.finish(await server.success(server.call('continueFamilyDeletion', { familyId: home.familyId })));
  assert.equal(result.deletion.status, 'complete');
  assert.equal(await server.repository.get('media', ticket.id), null);
  assert.deepEqual(new Set(server.removed), new Set([file(ticket.path), file(ticket.previewPath)]));
});
