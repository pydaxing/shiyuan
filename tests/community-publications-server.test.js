import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApplication as createSourceApplication } from '../server/application.mjs';
import { loadCloudApplication } from './helpers/cloud-bundle.js';
import { createSeed } from '../src/data/seed.js';
import { memoryRepository } from './helpers/memory-repository.js';

const createApplication = process.env.KITCHEN_TEST_BUNDLE ? await loadCloudApplication(process.env.KITCHEN_TEST_BUNDLE) : createSourceApplication;
const recipe = createSeed().recipes[0];
const digest = value => createHash('sha256').update(value).digest('hex');

function fixture() {
  const repository = memoryRepository();
  const app = createApplication({ repository, now: () => Date.parse('2026-10-20T03:00:00Z'), signFiles: async () => ({}), storeImage: async fileId => fileId });
  let sequence = 0;
  const call = (action, payload = {}, openid = 'alice') => app({ action, ...payload }, { OPENID: openid });
  const command = (name, args, revision, openid = 'alice', requestId = `sharing-request-${++sequence}`) => call('command', { name, args, revision, requestId, includeFeed: false }, openid);
  return { repository, call, command };
}

async function success(promise) {
  const result = await promise;
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}

async function family(server, openid = 'alice') {
  return success(server.call('createFamily', { name: openid, familyName: `${openid}的小家` }, openid));
}

async function savedDish(server) {
  const home = await family(server);
  return success(server.command('saveRecipe', [recipe], home.revision));
}

test('publishing the same dish twice fails without altering the existing post or family revision', async () => {
  const server = fixture();
  let current = await savedDish(server);
  const dishId = current.snapshot.recipes[0].id;
  current = await success(server.command('publishToCommunity', [dishId], current.revision));
  const original = await server.repository.get('posts', current.value);
  await server.repository.set('posts', original.id, { ...original, importedFamilyCount: 12 });
  const before = await server.repository.get('posts', original.id);
  assert.deepEqual(current.snapshot.sharedItems, [{ kind: 'dish', itemId: dishId, postId: original.id }]);
  const duplicate = await server.command('publishToCommunity', [dishId], current.revision);
  assert.equal(duplicate.code, 'ALREADY_SHARED');
  assert.deepEqual(await server.repository.get('posts', original.id), before);
  assert.equal((await server.repository.list('posts')).length, 1);
  assert.equal((await server.repository.get('families', current.familyId)).revision, current.revision);
});

test('sharing is unique per family and kind, including when another family member publishes', async () => {
  const server = fixture();
  let current = await savedDish(server);
  const dishId = current.snapshot.recipes[0].id;
  const invitation = await success(server.call('createInvite'));
  current = await success(server.call('joinFamily', { code: invitation.code, name: 'Bob' }, 'bob'));
  current = await success(server.command('saveRecipe', [{ ...recipe, id: '', title: '另一道菜' }], current.revision));
  current = await success(server.command('saveMealSet', [{ title: '家庭套餐', image: '', recipeIds: current.snapshot.recipes.map(item => item.id) }], current.revision));
  const setId = current.snapshot.mealSets[0].id;
  current = await success(server.command('publishToCommunity', [dishId], current.revision));
  const dishPostId = current.value;
  assert.equal((await server.command('publishToCommunity', [dishId], current.revision, 'bob')).code, 'ALREADY_SHARED');
  assert.equal((await server.command('deleteCommunityPost', [dishPostId], current.revision, 'bob')).code, 'FORBIDDEN');
  current = await success(server.command('publishToCommunity', [setId, 'set'], current.revision, 'bob'));
  assert.equal((await server.command('publishToCommunity', [setId, 'set'], current.revision)).code, 'ALREADY_SHARED');
  assert.equal(current.snapshot.sharedItems.length, 2);
  assert.deepEqual(new Set(current.snapshot.sharedItems.map(item => item.kind)), new Set(['dish', 'set']));
});

test('a shared package does not mark its component dishes as shared and matching titles stay independent', async () => {
  const server = fixture();
  let current = await savedDish(server);
  current = await success(server.command('saveRecipe', [{ ...recipe, id: '' }], current.revision));
  current = await success(server.command('saveMealSet', [{ title: recipe.title, image: '', recipeIds: current.snapshot.recipes.map(item => item.id) }], current.revision));
  current = await success(server.command('publishToCommunity', [current.snapshot.mealSets[0].id, 'set'], current.revision));
  assert.deepEqual(current.snapshot.sharedItems.map(item => item.kind), ['set']);
  for (const dish of current.snapshot.recipes) current = await success(server.command('publishToCommunity', [dish.id], current.revision));
  assert.equal(current.snapshot.sharedItems.length, 3);
});

test('concurrent publication and request replay create only one post', async () => {
  const server = fixture();
  const current = await savedDish(server);
  const args = [current.snapshot.recipes[0].id, 'dish'];
  const attempts = await Promise.all([
    server.command('publishToCommunity', args, current.revision, 'alice', 'parallel-sharing-first'),
    server.command('publishToCommunity', args, current.revision, 'alice', 'parallel-sharing-second'),
  ]);
  assert.equal(attempts.filter(result => result.ok).length, 1);
  assert.equal(attempts.find(result => !result.ok).code, 'CONFLICT');
  const first = attempts[0].data;
  const replay = await success(server.command('publishToCommunity', args, current.revision, 'alice', 'parallel-sharing-first'));
  assert.equal(replay.value, first.value);
  assert.equal(replay.snapshot.sharedItems.length, 1);
  assert.equal((await server.repository.list('posts')).length, 1);
});

test('publication status covers all pages using metadata only, and ignores foreign or deleted posts', async () => {
  const server = fixture();
  const current = await family(server);
  for (let index = 0; index < 137; index += 1) {
    const id = `shared-${String(index).padStart(3, '0')}`;
    await server.repository.set('posts', id, { id, familyId: current.familyId, familyItemId: `dish-${index}`, kind: 'recipe', status: 'published', recipes: [{ steps: [{ text: '不得出现在分享状态响应中', image: 'cloud://private/large-image' }] }] });
  }
  await server.repository.set('posts', 'legacy-set', { familyId: current.familyId, familyItemId: 'set-1', kind: 'menu', status: 'published' });
  await server.repository.set('posts', 'official-no-source', { familyId: current.familyId, kind: 'recipe', status: 'published' });
  await server.repository.set('posts', 'deleted', { id: 'deleted', familyId: current.familyId, familyItemId: 'dish-deleted', familyKind: 'dish', status: 'deleted' });
  await server.repository.set('posts', 'foreign', { id: 'foreign', familyId: 'other-home', familyItemId: 'dish-1', familyKind: 'dish', status: 'published' });
  const list = server.repository.list;
  const queries = [];
  server.repository.list = async (collection, where, options) => { if (collection === 'posts') queries.push({ where, options }); return list(collection, where, options); };
  const result = await success(server.call('bootstrap', { includeFeed: false }));
  assert.equal(result.snapshot.sharedItems.length, 138);
  assert.deepEqual(result.snapshot.posts, []);
  assert.equal(new Set(result.snapshot.sharedItems.map(item => item.postId)).size, 138);
  assert.deepEqual(result.snapshot.sharedItems.find(item => item.kind === 'set'), { kind: 'set', itemId: 'set-1', postId: 'legacy-set' });
  assert.ok(result.snapshot.sharedItems.every(item => Object.keys(item).length === 3));
  assert.equal(queries.length, 2);
  assert.ok(queries.every(query => query.options.limit === 100));
  assert.ok(queries.every(query => JSON.stringify(query.options.fields) === JSON.stringify(['id', 'familyItemId', 'familyKind', 'kind'])));
  assert.ok(queries.every(query => query.where.familyId === current.familyId && query.where.status === 'published'));
  assert.ok(queries[1].options.after);
});

test('a stale cache without publication metadata can request it despite an unchanged revision', async () => {
  const server = fixture();
  let current = await savedDish(server);
  current = await success(server.command('publishToCommunity', [current.snapshot.recipes[0].id], current.revision));
  const known = { knownFamilyId: current.familyId, knownRevision: current.revision, includeFeed: false };
  const unchanged = await success(server.call('bootstrap', known));
  assert.equal(unchanged.unchanged, true);
  const refreshed = await success(server.call('bootstrap', { ...known, includeSharedItems: true }));
  assert.equal(refreshed.unchanged, undefined);
  assert.deepEqual(refreshed.snapshot.sharedItems, current.snapshot.sharedItems);
});

test('deleting a share advances its family revision and permits republishing without losing other statuses', async () => {
  const server = fixture();
  let current = await savedDish(server);
  const dishId = current.snapshot.recipes[0].id;
  current = await success(server.command('saveRecipe', [{ ...recipe, id: '', title: '另一道菜' }], current.revision));
  const otherDishId = current.snapshot.recipes.find(item => item.id !== dishId).id;
  current = await success(server.command('publishToCommunity', [otherDishId], current.revision));
  current = await success(server.command('publishToCommunity', [dishId], current.revision));
  const firstPostId = current.value;
  const beforeRevision = current.revision;
  const deleted = await success(server.call('command', { name: 'deleteCommunityPost', args: [firstPostId], revision: current.revision, requestId: 'delete-shared-dish', responseMode: 'changes', includeFeed: false }));
  assert.equal(deleted.revision, beforeRevision + 1);
  assert.deepEqual(deleted.postChanges.remove, [firstPostId]);
  current = await success(server.call('bootstrap', { knownFamilyId: current.familyId, knownRevision: beforeRevision, includeFeed: false }));
  assert.deepEqual(current.snapshot.sharedItems.map(item => item.itemId), [otherDishId]);
  current = await success(server.command('publishToCommunity', [dishId], current.revision));
  assert.notEqual(current.value, firstPostId);
  assert.equal(current.snapshot.sharedItems.length, 2);
  assert.equal((await server.repository.get('posts', firstPostId)).status, 'deleted');
});

test('deleting a share after switching families is forbidden even for its publisher', async () => {
  const server = fixture();
  let original = await savedDish(server);
  original = await success(server.command('publishToCommunity', [original.snapshot.recipes[0].id], original.revision));
  const postId = original.value;
  const another = await success(server.call('createFamily', { name: 'alice', familyName: '另一个家庭', requestId: 'create-second-home' }));
  const deleted = await server.call('command', { name: 'deleteCommunityPost', args: [postId], revision: another.revision, requestId: 'delete-from-another-family', responseMode: 'changes', includeFeed: false });
  assert.equal(deleted.code, 'FORBIDDEN');
  assert.equal((await server.repository.get('posts', postId)).status, 'published');
  assert.equal((await server.repository.get('families', original.familyId)).revision, original.revision);
  assert.equal((await server.repository.get('families', another.familyId)).revision, another.revision);
  assert.equal((await server.repository.get('users', digest('alice'))).familyId, another.familyId);
});

test('legacy shares without familyKind block only their matching kind and not another family', async () => {
  const server = fixture();
  const current = await savedDish(server);
  const dishId = current.snapshot.recipes[0].id;
  const legacy = { id: 'legacy', familyId: current.familyId, familyItemId: dishId, kind: 'menu', status: 'published' };
  await server.repository.set('posts', legacy.id, legacy);
  const dish = await success(server.command('publishToCommunity', [dishId], current.revision));
  assert.equal(dish.snapshot.sharedItems.length, 2);
  assert.equal((await server.command('publishToCommunity', [dishId], dish.revision)).code, 'ALREADY_SHARED');
  const other = await savedDish({ ...server, call: (action, payload) => server.call(action, payload, 'bob'), command: (name, args, revision) => server.command(name, args, revision, 'bob') });
  const otherDish = await success(server.command('publishToCommunity', [other.snapshot.recipes[0].id], other.revision, 'bob'));
  assert.equal(otherDish.snapshot.sharedItems.length, 1);
});
