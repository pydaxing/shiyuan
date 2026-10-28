import test from 'node:test';
import assert from 'node:assert/strict';
import { createKitchenActions } from '../src/domain/actions.js';
import { createSeed } from '../src/data/seed.js';
import { shoppingMeals } from '../src/domain/meal-preparation.js';
import { kitchenWelcome } from '../src/domain/home-welcome.js';

const today = '2026-10-23';
const selection = { date: today, meal: '晚餐' };

function fixture() {
  let state = { ...createSeed(), orders: [], purchases: [] };
  let sequence = 0;
  const actions = createKitchenActions({ getState: () => state, commit: next => { state = next; }, newId: prefix => `${prefix}-${++sequence}`, today: () => today });
  const cart = { [state.recipes[0].id]: 1 };
  actions.submitOrder(cart, selection);
  return { actions, cart, state: () => state };
}

for (const status of ['pending', 'accepted', 'completed', 'cancelled']) {
  test(`deleting a ${status} meal frees the same reservation without touching recipes or stock`, () => {
    const kitchen = fixture();
    const order = kitchen.state().orders[0];
    order.status = status;
    order.preparationEdits = [{ recipeId: order.items[0].recipe.id, note: '这一餐少放盐', ingredients: [] }];
    order.preparedDishes = [{ recipeId: order.items[0].recipe.id }];
    const protectedData = structuredClone({ family: kitchen.state().family, recipes: kitchen.state().recipes, mealSets: kitchen.state().mealSets, inventory: kitchen.state().inventory });
    if (status === 'completed') assert.throws(() => kitchen.actions.submitOrder(kitchen.cart, selection), /已经做好/);
    assert.equal(kitchen.actions.removeOrder(order.id), order.id);
    assert.deepEqual(kitchen.state().orders, []);
    assert.deepEqual(shoppingMeals(kitchen.state(), today), []);
    assert.equal(kitchenWelcome(kitchen.state().orders, today).mode, 'empty');
    assert.deepEqual({ family: kitchen.state().family, recipes: kitchen.state().recipes, mealSets: kitchen.state().mealSets, inventory: kitchen.state().inventory }, protectedData);
    kitchen.actions.submitOrder(kitchen.cart, selection);
    const replacement = kitchen.state().orders[0];
    assert.notEqual(replacement.id, order.id);
    assert.equal(replacement.date, selection.date);
    assert.equal(replacement.meal, selection.meal);
    assert.equal(replacement.status, 'accepted');
    assert.equal(replacement.preparationEdits, undefined);
    assert.equal(replacement.preparedDishes, undefined);
  });
}

test('meal deletion cleans only its purchase links and preserves other meals and shared purchases', () => {
  const kitchen = fixture();
  const deletedId = kitchen.state().orders[0].id;
  kitchen.actions.submitOrder(kitchen.cart, { date: today, meal: '午餐' });
  const retainedOrder = structuredClone(kitchen.state().orders.find(order => order.id !== deletedId));
  kitchen.state().purchases = [
    { id: 'only-deleted', orderIds: [deletedId] },
    { id: 'shared', orderIds: [deletedId, retainedOrder.id], name: '牛肉', quantity: 500, unit: 'g' },
    { id: 'other', orderIds: [retainedOrder.id], name: '菜梗', quantity: 100, unit: 'g' }
  ];
  kitchen.actions.removeOrder(deletedId);
  assert.deepEqual(kitchen.state().orders, [retainedOrder]);
  assert.deepEqual(kitchen.state().purchases, [
    { id: 'shared', orderIds: [retainedOrder.id], name: '牛肉', quantity: 500, unit: 'g' },
    { id: 'other', orderIds: [retainedOrder.id], name: '菜梗', quantity: 100, unit: 'g' }
  ]);
});

test('a stale or failed deletion cannot remove anything locally', () => {
  const kitchen = fixture();
  const before = structuredClone(kitchen.state());
  assert.throws(() => kitchen.actions.removeOrder('not-present'), error => error.code === 'CONFLICT');
  assert.deepEqual(kitchen.state(), before);
  const failing = createKitchenActions({ getState: kitchen.state, commit() { throw new Error('保存失败'); } });
  assert.throws(() => failing.removeOrder(before.orders[0].id), /保存失败/);
  assert.deepEqual(kitchen.state(), before);
});
