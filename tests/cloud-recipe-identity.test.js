import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApplication as createSourceApplication } from '../server/application.mjs';
import { loadCloudApplication } from './helpers/cloud-bundle.js';
import { memoryRepository } from './helpers/memory-repository.js';
import { createSeed } from '../src/data/seed.js';

const createApplication = process.env.KITCHEN_TEST_BUNDLE ? await loadCloudApplication(process.env.KITCHEN_TEST_BUNDLE) : createSourceApplication;
const clock = Date.parse('2026-11-08T04:00:00Z');
const digest = value => createHash('sha256').update(value).digest('hex');
const docId = (familyId, id) => digest(`${familyId}:${id}`);
const copy = value => structuredClone(value);
const recipe = createSeed().recipes[0];
function fixture() {
  const repository = memoryRepository();
  const app = createApplication({ repository, now: () => clock, signFiles: async ids => Object.fromEntries(ids.map(id => [id, `signed:${id}`])), storeImage: async id => id });
  let sequence = 0;
  const call = (action, payload = {}, openid = 'alice') => app({ action, ...payload }, { OPENID: openid });
  const command = (name, args, revision, openid = 'alice', extra = {}) => call('command', { name, args, revision, requestId: `identity-request-${++sequence}`, includeFeed: false, ...extra }, openid);
  return { repository, call, command };
}
async function success(value) { const result = await value; assert.equal(result.ok, true, JSON.stringify(result)); return result.data; }
async function family(server, openid = 'alice') { return success(server.call('createFamily', { name: openid, familyName: `${openid}的小家` }, openid)); }
const currentRecipe = (state, id) => state.snapshot.recipes.find(recipe => recipe.id === id);

test('public recipe identity survives author, importer fork, historical order and third-family reimport end to end', async () => {
  const server = fixture();
  let alice = await family(server);
  alice = await success(server.command('saveRecipe', [recipe], alice.revision));
  const originalId = alice.value;
  alice = await success(server.command('saveRecipe', [{ ...recipe, title: '第二道菜' }], alice.revision));
  const secondId = alice.value;
  alice = await success(server.command('saveMealSet', [{ title: '两菜套餐', image: recipe.image, recipeIds: [originalId, secondId] }], alice.revision));
  alice = await success(server.command('publishToCommunity', [alice.snapshot.mealSets[0].id, 'set'], alice.revision));
  const sourcePostId = alice.value;
  const sourcePost = await server.repository.get('posts', sourcePostId);
  assert.deepEqual(sourcePost.recipes.map(recipe => recipe.id), [originalId, secondId]);
  assert.equal(sourcePost.recipes[0].identityVersion, 2);

  let bob = await family(server, 'bob');
  bob = await success(server.command('addCollection', [{ id: sourcePostId, recipes: [{ id: 'forged-id', title: 'forged data' }] }], bob.revision, 'bob'));
  assert.equal(currentRecipe(bob, originalId).title, recipe.title);
  assert.equal(currentRecipe(bob, originalId).recipeOrigin, 'community');
  const setId = bob.snapshot.mealSets[0].id;
  bob = await success(server.command('submitOrder', [{ [originalId]: 1 }, { date: '2026-11-08', meal: '晚餐' }], bob.revision, 'bob'));
  const originalOrder = copy(bob.snapshot.orders[0]);
  const noOpInput = currentRecipe(bob, originalId);
  const beforeNoOp = await server.repository.get('recipes', docId(bob.familyId, originalId));
  bob = await success(server.command('saveRecipe', [noOpInput, originalId], bob.revision, 'bob'));
  assert.equal(bob.value, originalId);
  assert.deepEqual(await server.repository.get('recipes', docId(bob.familyId, originalId)), beforeNoOp);
  const blocked = await server.command('publishToCommunity', [originalId], bob.revision, 'bob');
  assert.equal(blocked.code, 'ALREADY_SHARED');
  assert.equal(blocked.message, '美食已有，此菜品来自美食');

  const args = [{ ...currentRecipe(bob, originalId), title: '少盐改良版', id: 'forged-new-id', recipeOrigin: 'community' }, originalId];
  const revision = bob.revision;
  const extra = { requestId: 'recipe-fork-retry-001', responseMode: 'changes' };
  const changed = await success(server.command('saveRecipe', args, revision, 'bob', extra));
  const forkId = changed.value;
  assert.notEqual(forkId, originalId);
  assert.notEqual(forkId, 'forged-new-id');
  assert.equal(changed.changes.recipes.find(recipe => recipe.id === forkId).recipeOrigin, 'custom');
  assert.deepEqual(changed.changes.mealSets.find(set => set.id === setId).recipeIds, [forkId, secondId]);
  assert.equal(await server.repository.get('recipes', docId(bob.familyId, originalId)), null);
  bob = await success(server.command('saveRecipe', args, revision, 'bob', extra));
  assert.equal(bob.value, forkId);
  assert.equal(bob.snapshot.recipes.length, 2);
  assert.deepEqual(bob.snapshot.orders[0], originalOrder);
  assert.deepEqual((await server.repository.get('posts', sourcePostId)).recipes, sourcePost.recipes);
  bob = await success(server.command('saveRecipe', [{ ...currentRecipe(bob, forkId), nutrition: '每份约 200 千卡' }, forkId], bob.revision, 'bob'));
  assert.equal(bob.value, forkId);
  bob = await success(server.command('publishToCommunity', [forkId], bob.revision, 'bob'));
  const forkPostId = bob.value;
  assert.equal((await server.repository.get('posts', forkPostId)).recipes[0].id, forkId);
  assert.equal(currentRecipe(bob, forkId).recipeOrigin, 'custom');

  let carol = await family(server, 'carol');
  carol = await success(server.command('addCollection', [{ id: forkPostId }], carol.revision, 'carol'));
  assert.equal(carol.snapshot.recipes[0].id, forkId);
  assert.equal(carol.snapshot.recipes[0].recipeOrigin, 'community');
  assert.equal((await server.command('publishToCommunity', [forkId], carol.revision, 'carol')).code, 'ALREADY_SHARED');
  bob = await success(server.command('addCollection', [{ id: sourcePostId }], bob.revision, 'bob'));
  assert.equal(bob.snapshot.recipes.length, 3);
  assert.ok(currentRecipe(bob, originalId));
  assert.ok(currentRecipe(bob, forkId));
  assert.deepEqual(bob.snapshot.mealSets[0].recipeIds, [forkId, secondId]);
  assert.deepEqual(bob.snapshot.orders[0], originalOrder);
});

test('the server strips forged public IDs and only imports authoritative source snapshots', async () => {
  const server = fixture();
  let alice = await family(server);
  const malicious = { ...recipe, id: 'other-public-id', shareId: 'other-public-id', identityVersion: 2, recipeOrigin: 'community',
    communityRecipeId: 'other-public-id', canonicalRecipeId: 'other-public-id', sourceFamilyId: 'other-family', sourcePostId: 'other-post' };
  alice = await success(server.command('saveRecipe', [malicious], alice.revision));
  const id = alice.value;
  const saved = currentRecipe(alice, id);
  assert.notEqual(id, malicious.id);
  assert.equal(saved.recipeOrigin, 'custom');
  for (const field of ['communityRecipeId', 'canonicalRecipeId', 'sourceFamilyId', 'sourcePostId']) assert.equal(saved[field], undefined);
  alice = await success(server.command('publishToCommunity', [id], alice.revision));
  let bob = await family(server, 'bob');
  const source = alice.value;
  bob = await success(server.command('addCollection', [{ id: source, familyId: 'forged-family', sourceKind: 'private', recipes: [{ ...recipe, id: 'forged-dish' }] }], bob.revision, 'bob'));
  assert.equal(bob.snapshot.recipes[0].id, id);
  assert.equal(bob.snapshot.recipes[0].sourceFamilyId, alice.familyId);
  assert.equal(bob.snapshot.recipes[0].recipeOrigin, 'community');
});

test('server edits keep stored legacy portions so an unchanged import does not fork', async () => {
  const server = fixture();
  let current = await family(server);
  const legacy = { ...copy(recipe), id: 'three-person-public', servings: 3, identityVersion: 2, recipeOrigin: 'community', communityRecipeId: 'three-person-public' };
  const source = { id: 'three-person-post', status: 'published', familyId: 'source-household', familyItemId: legacy.id,
    kind: 'dish', familyKind: 'dish', publisherId: 'old-author', title: legacy.title, author: '原始作者', recipes: [legacy] };
  await server.repository.set('posts', source.id, source);
  current = await success(server.command('addCollection', [{ id: source.id }], current.revision));
  assert.equal(currentRecipe(current, legacy.id).servings, 3);
  assert.deepEqual(currentRecipe(current, legacy.id).ingredients, legacy.ingredients);
  assert.deepEqual(currentRecipe(current, legacy.id).steps, legacy.steps);
  const beforeNoOp = await server.repository.get('recipes', docId(current.familyId, legacy.id));
  current = await success(server.command('saveRecipe', [legacy, legacy.id], current.revision));
  assert.equal(current.value, legacy.id);
  assert.equal(currentRecipe(current, legacy.id).servings, 3);
  assert.deepEqual(await server.repository.get('recipes', docId(current.familyId, legacy.id)), beforeNoOp);
  current = await success(server.command('saveRecipe', [{ ...legacy, title: '保留三人基础份量', servings: 99 }, legacy.id], current.revision));
  assert.notEqual(current.value, legacy.id);
  assert.equal(currentRecipe(current, current.value).servings, 3);
  current = await success(server.command('saveRecipe', [{ ...recipe, title: '新建仍为默认份量', servings: 99 }], current.revision));
  assert.equal(currentRecipe(current, current.value).servings, 2);
});

test('saving a legacy spoon amount through the numeric editor preserves the public identity and stored source', async () => {
  const server = fixture();
  let current = await family(server);
  const legacy = { ...copy(recipe), id: 'legacy-spoon-public', identityVersion: 2, recipeOrigin: 'community', communityRecipeId: 'legacy-spoon-public',
    ingredients: [{ name: '盐', quantity: null, unit: '', amountText: '1匙' }] };
  await server.repository.set('recipes', docId(current.familyId, legacy.id), { familyId: current.familyId, value: legacy });
  const before = await server.repository.get('recipes', docId(current.familyId, legacy.id));
  current = await success(server.command('saveRecipe', [{ ...legacy, ingredients: [{ name: '盐', quantity: 1, unit: '匙' }] }, legacy.id], current.revision));
  assert.equal(current.value, legacy.id);
  assert.deepEqual(await server.repository.get('recipes', docId(current.familyId, legacy.id)), before);
  current = await success(server.command('saveRecipe', [{ ...legacy, ingredients: [{ name: '盐', quantity: 2, unit: '匙' }] }, legacy.id], current.revision));
  assert.notEqual(current.value, legacy.id);
});

test('a committed legacy empty-cover request replays before new cover rules, without accepting new invalid writes', async () => {
  const server = fixture();
  const current = await family(server);
  const oldRecipe = { ...copy(recipe), id: 'legacy-without-cover', image: '' };
  const args = [{ ...copy(recipe), image: '' }];
  const requestId = 'legacy-empty-cover-retry';
  const fingerprint = digest(JSON.stringify({ name: 'saveRecipe', args }));
  const requestKey = digest(`${digest('alice')}:${requestId}`);
  await server.repository.set('recipes', docId(current.familyId, oldRecipe.id), { familyId: current.familyId, value: oldRecipe });
  await server.repository.set('requests', requestKey, { familyId: current.familyId, fingerprint, value: oldRecipe.id, createdAt: clock - 86400000 });
  const replay = await success(server.command('saveRecipe', args, 0, 'alice', { requestId }));
  assert.equal(replay.value, oldRecipe.id);
  assert.equal(replay.snapshot.recipes.length, 1);
  assert.equal(replay.snapshot.recipes[0].image, '');
  assert.equal(replay.revision, current.revision);
  const altered = await server.command('saveRecipe', [{ ...args[0], title: '不同请求内容' }], replay.revision, 'alice', { requestId });
  assert.equal(altered.code, 'CONFLICT');
  const fresh = await server.command('saveRecipe', args, replay.revision);
  assert.equal(fresh.code, 'INVALID');
  assert.match(fresh.message, /封面/);
  assert.deepEqual((await server.repository.get('recipes', docId(current.familyId, oldRecipe.id))).value, oldRecipe);
});

test('a pre-v2 unchanged imported recipe is recognized by exact scoped source content', async () => {
  const server = fixture();
  const current = await family(server);
  const sourceRecipe = { ...copy(recipe), id: 'legacy-public-id' };
  const post = { id: 'legacy-source-post', status: 'published', familyId: 'source-household', familyItemId: 'old-author-local-id',
    kind: 'dish', familyKind: 'dish', publisherId: 'old-author', title: recipe.title, author: '原始作者', recipes: [sourceRecipe] };
  await server.repository.set('posts', post.id, post);
  const legacy = { ...copy(sourceRecipe), id: 'legacy-imported-copy', sourceId: sourceRecipe.id, sourceFamilyId: post.familyId, shareId: 'old-share-copy' };
  await server.repository.set('recipes', docId(current.familyId, legacy.id), { familyId: current.familyId, value: legacy });
  const blocked = await server.command('publishToCommunity', [legacy.id], current.revision);
  assert.equal(blocked.code, 'ALREADY_SHARED');
  assert.equal(blocked.message, '美食已有，此菜品来自美食');
  const changed = await success(server.command('saveRecipe', [{ ...legacy, title: '新做法' }, legacy.id], current.revision));
  assert.notEqual(changed.value, legacy.id);
  assert.equal(currentRecipe(changed, changed.value).recipeOrigin, 'custom');
  assert.equal((await server.repository.get('posts', post.id)).recipes[0].title, recipe.title);
});

test('pre-v2 edited imported content and unscoped source IDs cannot be mislabeled as unchanged public recipes', async () => {
  for (const kind of ['edited', 'unscoped']) {
    const server = fixture();
    const current = await family(server);
    const post = { id: 'legacy-public-post', status: 'published', familyId: 'source-household', familyItemId: 'legacy-public-id',
      kind: 'dish', familyKind: 'dish', publisherId: 'old-author', title: recipe.title, author: '原始作者', recipes: [{ ...copy(recipe), id: 'legacy-public-id' }] };
    await server.repository.set('posts', post.id, post);
    const legacy = { ...copy(recipe), id: `legacy-${kind}`, sourceId: post.recipes[0].id, shareId: `legacy-share-${kind}`,
      ...(kind === 'edited' ? { sourceFamilyId: post.familyId, sourcePostId: post.id, title: '曾经编辑的私房菜' } : {}) };
    await server.repository.set('recipes', docId(current.familyId, legacy.id), { familyId: current.familyId, value: legacy });
    const published = await success(server.command('publishToCommunity', [legacy.id], current.revision));
    const created = await server.repository.get('posts', published.value);
    assert.equal(created.familyId, current.familyId);
    assert.equal(created.recipes[0].id, legacy.shareId);
    assert.equal(created.recipes[0].title, legacy.title);
  }
});

for (const status of ['published', 'deleted']) for (const kind of ['dish', 'set']) {
  test(`legacy own ${status} ${kind} publications keep their snapshots when the local recipe is edited`, async () => {
    const server = fixture();
    const current = await family(server);
    const legacy = { ...copy(recipe), id: 'legacy-local', shareId: 'legacy-public' };
    const publicRecipe = { ...copy(recipe), id: 'legacy-public' };
    const post = { id: 'legacy-own-post', status, familyId: current.familyId, publisherId: digest('alice'),
      familyItemId: kind === 'dish' ? legacy.id : 'legacy-set', familyKind: kind, kind: kind === 'dish' ? 'dish' : 'menu',
      title: recipe.title, author: 'alice', recipes: [publicRecipe] };
    await server.repository.set('recipes', docId(current.familyId, legacy.id), { familyId: current.familyId, value: legacy });
    await server.repository.set('posts', post.id, post);
    const changed = await success(server.command('saveRecipe', [{ ...legacy, title: '修改后的版本' }, legacy.id], current.revision));
    assert.notEqual(changed.value, legacy.id);
    assert.notEqual(changed.value, legacy.shareId);
    assert.equal(currentRecipe(changed, changed.value).recipeOrigin, 'custom');
    assert.deepEqual((await server.repository.get('posts', post.id)).recipes, [publicRecipe]);
  });
}

test('forked recipe and set updates roll back together, then one retry commits one stable new ID', async () => {
  const server = fixture();
  let alice = await family(server);
  alice = await success(server.command('saveRecipe', [recipe], alice.revision));
  const firstId = alice.value;
  alice = await success(server.command('saveRecipe', [{ ...recipe, title: '另一道菜' }], alice.revision));
  const secondId = alice.value;
  alice = await success(server.command('saveMealSet', [{ title: '套餐', image: recipe.image, recipeIds: [firstId, secondId] }], alice.revision));
  alice = await success(server.command('publishToCommunity', [alice.snapshot.mealSets[0].id, 'set'], alice.revision));
  let bob = await family(server, 'bob');
  bob = await success(server.command('addCollection', [{ id: alice.value }], bob.revision, 'bob'));
  const baselineRecipe = await server.repository.get('recipes', docId(bob.familyId, firstId));
  const baselineSet = await server.repository.get('meal_sets', docId(bob.familyId, bob.snapshot.mealSets[0].id));
  const baselineFamily = await server.repository.get('families', bob.familyId);
  const transaction = server.repository.transaction;
  server.repository.transaction = callback => transaction(db => callback({ ...db, set: async (name, ...args) => {
    if (name === 'meal_sets') throw new Error('simulated set persistence failure');
    return db.set(name, ...args);
  } }));
  const args = [{ ...currentRecipe(bob, firstId), title: '准备保存的新菜' }, firstId];
  const extra = { requestId: 'fork-transaction-retry' };
  const failed = await server.command('saveRecipe', args, bob.revision, 'bob', extra);
  assert.equal(failed.ok, false);
  assert.deepEqual(await server.repository.get('recipes', docId(bob.familyId, firstId)), baselineRecipe);
  assert.deepEqual(await server.repository.get('meal_sets', baselineSet._id), baselineSet);
  assert.deepEqual(await server.repository.get('families', bob.familyId), baselineFamily);
  assert.equal(await server.repository.get('requests', digest(`${digest('bob')}:${extra.requestId}`)), null);
  assert.equal((await server.repository.list('recipes', { familyId: bob.familyId })).length, 2);
  server.repository.transaction = transaction;
  const saved = await success(server.command('saveRecipe', args, bob.revision, 'bob', extra));
  assert.notEqual(saved.value, firstId);
  const replay = await success(server.command('saveRecipe', args, bob.revision, 'bob', extra));
  assert.equal(replay.value, saved.value);
  assert.equal(replay.snapshot.recipes.length, 2);
  assert.deepEqual(replay.snapshot.mealSets[0].recipeIds, [saved.value, secondId]);
});

test('quick dishes keep identity through private share and block public dish/set publication until complete', async () => {
  const server = fixture();
  let current = await family(server);
  const quick = { ...recipe, title: '快速菜品', minutes: null, ingredients: [], steps: [] };
  current = await success(server.command('saveRecipe', [quick], current.revision));
  const id = current.value;
  assert.deepEqual(currentRecipe(current, id).ingredients, []);
  assert.deepEqual(currentRecipe(current, id).steps, []);
  assert.equal(currentRecipe(current, id).minutes, null);
  const share = await success(server.call('createDishShare', { familyId: current.familyId, itemId: id, kind: 'dish' }));
  const shared = await success(server.call('readShare', { token: share.token }, 'visitor'));
  assert.deepEqual(shared.post.recipes[0].ingredients, []);
  assert.equal(shared.post.recipes[0].image, quick.image);
  await family(server, 'bob');
  const imported = await success(server.call('importShare', { token: share.token }, 'bob'));
  assert.equal(imported.snapshot.recipes[0].title, quick.title);
  assert.deepEqual(imported.snapshot.recipes[0].steps, []);
  let rejected = await server.command('publishToCommunity', [id], current.revision);
  assert.equal(rejected.ok, false);
  assert.match(rejected.message || rejected.error || '', /食材/);
  assert.equal((await server.repository.list('posts')).length, 0);
  current = await success(server.command('saveRecipe', [recipe], current.revision));
  const fullId = current.value;
  current = await success(server.command('saveMealSet', [{ title: '快速搭配', recipeIds: [id, fullId], image: quick.image }], current.revision));
  const setId = current.snapshot.mealSets.find(item => item.title === '快速搭配').id;
  rejected = await server.command('publishToCommunity', [setId, 'set'], current.revision);
  assert.equal(rejected.ok, false);
  assert.equal((await server.repository.list('posts')).length, 0);
  current = await success(server.command('saveRecipe', [{ ...quick, ingredients: recipe.ingredients }, id], current.revision));
  rejected = await server.command('publishToCommunity', [id], current.revision);
  assert.equal(rejected.ok, false);
  assert.match(rejected.message || rejected.error || '', /步骤/);
  current = await success(server.command('saveRecipe', [{ ...quick, ingredients: recipe.ingredients, steps: recipe.steps }, id], current.revision));
  assert.equal(current.value, id);
  current = await success(server.command('publishToCommunity', [setId, 'set'], current.revision));
  assert.equal((await server.repository.list('posts')).length, 1);
});
