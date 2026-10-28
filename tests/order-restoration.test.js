import test from 'node:test';
import assert from 'node:assert/strict';
import { createKitchenActions } from '../src/domain/actions.js';
import { createSeed } from '../src/data/seed.js';
import { shoppingMeals } from '../src/domain/meal-preparation.js';
import { kitchenOrders } from '../src/domain/kitchen.js';

const today = '2026-10-23';
const selection = { date: today, meal: '晚餐' };

function fixture() {
  let state = { ...createSeed(), orders: [], purchases: [] };
  let sequence = 0;
  const actions = createKitchenActions({ getState: () => state, commit: next => { state = next; }, newId: prefix => `${prefix}-${++sequence}`, today: () => today });
  const cart = { [state.recipes[0].id]: 1 };
  actions.submitOrder(cart, selection, '少放辣');
  const orderId = state.orders[0].id;
  actions.updateOrder(orderId, 'cancelled');
  return { actions, cart, orderId, state: () => state };
}

test('restoring a cancelled meal keeps its original dishes and preparation, returns it to kitchen and procurement', () => {
  const kitchen = fixture();
  const order = kitchen.state().orders[0];
  order.preparationEdits = [{ recipeId: order.items[0].recipe.id, note: '另外带葱', ingredients: [] }];
  order.preparedDishes = [{ recipeId: order.items[0].recipe.id, signature: 'previous-preparation' }];
  const before = structuredClone(kitchen.state());
  assert.deepEqual(shoppingMeals(before, today), []);
  kitchen.actions.updateOrder(order.id, 'accepted');
  assert.deepEqual(kitchen.state().orders[0], { ...before.orders[0], status: 'accepted' });
  for (const field of ['family', 'recipes', 'mealSets', 'inventory', 'purchases']) assert.deepEqual(kitchen.state()[field], before[field]);
  assert.equal(shoppingMeals(kitchen.state(), today).length, 1);
  assert.equal(kitchenOrders(kitchen.state().orders, today)[0].status, 'accepted');
  const restored = kitchen.state();
  kitchen.actions.updateOrder(order.id, 'accepted');
  assert.equal(kitchen.state(), restored);
});

for (const status of ['pending', 'accepted', 'completed']) {
  test(`restoration rejects another ${status} meal in the same slot without changing either order`, () => {
    const kitchen = fixture();
    kitchen.actions.submitOrder(kitchen.cart, selection);
    kitchen.state().orders[0].status = status;
    const before = structuredClone(kitchen.state());
    assert.throws(() => kitchen.actions.updateOrder(kitchen.orderId, 'accepted'), error => error.code === 'CONFLICT' && /不能重复恢复/.test(error.message));
    assert.deepEqual(kitchen.state(), before);
  });
}

test('cancelled siblings do not block restoration, but restoring a second one cannot duplicate the slot', () => {
  const kitchen = fixture();
  kitchen.actions.submitOrder(kitchen.cart, selection);
  const newerId = kitchen.state().orders[0].id;
  kitchen.actions.updateOrder(newerId, 'cancelled');
  kitchen.actions.updateOrder(kitchen.orderId, 'accepted');
  assert.equal(kitchen.state().orders.find(order => order.id === newerId).status, 'cancelled');
  assert.throws(() => kitchen.actions.updateOrder(newerId, 'accepted'), /不能重复恢复/);
  assert.equal(kitchen.state().orders.filter(order => order.status === 'accepted').length, 1);
});

test('restoration retains the existing date window and cannot reopen completed or missing orders', () => {
  for (const date of ['2026-10-22', '2026-10-26']) {
    const kitchen = fixture();
    kitchen.state().orders[0].date = date;
    const before = structuredClone(kitchen.state());
    assert.throws(() => kitchen.actions.updateOrder(kitchen.orderId, 'accepted'), /只能预订/);
    assert.deepEqual(kitchen.state(), before);
  }
  const kitchen = fixture();
  assert.throws(() => kitchen.actions.updateOrder('missing-order', 'accepted'), /状态已变化/);
  kitchen.state().orders[0].status = 'completed';
  assert.throws(() => kitchen.actions.updateOrder(kitchen.orderId, 'accepted'), /状态已变化/);
});

test('a failed restore save preserves the cancelled source state and original procurement data', () => {
  const kitchen = fixture();
  const before = structuredClone(kitchen.state());
  const failing = createKitchenActions({ getState: kitchen.state, commit() { throw new Error('保存失败'); }, today: () => today });
  assert.throws(() => failing.updateOrder(kitchen.orderId, 'accepted'), /保存失败/);
  assert.deepEqual(kitchen.state(), before);
});
