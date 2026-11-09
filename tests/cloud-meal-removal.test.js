import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication as createSourceApplication } from '../server/application.mjs';
import { loadCloudApplication } from './helpers/cloud-bundle.js';
import { memoryRepository } from './helpers/memory-repository.js';
import { createSeed } from '../src/data/seed.js';
import { INGREDIENT_UNITS_VERSION } from '../src/domain/ingredient-units.js';

const today = '2026-10-27';
const createApplication = process.env.KITCHEN_TEST_BUNDLE ? await loadCloudApplication(process.env.KITCHEN_TEST_BUNDLE) : createSourceApplication;
const success = async promise => { const response = await promise; assert.equal(response.ok, true, JSON.stringify(response)); return response.data; };

async function fixture() {
  const repository = memoryRepository();
  const app = createApplication({ repository, now: () => Date.parse(`${today}T05:00:00Z`), signFiles: async () => ({}), storeImage: async fileId => fileId });
  let sequence = 0;
  const call = (action, payload = {}, openid = 'alice') => app({ action, ingredientUnitsVersion: INGREDIENT_UNITS_VERSION, ...payload }, { OPENID: openid });
  const command = (name, args, revision, options = {}, openid = 'alice') => call('command', { name, args, revision, requestId: `removal-request-${++sequence}`, ...options }, openid);
  let current = await success(call('createFamily', { name: '我', familyName: '减菜测试' }));
  for (const recipe of createSeed().recipes.slice(0, 2)) current = await success(command('saveRecipe', [recipe], current.revision));
  const recipeIds = current.snapshot.recipes.map(recipe => recipe.id);
  current = await success(command('submitOrder', [Object.fromEntries(recipeIds.map(id => [id, 1])), { date: today, meal: '晚餐' }], current.revision));
  return { repository, call, command, current, recipeIds, orderId: current.snapshot.orders[0].id };
}

test('server removal persists only this dish and returns an orders-only change patch', async () => {
  const app = await fixture();
  const result = await success(app.command('removeOrderDish', [app.orderId, app.recipeIds[0]], app.current.revision, { familyId: app.current.familyId, responseMode: 'changes' }));
  assert.equal(result.value, app.orderId);
  const current = await success(app.call('bootstrap', { includeFeed: false }));
  assert.deepEqual(current.snapshot.orders[0].items.map(item => item.recipe.id), [app.recipeIds[1]]);
  assert.equal(current.snapshot.orders[0].status, 'accepted');
  assert.deepEqual(current.snapshot.recipes, app.current.snapshot.recipes);
  assert.deepEqual(current.snapshot.inventory, app.current.snapshot.inventory);
});

test('server final-dish removal deletes the meal and preserves idempotency', async () => {
  const app = await fixture();
  const requestId = 'remove-specific-dish-once';
  let current = await success(app.command('removeOrderDish', [app.orderId, app.recipeIds[0]], app.current.revision, { requestId }));
  current = await success(app.command('addOrderDishes', [app.orderId, { [app.recipeIds[0]]: 1 }], current.revision));
  await success(app.command('removeOrderDish', [app.orderId, app.recipeIds[0]], app.current.revision, { requestId }));
  current = await success(app.call('bootstrap', { includeFeed: false }));
  assert.equal(current.snapshot.orders[0].items.length, 2, 'the replay cannot remove a later addition');
  current = await success(app.command('removeOrderDish', [app.orderId, app.recipeIds[0]], current.revision));
  current = await success(app.command('removeOrderDish', [app.orderId, app.recipeIds[1]], current.revision));
  assert.deepEqual(current.snapshot.orders, []);
  const reloaded = await success(app.call('bootstrap', { includeFeed: false }));
  assert.deepEqual(reloaded.snapshot.orders, []);
  current = await success(app.command('submitOrder', [{ [app.recipeIds[0]]: 1 }, { date: today, meal: '晚餐' }], current.revision));
  assert.equal(current.snapshot.orders.length, 1);
  assert.equal(current.snapshot.orders.filter(order => order.status === 'accepted').length, 1);
});

test('stale revisions, wrong families and nonmembers cannot remove dishes', async () => {
  const app = await fixture();
  for (const options of [{ revision: app.current.revision - 1 }, { familyId: 'another-family' }]) {
    const response = await app.command('removeOrderDish', [app.orderId, app.recipeIds[0]], app.current.revision, options);
    assert.equal(response.ok, false);
    assert.equal(response.code, 'CONFLICT');
  }
  const outsider = await app.command('removeOrderDish', [app.orderId, app.recipeIds[0]], app.current.revision, {}, 'outsider');
  assert.equal(outsider.ok, false);
  const current = await success(app.call('bootstrap', { includeFeed: false }));
  assert.deepEqual(current.snapshot.orders, app.current.snapshot.orders);
  await success(app.command('updateOrder', [app.orderId, 'completed'], current.revision));
  const completed = await success(app.call('bootstrap', { includeFeed: false }));
  const rejected = await app.command('removeOrderDish', [app.orderId, app.recipeIds[0]], completed.revision);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'CONFLICT');
});
