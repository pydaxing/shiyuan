import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication as createSourceApplication } from '../server/application.mjs';
import { memoryRepository } from './helpers/memory-repository.js';
import { loadCloudApplication } from './helpers/cloud-bundle.js';
import { createSeed } from '../src/data/seed.js';
import { dishPreparationSignature, shoppingMeals } from '../src/domain/meal-preparation.js';
import { INGREDIENT_UNITS_VERSION } from '../src/domain/ingredient-units.js';

const today = '2026-10-22';
const createApplication = process.env.KITCHEN_TEST_BUNDLE ? await loadCloudApplication(process.env.KITCHEN_TEST_BUNDLE) : createSourceApplication;
const success = async promise => { const result = await promise; assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
const preparationDraft = current => {
  const dish = shoppingMeals(current.snapshot, today)[0].dishes[0];
  return { dish, draft: structuredClone({ ingredients: dish.ingredients, note: dish.note }) };
};

test('cloud saves and reloads disabled preparation materials without losing quantities or editing the recipe', async () => {
  const server = await fixture();
  const original = structuredClone(server.current.snapshot);
  let { dish, draft } = preparationDraft(server.current);
  draft.ingredients[0].enabled = false;
  let current = await success(server.command('saveDishPreparation', [server.orderId, server.recipeId, draft, dish.editSignature], server.current.revision));
  assert.deepEqual(current.snapshot.orders[0].preparationEdits[0].ingredients[0], { ...original.orders[0].items[0].recipe.ingredients[0], enabled: false });
  current = await server.bootstrap();
  assert.equal(preparationDraft(current).dish.ingredients[0].enabled, false);
  assert.deepEqual(current.snapshot.recipes, original.recipes);
  assert.deepEqual(current.snapshot.inventory, original.inventory);
  ({ dish, draft } = preparationDraft(current));
  delete draft.ingredients[0].enabled;
  current = await success(server.command('saveDishPreparation', [server.orderId, server.recipeId, draft, dish.editSignature], current.revision));
  assert.equal(preparationDraft(current).dish.signature, server.signature);
  assert.deepEqual(preparationDraft(current).dish.ingredients, original.orders[0].items[0].recipe.ingredients);
});

async function fixture({ legacyPending = false } = {}) {
  const repository = memoryRepository();
  const app = createApplication({ repository, now: () => Date.parse(`${today}T03:00:00Z`), signFiles: async () => ({}), storeImage: async fileId => fileId });
  let sequence = 0;
  const call = (action, payload = {}, openid = 'alice') => app({ action, ingredientUnitsVersion: INGREDIENT_UNITS_VERSION, ...payload }, { OPENID: openid });
  const command = (name, args, revision, options = {}, openid = 'alice') => call('command', { name, args, revision, requestId: `prepare-request-${++sequence}`, ...options }, openid);
  let current = await success(call('createFamily', { name: '我', familyName: '备菜测试小家' }));
  current = await success(command('setPreferences', [{ fridge: true, shopping: true }], current.revision));
  current = await success(command('saveRecipe', [{ ...createSeed().recipes[0], ingredients: [{ name: '番茄', quantity: 300, unit: 'g' }, { name: '盐', quantity: null, unit: '', amountText: '适量' }] }], current.revision));
  const recipeId = current.snapshot.recipes[0].id;
  current = await success(command('submitOrder', [{ [recipeId]: 1 }, { date: today, meal: '晚餐' }], current.revision));
  const orderId = current.snapshot.orders[0].id;
  assert.equal(current.snapshot.orders[0].status, 'accepted');
  if (legacyPending) {
    const stored = (await repository.list('orders')).find(record => record.value.id === orderId);
    await repository.set('orders', stored._id, { ...stored, value: { ...stored.value, status: 'pending' } });
    current = await success(call('bootstrap', { includeFeed: false }));
  }
  const signature = dishPreparationSignature(current.snapshot.orders[0].items[0]);
  return { repository, call, command, current, orderId, recipeId, signature, bootstrap: openid => success(call('bootstrap', { includeFeed: false }, openid)) };
}

for (const status of ['accepted', 'pending']) {
  test(`cloud additions in ${status} preserve prepared ingredients, notes and procurement readiness`, async () => {
    const server = await fixture({ legacyPending: status === 'pending' });
    const { dish, draft } = preparationDraft(server.current);
    draft.ingredients[0].quantity = 450;
    draft.note = '少盐，食材已经买好';
    let current = await success(server.command('saveDishPreparation', [server.orderId, server.recipeId, draft, dish.editSignature], server.current.revision));
    const signature = shoppingMeals(current.snapshot, today)[0].dishes[0].signature;
    current = await success(server.command('setDishPrepared', [server.orderId, server.recipeId, true, signature], current.revision));
    const before = structuredClone(current.snapshot.orders[0]);
    current = await success(server.command('saveRecipe', [createSeed().recipes[1]], current.revision));
    const revision = current.revision;
    const addedId = current.snapshot.recipes.find(recipe => recipe.id !== server.recipeId).id;
    const inventory = await server.repository.list('inventory');
    const purchases = await server.repository.list('purchases');
    const options = { requestId: `preparing-add-${status}-0001`, responseMode: 'changes' };
    const args = [server.orderId, { [addedId]: 1 }];
    const patch = await success(server.command('addOrderDishes', args, revision, options));
    assert.ok(patch.changes.orders);
    assert.equal(patch.changes.inventory, undefined);
    assert.equal(patch.changes.purchases, undefined);
    current = await server.bootstrap();
    const [order] = current.snapshot.orders;
    assert.equal(order.id, before.id);
    assert.equal(order.status, status);
    assert.equal(order.createdAt, before.createdAt);
    assert.deepEqual(order.preparationEdits, before.preparationEdits);
    assert.deepEqual(order.preparedDishes, before.preparedDishes);
    const meal = shoppingMeals(current.snapshot, today)[0];
    assert.equal(meal.dishes.length, 2);
    assert.equal(meal.preparedCount, 1);
    assert.equal(meal.dishes.find(entry => entry.recipe.id === addedId).prepared, false);
    assert.equal(meal.dishes.find(entry => entry.recipe.id === server.recipeId).note, draft.note);
    const replay = await success(server.command('addOrderDishes', args, revision, options));
    assert.equal(replay.revision, patch.revision);
    assert.deepEqual((await server.bootstrap()).snapshot.orders, current.snapshot.orders);
    current = await success(server.command('updateOrder', [server.orderId, 'completed'], current.revision));
    assert.equal(current.snapshot.orders[0].status, 'completed');
    assert.deepEqual(shoppingMeals(current.snapshot, today), []);
    assert.deepEqual(await server.repository.list('inventory'), inventory);
    assert.deepEqual(await server.repository.list('purchases'), purchases);
  });
}

test('cloud preparation persists an order-only patch and replays without duplicate records', async () => {
  const server = await fixture();
  const stock = await server.repository.list('inventory');
  const purchases = await server.repository.list('purchases');
  const options = { responseMode: 'changes', requestId: 'prepare-idempotent-0001' };
  const args = [server.orderId, server.recipeId, true, server.signature];
  const patch = await success(server.command('setDishPrepared', args, server.current.revision, options));
  assert.ok(patch.changes.orders);
  assert.equal(patch.changes.inventory, undefined);
  assert.equal(patch.changes.purchases, undefined);
  const replay = await success(server.command('setDishPrepared', args, server.current.revision, options));
  const current = await server.bootstrap();
  assert.equal(current.revision, patch.revision);
  assert.equal(replay.revision, patch.revision);
  assert.equal(current.snapshot.orders[0].preparedDishes.length, 1);
  assert.equal(shoppingMeals(current.snapshot, today)[0].preparedCount, 1);
  assert.deepEqual(await server.repository.list('inventory'), stock);
  assert.deepEqual(await server.repository.list('purchases'), purchases);
});

test('another family member sees and can reverse preparation, while stale writes fail atomically', async () => {
  const server = await fixture();
  const invite = await success(server.call('createInvite'));
  await success(server.call('joinFamily', { code: invite.code, name: '家人' }, 'bob'));
  let current = await server.bootstrap();
  const staleRevision = current.revision;
  current = await success(server.command('setDishPrepared', [server.orderId, server.recipeId, true, server.signature], current.revision));
  const bob = await server.bootstrap('bob');
  assert.equal(shoppingMeals(bob.snapshot, today)[0].preparedCount, 1);
  const stale = await server.command('setDishPrepared', [server.orderId, server.recipeId, false, server.signature], staleRevision, {}, 'bob');
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'CONFLICT');
  assert.equal(shoppingMeals((await server.bootstrap()).snapshot, today)[0].preparedCount, 1);
  const reversed = await success(server.command('setDishPrepared', [server.orderId, server.recipeId, false, server.signature], current.revision, {}, 'bob'));
  assert.equal(shoppingMeals(reversed.snapshot, today)[0].preparedCount, 0);
  assert.equal(shoppingMeals((await server.bootstrap()).snapshot, today)[0].preparedCount, 0);
});

test('preparation cannot write another family, accept client-supplied identity or mark a stale ingredient amount', async () => {
  const server = await fixture();
  await success(server.call('createFamily', { name: '其他人', familyName: '另一个小家' }, 'outsider'));
  const other = await server.bootstrap('outsider');
  const before = await server.bootstrap();
  const result = await server.command('setDishPrepared', [server.orderId, server.recipeId, true, server.signature], other.revision, {}, 'outsider');
  assert.equal(result.ok, false);
  assert.deepEqual((await server.bootstrap()).snapshot.orders, before.snapshot.orders);
  for (const args of [[server.orderId, server.recipeId, 'true', server.signature], [server.orderId, server.recipeId, true, 'old-signature'], [server.orderId, server.recipeId, true, '']]) {
    const failed = await server.command('setDishPrepared', args, before.revision);
    assert.equal(failed.ok, false);
    assert.deepEqual((await server.bootstrap()).snapshot.orders, before.snapshot.orders);
  }
  const forged = await server.command('setDishPrepared', [server.orderId, server.recipeId, true, server.signature, { preparedBy: 'outsider' }], before.revision);
  assert.equal(forged.ok, false);
  const prepared = await success(server.command('setDishPrepared', [server.orderId, server.recipeId, true, server.signature], before.revision));
  assert.equal(prepared.snapshot.orders[0].preparedDishes[0].preparedBy, before.snapshot.activeMemberId);
});

for (const status of ['pending', 'accepted']) {
  test(`cloud completion bypasses preparation and shortages in ${status}, retaining independent fridge records`, async () => {
    const server = await fixture({ legacyPending: status === 'pending' });
    let current = server.current;
    current = await success(server.command('addStock', [{ name: '番茄', quantity: 50, unit: 'g', location: '冷藏', expiresOn: '', image: '' }], current.revision));
    assert.equal(current.snapshot.orders[0].status, status);
    const stock = await server.repository.list('inventory');
    current = await success(server.command('updateOrder', [server.orderId, 'completed'], current.revision));
    assert.equal(current.snapshot.orders[0].status, 'completed');
    assert.deepEqual(shoppingMeals(current.snapshot, today), []);
    assert.deepEqual(await server.repository.list('inventory'), stock);
    assert.equal((await server.command('setDishPrepared', [server.orderId, server.recipeId, true, server.signature], current.revision)).ok, false);
    assert.equal((await server.command('updateOrder', [server.orderId, 'completed'], current.revision)).ok, false);
    assert.equal((await server.bootstrap()).snapshot.orders.length, 1);
  });
}

test('disabled fridge preserves preparation and the ability to complete a meal', async () => {
  const server = await fixture();
  let current = await success(server.command('setPreferences', [{ fridge: false, shopping: false }], server.current.revision));
  current = await success(server.command('setDishPrepared', [server.orderId, server.recipeId, true, server.signature], current.revision));
  assert.equal(shoppingMeals(current.snapshot, today)[0].preparedCount, 1);
  current = await success(server.command('updateOrder', [server.orderId, 'completed'], current.revision));
  assert.equal(current.snapshot.orders[0].status, 'completed');
});

test('cancellation removes prepared and unprepared dish packs without deleting order history', async () => {
  const server = await fixture();
  let current = await success(server.command('setDishPrepared', [server.orderId, server.recipeId, true, server.signature], server.current.revision));
  current = await success(server.command('updateOrder', [server.orderId, 'cancelled'], current.revision));
  assert.deepEqual(shoppingMeals(current.snapshot, today), []);
  assert.equal(current.snapshot.orders[0].status, 'cancelled');
  const late = await server.command('setDishPrepared', [server.orderId, server.recipeId, false, server.signature], current.revision);
  assert.equal(late.ok, false);
  assert.equal(late.code, 'CONFLICT');
});

test('cloud prep edits are shared, order-only, canonical and idempotent without mutating the recipe or fridge', async () => {
  const server = await fixture();
  const before = structuredClone(server.current.snapshot);
  const { dish, draft } = preparationDraft(server.current);
  draft.ingredients[0].quantity = '600';
  draft.note = ' 多备一点 ';
  draft.updatedBy = 'spoofed-member';
  draft.quantity = 30;
  const options = { responseMode: 'changes', requestId: 'prep-edit-idempotent-0001' };
  const args = [server.orderId, server.recipeId, draft, dish.editSignature];
  const patch = await success(server.command('saveDishPreparation', args, server.current.revision, options));
  assert.ok(patch.changes.orders);
  for (const field of ['recipes', 'inventory', 'purchases']) assert.equal(patch.changes[field], undefined);
  const replay = await success(server.command('saveDishPreparation', args, server.current.revision, options));
  assert.equal(replay.revision, patch.revision);
  let current = await server.bootstrap();
  assert.equal(current.snapshot.orders[0].preparationEdits.length, 1);
  const record = current.snapshot.orders[0].preparationEdits[0];
  assert.equal(record.updatedBy, current.snapshot.activeMemberId);
  assert.equal(record.quantity, 1);
  assert.equal(record.ingredients[0].quantity, 600);
  assert.equal(record.note, '多备一点');
  for (const field of ['recipes', 'inventory', 'purchases']) assert.deepEqual(current.snapshot[field], before[field]);
  const invite = await success(server.call('createInvite'));
  await success(server.call('joinFamily', { code: invite.code, name: '家人' }, 'bob'));
  current = await server.bootstrap('bob');
  const shared = preparationDraft(current);
  assert.equal(shared.dish.note, '多备一点');
  shared.draft.note = '家人补充备注';
  await success(server.command('saveDishPreparation', [server.orderId, server.recipeId, shared.draft, shared.dish.editSignature], current.revision, {}, 'bob'));
  assert.equal(preparationDraft(await server.bootstrap()).dish.note, '家人补充备注');
});

test('cloud ingredient edits reset readiness but note-only edits do not, and completion ignores both', async () => {
  const server = await fixture();
  let current = await success(server.command('setDishPrepared', [server.orderId, server.recipeId, true, server.signature], server.current.revision));
  let { dish, draft } = preparationDraft(current);
  draft.note = '少放盐';
  current = await success(server.command('saveDishPreparation', [server.orderId, server.recipeId, draft, dish.editSignature], current.revision));
  assert.equal(preparationDraft(current).dish.prepared, true);
  assert.equal(current.value.readyReset, false);
  ({ dish, draft } = preparationDraft(current));
  draft.ingredients.push({ name: '葱', quantity: 2, unit: '根' });
  current = await success(server.command('saveDishPreparation', [server.orderId, server.recipeId, draft, dish.editSignature], current.revision));
  assert.equal(preparationDraft(current).dish.prepared, false);
  assert.equal(current.value.readyReset, true);
  current = await success(server.command('updateOrder', [server.orderId, 'completed'], current.revision));
  assert.deepEqual(shoppingMeals(current.snapshot, today), []);
  const before = structuredClone(current.snapshot.orders);
  const rejected = await server.command('saveDishPreparation', [server.orderId, server.recipeId, draft, dish.editSignature], current.revision);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'CONFLICT');
  assert.deepEqual((await server.bootstrap()).snapshot.orders, before);
});

test('cloud edits reject stale dish content even with the current family revision', async () => {
  const server = await fixture();
  const { dish, draft } = preparationDraft(server.current);
  const current = await success(server.command('saveDishPreparation', [server.orderId, server.recipeId, { ...draft, note: '更新' }, dish.editSignature], server.current.revision));
  for (const revision of [server.current.revision, current.revision]) {
    const failed = await server.command('saveDishPreparation', [server.orderId, server.recipeId, { ...draft, note: '过时草稿' }, dish.editSignature], revision);
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'CONFLICT');
  }
  assert.equal(preparationDraft(await server.bootstrap()).dish.note, '更新');
});

test('cloud edits enforce membership, valid amounts and bounded legacy notes regardless of fridge settings', async () => {
  const server = await fixture();
  const { dish, draft } = preparationDraft(server.current);
  await success(server.call('createFamily', { name: '其他人', familyName: '另一个家' }, 'outsider'));
  const outsider = await server.bootstrap('outsider');
  const wrongFamily = await server.command('saveDishPreparation', [server.orderId, server.recipeId, draft, dish.editSignature], outsider.revision, {}, 'outsider');
  assert.equal(wrongFamily.ok, false);
  for (const bad of [{ ...draft, note: '字'.repeat(201) }, { ...draft, ingredients: [{ name: '盐', quantity: -1, unit: 'g' }] }, { ...draft, ingredients: [{ name: '盐', quantity: 1, unit: '自定义' }] }, null]) {
    const failed = await server.command('saveDishPreparation', [server.orderId, server.recipeId, bad, dish.editSignature], server.current.revision);
    assert.equal(failed.ok, false);
  }
  assert.deepEqual((await server.bootstrap()).snapshot.orders, server.current.snapshot.orders);
  const current = await success(server.command('setPreferences', [{ fridge: false, shopping: false }], server.current.revision));
  const edited = await success(server.command('saveDishPreparation', [server.orderId, server.recipeId, draft, dish.editSignature], current.revision));
  assert.equal(edited.snapshot.orders[0].preparationEdits[0].recipeId, server.recipeId);
  assert.deepEqual((await server.bootstrap()).snapshot.orders, edited.snapshot.orders);
});
