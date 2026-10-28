import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication as createSourceApplication } from '../server/application.mjs';
import { loadCloudApplication } from './helpers/cloud-bundle.js';
import { memoryRepository } from './helpers/memory-repository.js';
import { createSeed } from '../src/data/seed.js';
import { preparationMeals } from '../src/domain/meal-preparation.js';
import { shoppingCartMeals, shoppingEditSignature, shoppingSourceIngredients, wholeDishShoppingDraft } from '../src/domain/meal-shopping.js';
import { INGREDIENT_UNITS_VERSION } from '../src/domain/ingredient-units.js';

const today = '2026-10-26';
const createApplication = process.env.KITCHEN_TEST_BUNDLE ? await loadCloudApplication(process.env.KITCHEN_TEST_BUNDLE) : createSourceApplication;
const success = async promise => { const result = await promise; assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
async function fixture() {
  const repository = memoryRepository();
  let timestamp = Date.parse(`${today}T03:00:00Z`);
  const app = createApplication({ repository, now: () => timestamp, signFiles: async () => ({}), storeImage: async fileId => fileId });
  let sequence = 0;
  const call = (action, payload = {}, openid = 'alice') => app({ action, ingredientUnitsVersion: INGREDIENT_UNITS_VERSION, ...payload }, { OPENID: openid });
  const command = (name, args, revision, options = {}, openid = 'alice') => call('command', { name, args, revision, requestId: `shopping-request-${++sequence}`, ...options }, openid);
  let current = await success(call('createFamily', { name: '我', familyName: '采购测试' }));
  current = await success(command('saveRecipe', [{ ...createSeed().recipes[0], ingredients: [{ name: '番茄', quantity: 300, unit: 'g' }, { name: '盐', quantity: null, unit: '', amountText: '适量' }] }], current.revision));
  const recipeId = current.snapshot.recipes[0].id;
  current = await success(command('submitOrder', [{ [recipeId]: 1 }, { date: today, meal: '晚餐' }], current.revision));
  const orderId = current.snapshot.orders[0].id;
  const draft = { ingredients: shoppingSourceIngredients(preparationMeals(current.snapshot, today)[0].dishes[0].ingredients).slice(0, 1) };
  const signature = current => shoppingEditSignature(current.snapshot.orders.find(order => order.id === orderId), recipeId);
  return { repository, current, orderId, recipeId, draft, signature, call, command, bootstrap: openid => success(call('bootstrap', { includeFeed: false }, openid)), advance: days => { timestamp += days * 86400000; } };
}

test('cloud cart is opt-in, works with the fridge off and returns order-only changes', async () => {
  const server = await fixture();
  assert.deepEqual(shoppingCartMeals(server.current.snapshot, today), []);
  assert.equal(server.current.snapshot.family.features.fridge, false);
  const stock = await server.repository.list('inventory');
  const purchases = await server.repository.list('purchases');
  const patch = await success(server.command('saveShoppingDraft', [server.orderId, server.recipeId, server.draft, server.signature(server.current)], server.current.revision, { responseMode: 'changes' }));
  assert.ok(patch.changes.orders);
  assert.equal(patch.changes.inventory, undefined);
  assert.equal(patch.changes.purchases, undefined);
  const current = await server.bootstrap();
  assert.equal(shoppingCartMeals(current.snapshot, today)[0].dishes[0].purchaseIngredients[0].name, '番茄');
  assert.equal(current.snapshot.orders[0].shoppingDrafts[0].updatedBy, current.snapshot.activeMemberId);
  assert.deepEqual(await server.repository.list('inventory'), stock);
  assert.deepEqual(await server.repository.list('purchases'), purchases);
});

test('cloud package writes replay exactly once and mismatched duplicate request IDs cannot replace contents', async () => {
  const server = await fixture();
  const args = [server.orderId, server.recipeId, server.draft, server.signature(server.current)];
  const options = { responseMode: 'changes', requestId: 'shopping-idempotent-0001' };
  await success(server.command('saveShoppingDraft', args, server.current.revision, options));
  const after = await server.bootstrap();
  await success(server.command('saveShoppingDraft', args, server.current.revision, options));
  assert.deepEqual((await server.bootstrap()).snapshot, after.snapshot);
  assert.equal(after.snapshot.orders[0].shoppingDrafts.length, 1);
  const changed = structuredClone(args); changed[2].ingredients[0].quantity = 600;
  const rejected = await server.command('saveShoppingDraft', changed, after.revision, options);
  assert.equal(rejected.code, 'CONFLICT');
  assert.deepEqual((await server.bootstrap()).snapshot, after.snapshot);
});

test('other members share packages, but stale amounts and nonmember access cannot overwrite them', async () => {
  const server = await fixture();
  const invitation = await success(server.call('createInvite'));
  await success(server.call('joinFamily', { code: invitation.code, name: '家人' }, 'bob'));
  let current = await server.bootstrap();
  const oldSignature = server.signature(current);
  current = await success(server.command('saveShoppingDraft', [server.orderId, server.recipeId, server.draft, oldSignature], current.revision));
  const bob = await server.bootstrap('bob');
  assert.deepEqual(bob.snapshot.orders, current.snapshot.orders);
  const stale = await server.command('saveShoppingDraft', [server.orderId, server.recipeId, server.draft, oldSignature], current.revision, {}, 'bob');
  assert.equal(stale.code, 'CONFLICT');
  await success(server.call('createFamily', { name: '其他人', familyName: '另一个家' }, 'outsider'));
  const other = await server.bootstrap('outsider');
  const forbidden = await server.command('removeShoppingDraft', [server.orderId, server.recipeId, server.signature(current)], other.revision, {}, 'outsider');
  assert.equal(forbidden.ok, false);
  assert.deepEqual((await server.bootstrap()).snapshot.orders, current.snapshot.orders);
  current = await success(server.command('removeShoppingDraft', [server.orderId, server.recipeId, server.signature(current)], bob.revision, {}, 'bob'));
  assert.deepEqual(shoppingCartMeals(current.snapshot, today), []);
  assert.equal(preparationMeals(current.snapshot, today)[0].preparedCount, 0);
});

test('server validates partial ingredients and amounts instead of trusting client identity, totals or payment fields', async () => {
  const server = await fixture();
  const before = await server.bootstrap();
  const source = server.draft.ingredients[0];
  for (const ingredients of [[], [source, source], [{ ...source, quantity: -1 }], [{ ...source, quantity: 'bad' }], [{ ...source, sourceKey: 'forged' }], [{ ...source, name: '牛肉' }]]) {
    const result = await server.command('saveShoppingDraft', [server.orderId, server.recipeId, { ingredients }, server.signature(before)], before.revision);
    assert.equal(result.ok, false);
    assert.deepEqual((await server.bootstrap()).snapshot.orders, before.snapshot.orders);
  }
  const forged = { ...server.draft, updatedBy: 'other', price: .01, paid: true, status: 'delivered' };
  const current = await success(server.command('saveShoppingDraft', [server.orderId, server.recipeId, forged, server.signature(before)], before.revision));
  const saved = current.snapshot.orders[0].shoppingDrafts[0];
  assert.equal(saved.updatedBy, current.snapshot.activeMemberId);
  assert.equal(saved.price, undefined); assert.equal(saved.paid, undefined); assert.equal(saved.status, undefined);
});

test('zero meal quantities survive saving, reload, legacy toggles, adding a package, readiness and meal completion', async () => {
  const server = await fixture();
  const original = structuredClone(server.current.snapshot);
  let current = server.current;
  for (const enabled of [false, true]) {
    const dish = preparationMeals(current.snapshot, today)[0].dishes[0];
    const ingredients = structuredClone(dish.ingredients);
    ingredients[0] = { ...ingredients[0], quantity: 0, enabled };
    current = await success(server.command('saveDishPreparation', [server.orderId, server.recipeId, { ingredients, note: dish.note }, dish.editSignature], current.revision));
    current = await server.bootstrap();
    assert.equal(preparationMeals(current.snapshot, today)[0].dishes[0].ingredients[0].quantity, 0);
  }
  let dish = preparationMeals(current.snapshot, today)[0].dishes[0];
  current = await success(server.command('saveShoppingDraft', [server.orderId, server.recipeId, wholeDishShoppingDraft(dish), server.signature(current)], current.revision));
  current = await server.bootstrap();
  assert.equal(shoppingCartMeals(current.snapshot, today)[0].dishes[0].purchaseIngredients[0].quantity, 0);
  for (const prepared of [true, false]) {
    dish = preparationMeals(current.snapshot, today)[0].dishes[0];
    current = await success(server.command('setDishPrepared', [server.orderId, server.recipeId, prepared, dish.signature], current.revision));
    assert.equal(preparationMeals(current.snapshot, today)[0].dishes[0].prepared, prepared);
  }
  current = await success(server.command('updateOrder', [server.orderId, 'completed'], current.revision));
  assert.equal(current.snapshot.orders[0].status, 'completed');
  for (const field of ['recipes', 'inventory', 'purchases']) assert.deepEqual(current.snapshot[field], original[field]);
});

for (const action of ['completed', 'cancelled', 'deleted', 'prepared']) {
  test(`cloud ${action} clears its package atomically without inventory or payment writes`, async () => {
    const server = await fixture();
    let current = await success(server.command('saveShoppingDraft', [server.orderId, server.recipeId, server.draft, server.signature(server.current)], server.current.revision));
    const inventory = await server.repository.list('inventory');
    const purchases = await server.repository.list('purchases');
    if (action === 'prepared') current = await success(server.command('setDishPrepared', [server.orderId, server.recipeId, true, preparationMeals(current.snapshot, today)[0].dishes[0].signature], current.revision));
    else if (action === 'deleted') current = await success(server.command('removeOrder', [server.orderId], current.revision));
    else current = await success(server.command('updateOrder', [server.orderId, action], current.revision));
    assert.deepEqual(shoppingCartMeals(current.snapshot, today), []);
    if (action !== 'deleted') assert.deepEqual(current.snapshot.orders[0].shoppingDrafts, []);
    assert.deepEqual(await server.repository.list('inventory'), inventory);
    assert.deepEqual(await server.repository.list('purchases'), purchases);
    if (action === 'prepared') assert.equal(current.snapshot.orders[0].status, 'accepted');
  });
}

test('unfinished packages remain editable after midnight but old meals cannot be served', async () => {
  const server = await fixture();
  server.advance(4);
  let current = await server.bootstrap();
  current = await success(server.command('saveShoppingDraft', [server.orderId, server.recipeId, server.draft, server.signature(current)], current.revision));
  assert.equal(shoppingCartMeals(current.snapshot, '2026-10-30').length, 1);
  const rejected = await server.command('updateOrder', [server.orderId, 'completed'], current.revision);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'INVALID');
  assert.equal(rejected.message, '只能当天开饭');
  const restored = await server.bootstrap();
  assert.equal(restored.revision, current.revision);
  assert.deepEqual(restored.snapshot.orders, current.snapshot.orders);
  assert.equal(shoppingCartMeals(restored.snapshot, '2026-10-30').length, 1);
});
