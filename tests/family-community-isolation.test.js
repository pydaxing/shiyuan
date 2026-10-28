import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApplication as createSourceApplication } from '../server/application.mjs';
import { loadCloudApplication } from './helpers/cloud-bundle.js';
import { createSeed } from '../src/data/seed.js';
import { memoryRepository } from './helpers/memory-repository.js';

const createApplication = process.env.KITCHEN_TEST_BUNDLE ? await loadCloudApplication(process.env.KITCHEN_TEST_BUNDLE) : createSourceApplication;
const digest = value => createHash('sha256').update(value).digest('hex');
const recipe = createSeed().recipes[0];

function fixture() {
  const repository = memoryRepository();
  const app = createApplication({ repository, now: () => Date.parse('2026-10-27T03:00:00Z'), signFiles: async () => ({}), storeImage: async fileId => fileId });
  let sequence = 0;
  const call = (action, payload = {}, openid = 'alice') => app({ action, ...payload }, { OPENID: openid });
  const create = (openid = 'alice', name = '同名的家') => ok(call('createFamily', { name: openid, familyName: name, requestId: `create-family-${++sequence}` }, openid));
  const command = (name, args, current, openid = 'alice', extra = {}) => call('command', { name, args, revision: current.revision, familyId: current.familyId, requestId: `isolation-command-${++sequence}`, includeFeed: false, ...extra }, openid);
  return { repository, call, create, command };
}

async function ok(promise) {
  const result = await promise;
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}

async function publish(server, openid = 'alice') {
  let current = await server.create(openid);
  current = await ok(server.command('saveRecipe', [recipe], current, openid));
  current = await ok(server.command('publishToCommunity', [current.snapshot.recipes[0].id], current, openid));
  return current;
}

test('identical family names never grant access to private recipes, publication status or deletion', async () => {
  const server = fixture();
  const source = await publish(server);
  const post = await server.repository.get('posts', source.value);
  const other = await server.create('bob');
  assert.equal(source.snapshot.family.name, other.snapshot.family.name);
  assert.notEqual(source.familyId, other.familyId);
  assert.equal(source.familyId, source.snapshot.family.id);
  assert.equal(other.familyId, other.snapshot.family.id);
  assert.deepEqual(other.snapshot.recipes, []);
  assert.deepEqual(other.snapshot.sharedItems, []);
  assert.equal((await server.command('deleteCommunityPost', [post.id], other, 'bob')).code, 'FORBIDDEN');
  assert.equal((await server.command('deleteCommunityPost', [post.id], other, 'bob', { familyId: source.familyId })).code, 'CONFLICT');
  assert.deepEqual(await server.repository.get('posts', post.id), post);
  const feed = await ok(server.call('feed', { compact: true }, 'bob'));
  const card = feed.posts.find(item => item.id === post.id);
  assert.equal(card.familyId, source.familyId);
  assert.equal(card.publisherId, digest('alice'));
});

test('a publisher must return to the original family to delete its share', async () => {
  const server = fixture();
  const source = await publish(server);
  const other = await server.create();
  assert.notEqual(source.familyId, other.familyId);
  assert.equal((await server.command('deleteCommunityPost', [source.value], other)).code, 'FORBIDDEN');
  const original = await ok(server.call('switchFamily', { familyId: source.familyId }));
  await ok(server.command('deleteCommunityPost', [source.value], original));
  assert.equal((await server.repository.get('posts', source.value)).status, 'deleted');
});

test('compact cards restore ownership from the authoritative post, overriding stale or forged cached metadata', async () => {
  const server = fixture();
  const source = await publish(server);
  const post = await server.repository.get('posts', source.value);
  const other = await server.create('bob');
  await server.repository.set('posts', post.id, { ...post, card: { ...post.card, familyId: other.familyId, publisherId: digest('bob'), familyItemId: 'foreign-dish' } });
  const feed = await ok(server.call('feed', { compact: true }, 'bob'));
  assert.equal(feed.posts[0].familyId, source.familyId);
  assert.equal(feed.posts[0].publisherId, digest('alice'));
  assert.equal(feed.posts[0].familyItemId, post.familyItemId);
  const { familyId, ...unowned } = post;
  await server.repository.set('posts', post.id, { ...unowned, card: { ...post.card, familyId: other.familyId } });
  const legacy = await ok(server.call('feed', { compact: true }, 'bob'));
  assert.equal(legacy.posts[0].familyId, '');
  assert.equal((await server.command('deleteCommunityPost', [post.id], other, 'bob')).code, 'FORBIDDEN');
});

test('importing and sharing a dish makes an independent copy owned by the destination family', async () => {
  const server = fixture();
  const source = await publish(server);
  const originalPost = await server.repository.get('posts', source.value);
  let destination = await server.create('bob');
  destination = await ok(server.command('addCollection', [{ id: originalPost.id, familyId: source.familyId, publisherId: digest('alice') }], destination, 'bob'));
  const imported = destination.snapshot.recipes[0];
  assert.notEqual(imported.id, originalPost.familyItemId);
  const recipeRow = (await server.repository.list('recipes', { familyId: destination.familyId }))[0];
  assert.equal(recipeRow.value.id, imported.id);
  destination = await ok(server.command('saveRecipe', [{ ...imported, title: '我家的独立副本' }, imported.id], destination, 'bob'));
  destination = await ok(server.command('publishToCommunity', [imported.id], destination, 'bob'));
  const reshared = await server.repository.get('posts', destination.value);
  assert.equal(reshared.familyId, destination.familyId);
  assert.equal(reshared.card.familyId, destination.familyId);
  assert.equal(reshared.publisherId, digest('bob'));
  assert.equal(reshared.familyItemId, imported.id);
  assert.equal(reshared.author, destination.snapshot.family.name);
  assert.notEqual(reshared.id, originalPost.id);
  assert.equal(reshared.title, '我家的独立副本');
  assert.deepEqual(await server.repository.get('posts', originalPost.id), { ...originalPost, importedFamilyCount: 1, card: { ...originalPost.card, importedFamilyCount: 1 } });
  assert.equal((await server.command('deleteCommunityPost', [originalPost.id], destination, 'bob')).code, 'FORBIDDEN');
  await ok(server.command('deleteCommunityPost', [reshared.id], destination, 'bob'));
  assert.equal((await server.repository.get('posts', originalPost.id)).status, 'published');
});

test('friend share snapshots retain the source family ID even with a matching family name', async () => {
  const server = fixture();
  const source = await publish(server);
  const shared = await ok(server.call('createDishShare', { familyId: source.familyId, itemId: source.snapshot.recipes[0].id, kind: 'dish' }));
  const read = await ok(server.call('readShare', { token: shared.token }, 'visitor'));
  const stored = await server.repository.get('shares', digest(shared.token));
  assert.equal(stored.post.familyId, source.familyId);
  assert.equal(stored.post.publisherId, digest('alice'));
  assert.equal(read.post.familyId, undefined);
  assert.equal(read.post.publisherId, undefined);
  await server.create('bob');
  const destination = await ok(server.call('importShare', { token: shared.token }, 'bob'));
  assert.equal(destination.snapshot.recipes.length, 1);
  assert.notEqual(destination.snapshot.recipes[0].id, source.snapshot.recipes[0].id);
  const reshared = await ok(server.command('publishToCommunity', [destination.snapshot.recipes[0].id], destination, 'bob'));
  assert.equal((await server.repository.get('posts', reshared.value)).familyId, destination.familyId);
});

test('saving a recipe requires a title for every step while the step body is optional', async () => {
  const server = fixture();
  const current = await server.create();
  for (const steps of [[], [{ text: '切好后煮熟' }], [{ title: '   ', text: '切好后煮熟' }]]) {
    assert.equal((await server.command('saveRecipe', [{ ...recipe, steps }], current)).code, 'INVALID');
  }
  const saved = await ok(server.command('saveRecipe', [{ ...recipe, steps: [{ title: '切好后煮熟' }] }], current));
  assert.equal(saved.snapshot.recipes[0].steps[0].title, '切好后煮熟');
  const imported = await server.repository.list('recipes', { familyId: current.familyId });
  assert.equal(imported.length, 1);
});

test('cloud imports isolate reused recipe IDs from different source families and retain exact set membership', async () => {
  const server = fixture();
  const first = await server.create('alice');
  const second = await server.create('bob');
  const sources = [first, second];
  for (const [index, source] of sources.entries()) {
    const recipes = createSeed().recipes.slice(0, 2).map((entry, recipeIndex) => ({ ...entry, id: `legacy-shared-${recipeIndex}`, title: `${index ? '乙' : '甲'}家${entry.title}` }));
    const post = { id: `legacy-menu-${index}`, familyId: source.familyId, familyItemId: 'same-local-set-id', familyKind: 'set', publisherId: source.userId, publisherType: 'user', status: 'published', kind: 'menu', title: '同名套餐', author: '同名的家', image: '', recipes, createdAt: index + 1 };
    await server.repository.set('posts', post.id, post);
  }
  let target = await server.create('carol');
  for (const index of [0, 1]) target = await ok(server.command('addCollection', [{ id: `legacy-menu-${index}` }], target, 'carol'));
  assert.equal(target.snapshot.recipes.length, 4);
  assert.equal(new Set(target.snapshot.recipes.map(entry => entry.id)).size, 4);
  assert.equal(new Set(target.snapshot.recipes.map(entry => entry.shareId)).size, 4);
  assert.equal(target.snapshot.mealSets.length, 2);
  for (const set of target.snapshot.mealSets) {
    assert.ok(set.shareId);
    const members = set.recipeIds.map(id => target.snapshot.recipes.find(entry => entry.id === id));
    assert.equal(members.length, 2);
    assert.ok(members.every(entry => entry.sourceFamilyId === set.sourceFamilyId && entry.sourcePostId === set.sourcePostId));
  }
  target = await ok(server.command('addCollection', [{ id: 'legacy-menu-0' }], target, 'carol'));
  assert.equal(target.snapshot.recipes.length, 4);
  assert.equal(target.snapshot.mealSets.length, 2);
  const copied = target.snapshot.recipes[0];
  target = await ok(server.command('publishToCommunity', [copied.id], target, 'carol'));
  const reshared = await server.repository.get('posts', target.value);
  assert.equal(reshared.familyId, target.familyId);
  assert.equal(reshared.recipes[0].id, copied.shareId);
  assert.notEqual(reshared.recipes[0].id, copied.sourceId);
});
