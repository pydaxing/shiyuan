import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createApplication } from '../server/application.mjs';
import { createImageDelivery, createImageSigner } from '../server/image-delivery.mjs';
import { diagnose, measure } from '../server/performance.mjs';
import { memoryRepository } from './helpers/memory-repository.js';
import { createSeed } from '../src/data/seed.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const clock = Date.parse('2026-09-30T03:00:00Z');
const userId = digest('latency-alice');
const sleep = duration => new Promise(resolve => setTimeout(resolve, duration));

async function fixture({ latency = 15, images = 6, legacyCards = false } = {}) {
  const storage = memoryRepository();
  const seed = createSeed();
  const family = { ...seed.family, id: 'family-latency', ownerId: userId, members: [{ id: userId, name: '我', avatar: '', isChef: false }], revision: 1 };
  await storage.set('users', userId, { familyId: family.id, familyIds: [family.id], name: '我' });
  await storage.set('families', family.id, family);
  const requests = [];
  for (let index = 0; index < images; index += 1) {
    const postId = `post-${String(index).padStart(3, '0')}`;
    const fileId = `cloud://latency-test/approved/original-${index}.bin`;
    const recipe = { ...seed.recipes[0], id: `recipe-${index}`, image: fileId };
    const card = { id: postId, title: recipe.title, kind: 'dish', image: fileId, author: '作者', categories: [recipe.category], publisherId: 'publisher', recipes: [{ id: recipe.id, title: recipe.title, category: recipe.category, image: fileId, minutes: recipe.minutes }] };
    await storage.set('posts', postId, { ...card, card: legacyCards ? undefined : card, assetIds: [fileId], status: 'published', recipes: [recipe] });
    const delivery = { version: 1, fileId: `private-card-${index}`, contentType: 'image/jpeg', bytes: 17000 };
    await storage.set('media', digest(fileId), { familyId: 'public-source', fileId, confirmed: true, encryptionKey: 'private-key', variants: { card: { delivery, formatVersion: 1 }, detail: { delivery, formatVersion: 1 } } });
    requests.push({ fileId, variant: 'card', postId, transport: 'url' });
  }
  const operations = [];
  const timed = async (method, collection, detail, callback) => {
    const entry = { method, collection, detail, start: performance.now() };
    operations.push(entry);
    try { return await measure(`db.${method}.${collection}`, async () => { await sleep(latency); return callback(); }); }
    finally { entry.end = performance.now(); }
  };
  const project = (row, options) => !row || !options?.fields ? row : Object.fromEntries(['_id', ...options.fields].filter(field => row[field] !== undefined).map(field => [field, row[field]]));
  const repository = {
    ...storage,
    get: (collection, id, options) => timed('get', collection, { id, ...options }, async () => project(await storage.get(collection, id), options)),
    getMany: (collection, ids, options) => timed('getMany', collection, { ids, ...options }, async () => (await Promise.all(ids.map(id => storage.get(collection, id)))).filter(Boolean).map(row => project(row, options))),
    list: (collection, where, options) => timed('list', collection, options, () => storage.list(collection, where, options)),
  };
  const signedFiles = [];
  const delivery = createImageDelivery({
    source: (fileId, record, variant) => record.variants[variant],
    sign: createImageSigner(files => measure('storage.sign', async () => {
      signedFiles.push(files.map(file => file.fileID));
      await sleep(latency);
      return files.map(file => ({ fileID: file.fileID, status: 0, maxAge: 300, tempFileURL: 'https://storage.example.test/private' }));
    })),
    now: () => clock,
  });
  const reads = [];
  const app = createApplication({
    repository,
    now: () => clock,
    signFiles: async ids => Object.fromEntries(ids.map(id => [id, { protected: true }])),
    readImage: (fileId, record, variant, options) => {
      reads.push({ fileId, variant, options });
      return options.transport === 'url' ? delivery.manifest(fileId, record, variant) : { base64: 'cGhvdG8=', contentType: 'image/jpeg' };
    },
  });
  const call = (action, event = {}, openid = 'latency-alice') => diagnose(() => app({ action, ...event }, { OPENID: openid }), false);
  return { storage, repository, family, requests, operations, signedFiles, reads, call };
}

function report(context, label, server, result) {
  context.diagnostic(JSON.stringify({ label, injectedDatabaseDelayMs: 15, serverMs: result.diagnostics.serverMs, databaseCalls: server.operations.length, databaseOperations: server.operations.map(({ method, collection }) => `${method}.${collection}`), signingBatches: server.signedFiles.length }));
}

test('six public card images share batched metadata reads and overlap membership checks', async context => {
  const server = await fixture();
  const result = await server.call('mediaBatch', { images: server.requests });
  assert.equal(result.ok, true);
  assert.ok(result.data.images.every(image => image.ok));
  report(context, 'six-public-cards', server, result);
  assert.equal(server.operations.filter(item => item.collection === 'media').length, 1);
  assert.equal(server.operations.filter(item => item.collection === 'posts').length, 1);
  assert.equal(server.operations.length, 4);
  const metadata = server.operations.find(item => item.collection === 'media');
  const user = server.operations.find(item => item.collection === 'users');
  assert.ok(metadata.start < user.end, 'media metadata should start before the user lookup completes');
  assert.deepEqual(server.operations.find(item => item.collection === 'posts').detail.fields, ['status', 'assetIds']);
  assert.equal(server.signedFiles.length, 1);
  assert.equal(JSON.stringify(result).includes('private-key'), false);
});

test('unchanged media versions are reauthorized without signing, reading bytes or duplicate metadata', async context => {
  const server = await fixture({ images: 1 });
  const request = server.requests[0];
  const images = ['card', 'detail', 'card'].map(variant => ({ ...request, variant, knownVersion: `${request.fileId}#display-${variant}-v1` }));
  const result = await server.call('mediaBatch', { images });
  assert.equal(result.ok, true);
  assert.ok(result.data.images.every(image => image.ok && image.data.unchanged));
  report(context, 'cached-card-and-detail-reauthorization', server, result);
  assert.equal(server.operations.filter(item => item.collection === 'media').length, 1);
  assert.equal(server.reads.length, 0);
  assert.equal(server.signedFiles.length, 0);
  await server.storage.set('posts', request.postId, { status: 'deleted', assetIds: [request.fileId] });
  const revoked = await server.call('mediaBatch', { images });
  assert.ok(revoked.data.images.every(image => !image.ok && image.code === 'FORBIDDEN'));
  assert.equal(server.reads.length, 0);
});

test('compact legacy feed cards are backfilled in one read and retain page order', async context => {
  const server = await fixture({ images: 17, legacyCards: true });
  const result = await server.call('feed', { compact: true });
  assert.equal(result.ok, true);
  assert.equal(result.data.posts.length, 16);
  assert.deepEqual(result.data.posts.map(post => post.id), server.requests.slice(0, 16).map(request => request.postId));
  assert.equal(result.data.cursor, server.requests[15].postId);
  report(context, 'sixteen-legacy-cards', server, result);
  assert.equal(server.operations.filter(item => item.collection === 'posts').length, 2);
  assert.ok(result.data.posts.every(post => post.recipes[0].steps === undefined));
});

test('bootstrap rechecks current membership and revision together after reading snapshot data', async context => {
  const server = await fixture();
  const result = await server.call('bootstrap', { includeFeed: false });
  assert.equal(result.ok, true);
  assert.equal(result.data.familyId, server.family.id);
  assert.deepEqual(result.data.snapshot.posts, []);
  report(context, 'bootstrap-consistency-check', server, result);
  const users = server.operations.filter(item => item.collection === 'users');
  const families = server.operations.filter(item => item.collection === 'families');
  assert.equal(users.length, 2);
  assert.equal(families.length, 2);
  const lastList = Math.max(...server.operations.filter(item => item.method === 'list').map(item => item.end));
  assert.ok(users[1].start >= lastList);
  assert.ok(families[1].start >= lastList);
  assert.ok(families[1].start < users[1].end, 'the final family read must overlap the final user read');
});

test('public post lookup overlaps optional membership checks without exposing identifiers to guests', async context => {
  const server = await fixture();
  const result = await server.call('readPost', { postId: server.requests[0].postId, paginateComments: true });
  assert.equal(result.ok, true);
  report(context, 'public-detail', server, result);
  const post = server.operations.find(item => item.collection === 'posts');
  const user = server.operations.find(item => item.collection === 'users');
  assert.ok(post.start < user.end);
  const guest = await server.call('readPost', { postId: server.requests[0].postId, paginateComments: true }, 'unjoined-guest');
  assert.equal(guest.ok, true);
  assert.equal(guest.data.post.publisherId, undefined);
  assert.deepEqual(guest.data.comments, []);
});

test('listFamilies loads membership candidates together but only returns active memberships', async context => {
  const server = await fixture();
  const ids = Array.from({ length: 10 }, (_, index) => `family-${index}`);
  for (const id of ids) await server.storage.set('families', id, { ...server.family, id, deletedAt: id === 'family-8' ? clock : undefined, members: id === 'family-9' ? [] : server.family.members });
  await server.storage.set('users', userId, { familyId: ids[0], familyIds: ids, name: '我' });
  const result = await server.call('listFamilies');
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.families.map(family => family.id), ids.slice(0, 8));
  report(context, 'ten-family-candidates', server, result);
  assert.equal(server.operations.filter(item => item.collection === 'families').length, 1);
  assert.equal(result.data.families.filter(family => family.current).length, 1);
});

test('bootstrap retries a concurrent revision change instead of mixing old metadata with new family data', async () => {
  const server = await fixture({ latency: 0 });
  const list = server.repository.list;
  let updated = false;
  server.repository.list = async (...args) => {
    const result = await list(...args);
    if (!updated && args[0] === 'orders') {
      updated = true;
      await server.storage.set('families', server.family.id, { ...server.family, name: '更新后的家庭', revision: 2 });
    }
    return result;
  };
  const result = await server.call('bootstrap', { includeFeed: false });
  assert.equal(result.ok, true);
  assert.equal(result.data.revision, 2);
  assert.equal(result.data.snapshot.family.name, '更新后的家庭');
  assert.equal(server.operations.filter(item => item.collection === 'orders').length, 2);
});

test('bootstrap detects a switch during snapshot reads and does not return the previous family', async () => {
  const server = await fixture({ latency: 0 });
  const nextFamily = { ...server.family, id: 'next-family', name: '另一个家庭' };
  await server.storage.set('families', nextFamily.id, nextFamily);
  const list = server.repository.list;
  let switched = false;
  server.repository.list = async (...args) => {
    const result = await list(...args);
    if (!switched && args[0] === 'orders') {
      switched = true;
      await server.storage.set('users', userId, { familyId: nextFamily.id, familyIds: [server.family.id, nextFamily.id] });
    }
    return result;
  };
  const result = await server.call('bootstrap', { includeFeed: false });
  assert.equal(result.ok, true);
  assert.equal(result.data.familyId, nextFamily.id);
  assert.equal(result.data.snapshot.family.name, nextFamily.name);
});

test('bootstrap revalidation rejects a member removed during snapshot reads', async () => {
  const server = await fixture({ latency: 0 });
  const list = server.repository.list;
  server.repository.list = async (...args) => {
    const result = await list(...args);
    if (args[0] === 'orders') await server.storage.set('families', server.family.id, { ...server.family, members: [], revision: 2 });
    return result;
  };
  const result = await server.call('bootstrap', { includeFeed: false });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_FAMILY');
  assert.equal(result.data, undefined);
});

test('unchanged bootstrap still checks active membership and avoids collection reads', async () => {
  const server = await fixture({ latency: 0 });
  const query = { includeFeed: false, knownFamilyId: server.family.id, knownRevision: 1 };
  const result = await server.call('bootstrap', query);
  assert.equal(result.ok, true);
  assert.equal(result.data.unchanged, true);
  assert.equal(server.operations.length, 2);
  assert.ok(server.operations.every(operation => operation.method === 'get'));
  await server.storage.set('families', server.family.id, { ...server.family, deletedAt: clock });
  assert.equal((await server.call('bootstrap', query)).code, 'NO_FAMILY');
});

test('metadata batch errors stay isolated to the failing image and do not poison later requests', async () => {
  const server = await fixture({ latency: 0, images: 2 });
  const get = server.repository.get;
  const getMany = server.repository.getMany;
  let failing = true;
  server.repository.getMany = (collection, ids, options) => {
    if (failing && collection === 'media') return Promise.reject(new Error('batch temporarily unavailable'));
    return getMany(collection, ids, options);
  };
  server.repository.get = (collection, id, options) => {
    if (failing && collection === 'media' && id === digest(server.requests[0].fileId)) return Promise.reject(Object.assign(new Error('temporary image lookup failure'), { code: 'DB_UNAVAILABLE' }));
    return get(collection, id, options);
  };
  const result = await server.call('mediaBatch', { images: server.requests });
  assert.equal(result.ok, true);
  assert.equal(result.data.images[0].code, 'DB_UNAVAILABLE');
  assert.equal(result.data.images[1].ok, true);
  assert.deepEqual(server.reads.map(read => read.fileId), [server.requests[1].fileId]);
  failing = false;
  const recovered = await server.call('mediaBatch', { images: server.requests });
  assert.ok(recovered.data.images.every(image => image.ok));
});

test('unconfirmed metadata and a published post that does not reference an image never grant access', async () => {
  const server = await fixture({ latency: 0, images: 2 });
  await server.storage.set('media', digest(server.requests[0].fileId), { fileId: server.requests[0].fileId, familyId: server.family.id, confirmed: false });
  await server.storage.set('posts', server.requests[1].postId, { status: 'published', assetIds: [server.requests[0].fileId] });
  const result = await server.call('mediaBatch', { images: server.requests });
  assert.equal(result.ok, true);
  assert.ok(result.data.images.every(image => !image.ok && image.code === 'FORBIDDEN'));
  assert.equal(server.reads.length, 0);
  assert.equal(server.signedFiles.length, 0);
});

test('private metadata and family membership are scoped per request and user, including known versions', async () => {
  const server = await fixture({ latency: 0, images: 1 });
  const request = { ...server.requests[0], postId: undefined, knownVersion: `${server.requests[0].fileId}#display-card-v1` };
  await server.storage.remove('posts', server.requests[0].postId);
  const media = await server.storage.get('media', digest(request.fileId));
  await server.storage.set('media', digest(request.fileId), { ...media, familyId: server.family.id });
  const [owner, outsider] = await Promise.all([
    server.call('mediaBatch', { images: [request] }),
    server.call('mediaBatch', { images: [request] }, 'unjoined-guest'),
  ]);
  assert.equal(owner.data.images[0].data.unchanged, true);
  assert.equal(outsider.data.images[0].code, 'FORBIDDEN');
  await server.storage.set('families', server.family.id, { ...server.family, members: [], revision: 2 });
  assert.equal((await server.call('mediaBatch', { images: [request] })).data.images[0].code, 'FORBIDDEN');
  assert.equal(server.reads.length, 0);
});

test('duplicate variants without post hints share the public-reference lookup and legacy bytes remain supported', async () => {
  const server = await fixture({ latency: 0, images: 1 });
  const fileId = server.requests[0].fileId;
  const images = ['card', 'detail', 'card'].map(variant => ({ fileId, variant }));
  const result = await server.call('mediaBatch', { images });
  assert.equal(result.ok, true);
  assert.ok(result.data.images.every(image => image.ok && image.data.base64 === 'cGhvdG8='));
  assert.equal(server.operations.filter(operation => operation.collection === 'media').length, 1);
  assert.equal(server.operations.filter(operation => operation.method === 'list' && operation.collection === 'posts').length, 1);
  assert.equal(JSON.stringify(result).includes('private-key'), false);
});

test('opt-in bootstrap manifests cover the first screen without another family authorization read', async context => {
  const server = await fixture();
  const family = { ...server.family, cover: server.requests[0].fileId, members: [{ ...server.family.members[0], avatar: server.requests[1].fileId }] };
  await server.storage.set('families', family.id, family);
  for (const request of server.requests.slice(0, 4)) {
    const post = await server.storage.get('posts', request.postId);
    await server.storage.set('recipes', digest(`${family.id}:${post.recipes[0].id}`), { familyId: family.id, value: post.recipes[0] });
  }
  const result = await server.call('bootstrap', { includeFeed: false, includeImageManifests: true });
  assert.equal(result.ok, true);
  assert.equal(result.data.imageManifests.length, 5);
  assert.equal(result.data.imageManifests[0].fileId, family.cover);
  assert.equal(result.data.imageManifests[0].variant, 'detail');
  assert.equal(result.data.imageManifests[1].fileId, family.members[0].avatar);
  assert.equal(result.data.imageManifests[1].variant, 'card');
  assert.equal(server.operations.filter(item => item.collection === 'users').length, 2);
  assert.equal(server.operations.filter(item => item.collection === 'families').length, 2);
  assert.equal(server.operations.filter(item => item.collection === 'media').length, 1);
  assert.ok(result.data.imageManifests.every(image => image.url && !image.base64 && image.variant !== 'original' && image.urlExpiresAt === clock + 300000));
  assert.ok(server.reads.every(read => read.options.preparedOnly === true));
  report(context, 'bootstrap-with-inline-manifests', server, result);
  server.operations.length = 0;
  const unchanged = await server.call('bootstrap', { includeFeed: false, includeImageManifests: true, knownFamilyId: family.id, knownRevision: 1 });
  assert.equal(unchanged.data.unchanged, true);
  assert.equal(unchanged.data.imageManifests.length, 2);
  assert.ok(server.operations.every(operation => operation.method !== 'list'));
  assert.equal(JSON.stringify(result).includes('private-key'), false);
});

test('opt-in feed manifests use the projected published asset list and never a second post or membership lookup', async context => {
  const server = await fixture({ images: 17 });
  const result = await server.call('feed', { compact: true, includeImageManifests: true });
  assert.equal(result.ok, true);
  assert.equal(result.data.posts.length, 16);
  assert.equal(result.data.imageManifests.length, 6);
  assert.deepEqual(result.data.imageManifests.map(image => image.fileId), server.requests.slice(0, 6).map(request => request.fileId));
  assert.ok(result.data.imageManifests.every(image => image.variant === 'card'));
  assert.equal(server.operations.length, 4);
  assert.deepEqual(server.operations.find(operation => operation.collection === 'posts').detail.fields, ['card', 'assetIds', 'id', 'familyId', 'familyItemId', 'familyKind', 'publisherId', 'publisherType']);
  assert.equal(server.signedFiles.length, 1);
  report(context, 'feed-with-inline-manifests', server, result);
  const ordinary = await server.call('feed', { compact: true, includeImageManifests: 'true' });
  assert.equal(ordinary.data.imageManifests, undefined);
});

test('a compact card cannot smuggle an unrelated private image into inline manifests', async () => {
  const server = await fixture({ latency: 0, images: 1 });
  const source = await server.storage.get('posts', server.requests[0].postId);
  const fileId = 'cloud://latency-test/private/not-published.bin';
  const media = await server.storage.get('media', digest(server.requests[0].fileId));
  await server.storage.set('media', digest(fileId), { ...media, fileId, familyId: 'another-private-family' });
  await server.storage.set('posts', source.id, { ...source, card: { ...source.card, image: fileId } });
  const result = await server.call('feed', { compact: true, includeImageManifests: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.imageManifests, []);
  assert.equal(server.reads.length, 0);
});

test('public detail manifests cover both thumbnail and tutorial sizes and still work for an unjoined guest', async () => {
  const server = await fixture({ latency: 0, images: 4 });
  const post = await server.storage.get('posts', server.requests[0].postId);
  const photos = server.requests.slice(1).map(request => request.fileId);
  await server.storage.set('posts', post.id, { ...post, assetIds: [...post.assetIds, ...photos], recipes: [{ ...post.recipes[0], steps: [{ text: '准备食材', images: photos.slice(0, 2) }, { text: '开火烹饪', image: photos[2] }] }] });
  const result = await server.call('readPost', { postId: post.id, paginateComments: true, includeImageManifests: true }, 'unjoined-guest');
  assert.equal(result.ok, true);
  assert.equal(result.data.imageManifests.length, 5);
  assert.deepEqual(result.data.imageManifests.map(image => image.variant), ['detail', 'card', 'detail', 'detail', 'detail']);
  assert.equal(result.data.post.publisherId, undefined);
  assert.deepEqual(result.data.comments, []);
  const reads = server.reads.length;
  await server.storage.set('posts', post.id, { ...post, status: 'deleted' });
  assert.equal((await server.call('readPost', { postId: post.id, includeImageManifests: true }, 'unjoined-guest')).ok, false);
  assert.equal(server.reads.length, reads);
});

test('existing callers do not trigger manifest reads unless the optional flag is explicitly true', async () => {
  const server = await fixture({ latency: 0 });
  for (const [action, options] of [['bootstrap', { includeFeed: false }], ['feed', { compact: true }], ['readPost', { postId: server.requests[0].postId, paginateComments: true }]]) {
    const result = await server.call(action, options);
    assert.equal(result.ok, true);
    assert.equal(result.data.imageManifests, undefined);
  }
  assert.equal(server.reads.length, 0);
  assert.equal(server.operations.some(operation => operation.collection === 'media'), false);
});
