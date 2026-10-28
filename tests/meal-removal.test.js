import test from 'node:test';
import assert from 'node:assert/strict';
import { computed, ref } from 'vue';
import { createSeed } from '../src/data/seed.js';
import { createKitchenActions } from '../src/domain/actions.js';
import { normalizeSnapshot, validateSnapshot } from '../src/domain/kitchen.js';
import { preparationMeals } from '../src/domain/meal-preparation.js';
import { shoppingEditSignature, wholeDishShoppingDraft } from '../src/domain/meal-shopping.js';
import { useMealDraft } from '../src/composables/useMealDraft.js';
import { normalizeCommand } from '../server/validation.mjs';

const today = '2026-10-27';
const slot = { date: today, meal: '晚餐' };
const timestamp = Date.parse(`${today}T05:00:00Z`);

function fixture() {
  let state = normalizeSnapshot(createSeed());
  state.orders = [];
  state.purchases = [];
  state.family.members = [{ id: 'me', name: '我' }, { id: 'partner', name: '家人' }];
  state.activeMemberId = 'me';
  let sequence = 0;
  const actions = createKitchenActions({ getState: () => state, commit: next => { validateSnapshot(next); state = next; }, newId: prefix => `${prefix}-${++sequence}`, today: () => today, now: () => timestamp });
  return { actions, get state() { return state; } };
}

test('removing one dish clears all voters and only its preparation and shopping data', () => {
  const app = fixture();
  app.actions.submitOrder({ tomato: 1, soup: 1 }, slot, '少盐');
  const orderId = app.state.orders[0].id;
  app.actions.switchMember('partner');
  app.actions.addOrderDishes(orderId, { tomato: 1, chicken: 1 });
  for (const dish of preparationMeals(app.state, today)[0].dishes) {
    app.actions.saveDishPreparation(orderId, dish.recipe.id, { ingredients: dish.ingredients, note: '本餐调整' }, dish.editSignature);
    const updated = preparationMeals(app.state, today)[0].dishes.find(item => item.recipe.id === dish.recipe.id);
    app.actions.saveShoppingDraft(orderId, dish.recipe.id, wholeDishShoppingDraft(updated), shoppingEditSignature(app.state.orders[0], dish.recipe.id));
  }
  const soup = preparationMeals(app.state, today)[0].dishes.find(item => item.recipe.id === 'soup');
  app.actions.setDishPrepared(orderId, 'soup', true, soup.signature);
  app.actions.submitOrder({ tomato: 1 }, { date: today, meal: '午餐' });
  const other = structuredClone(app.state.orders[0]);
  const protectedData = structuredClone({ recipes: app.state.recipes, mealSets: app.state.mealSets, inventory: app.state.inventory });
  assert.equal(app.actions.removeOrderDish(orderId, 'tomato'), orderId);
  const order = app.state.orders.find(item => item.id === orderId);
  assert.deepEqual(order.items.map(item => item.recipe.id), ['soup', 'chicken']);
  assert.deepEqual(order.items.map(item => item.chosenBy.map(member => member.id)), [['me'], ['partner']]);
  assert.ok(order.selections.every(selection => selection.items.every(item => item.recipe.id !== 'tomato')));
  for (const key of ['preparationEdits', 'shoppingDrafts', 'preparedDishes']) assert.ok(order[key].every(item => item.recipeId !== 'tomato'));
  assert.deepEqual(order.preparedDishes.map(item => item.recipeId), ['soup']);
  assert.equal(order.note, '我：少盐');
  assert.equal(order.status, 'accepted');
  assert.deepEqual(app.state.orders.find(item => item.id === other.id), other);
  assert.deepEqual({ recipes: app.state.recipes, mealSets: app.state.mealSets, inventory: app.state.inventory }, protectedData);
  app.actions.addOrderDishes(orderId, { tomato: 1 });
  const restored = app.state.orders.find(item => item.id === orderId);
  assert.deepEqual(restored.items.find(item => item.recipe.id === 'tomato').chosenBy.map(member => member.id), ['partner']);
  assert.ok(!restored.preparationEdits.some(item => item.recipeId === 'tomato'));
});

test('removing a dish inside a set splits only affected selections into snapshots and does not reselect it in the menu', () => {
  const app = fixture();
  app.actions.saveMealSet({ title: '两菜套餐', image: '', recipeIds: ['tomato', 'soup'] });
  const set = structuredClone(app.state.mealSets[0]);
  app.actions.submitOrder({ [`set:${set.id}`]: 1, soup: 1, chicken: 1 }, slot);
  const orderId = app.state.orders[0].id;
  app.actions.removeOrderDish(orderId, 'tomato');
  const order = app.state.orders[0];
  assert.deepEqual(order.items.map(item => item.recipe.id), ['soup', 'chicken']);
  assert.deepEqual(order.selections[0].entries.map(entry => entry.id), ['soup', 'chicken']);
  assert.equal(new Set(order.entries.map(entry => entry.id)).size, order.entries.length);
  assert.deepEqual(app.state.mealSets[0], set);
  const selection = ref(order.selections[0]);
  const menu = computed(() => [{ key: `set:${set.id}` }, ...app.state.recipes.map(recipe => ({ key: recipe.id }))]);
  const draft = useMealDraft(ref('me'), selection, menu);
  assert.deepEqual(draft.cart.value, { soup: 1, chicken: 1 });
  app.actions.submitOrder(draft.cart.value, slot, '修改备注');
  assert.ok(app.state.orders[0].items.every(item => item.recipe.id !== 'tomato'));
});

test('a member with no remaining dishes is removed from this meal without disturbing other members', () => {
  const app = fixture();
  app.actions.submitOrder({ tomato: 1 }, slot, '我的备注');
  const orderId = app.state.orders[0].id;
  app.actions.switchMember('partner');
  app.actions.addOrderDishes(orderId, { soup: 1 });
  app.actions.removeOrderDish(orderId, 'tomato');
  assert.deepEqual(app.state.orders[0].selections.map(selection => selection.memberId), ['partner']);
  assert.equal(app.state.orders[0].note, '');
});

test('removing the final dish retains an empty cancelled meal and frees the reservation', () => {
  const app = fixture();
  app.actions.submitOrder({ tomato: 1 }, slot, '保留记录');
  const dish = preparationMeals(app.state, today)[0].dishes[0];
  app.actions.saveDishPreparation(app.state.orders[0].id, 'tomato', { ingredients: dish.ingredients, note: '本餐调整' }, dish.editSignature);
  const adjusted = preparationMeals(app.state, today)[0].dishes[0];
  app.actions.saveShoppingDraft(app.state.orders[0].id, 'tomato', wholeDishShoppingDraft(adjusted), shoppingEditSignature(app.state.orders[0], 'tomato'));
  const before = structuredClone(app.state.orders[0]);
  const protectedData = structuredClone({ recipes: app.state.recipes, mealSets: app.state.mealSets, inventory: app.state.inventory });
  app.state.purchases = [{ id: 'shared', name: '番茄', quantity: 100, unit: 'g', orderIds: [before.id, 'other-order'] }];
  app.actions.removeOrderDish(before.id, 'tomato');
  const cancelled = app.state.orders[0];
  assert.equal(cancelled.id, before.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancelledAt, new Date(timestamp).toISOString());
  assert.equal(cancelled.date, before.date);
  assert.equal(cancelled.meal, before.meal);
  assert.equal(cancelled.createdAt, before.createdAt);
  for (const key of ['items', 'entries', 'selections', 'preparationEdits', 'preparedDishes', 'shoppingDrafts']) assert.deepEqual(cancelled[key] || [], []);
  assert.equal(cancelled.note, '');
  assert.deepEqual(normalizeSnapshot(app.state).orders[0], cancelled);
  assert.deepEqual({ recipes: app.state.recipes, mealSets: app.state.mealSets, inventory: app.state.inventory }, protectedData);
  assert.deepEqual(app.state.purchases[0].orderIds, ['other-order']);
  assert.throws(() => app.actions.updateOrder(before.id, 'accepted'), /没有菜品.*重新预订/);
  assert.deepEqual(app.state.orders[0], cancelled);
  app.actions.submitOrder({ soup: 1 }, slot);
  assert.equal(app.state.orders.length, 2);
  assert.notEqual(app.state.orders[0].id, before.id);
  assert.equal(app.state.orders[0].status, 'accepted');
  app.actions.removeOrder(before.id);
  assert.equal(app.state.orders.length, 1);
  assert.equal(app.state.orders[0].status, 'accepted');
});

test('the last prepared dish is removed from every member and loses its ready record', () => {
  const app = fixture();
  app.actions.submitOrder({ tomato: 1 }, slot);
  const orderId = app.state.orders[0].id;
  app.actions.switchMember('partner');
  app.actions.addOrderDishes(orderId, { tomato: 1 });
  const dish = preparationMeals(app.state, today)[0].dishes[0];
  app.actions.setDishPrepared(orderId, 'tomato', true, dish.signature);
  assert.equal(app.state.orders[0].preparedDishes.length, 1);
  app.actions.removeOrderDish(orderId, 'tomato');
  const order = app.state.orders[0];
  assert.equal(order.status, 'cancelled');
  assert.deepEqual(order.items, []);
  assert.deepEqual(order.selections, []);
  assert.deepEqual(order.entries, []);
  assert.deepEqual(order.preparedDishes, []);
});

test('empty cancelled meals survive storage validation without accepting empty active meals or hidden dish references', () => {
  const app = fixture();
  app.actions.submitOrder({ tomato: 1 }, slot);
  const original = structuredClone(app.state.orders[0]);
  app.actions.removeOrderDish(original.id, 'tomato');
  const empty = structuredClone(app.state);
  assert.doesNotThrow(() => validateSnapshot(empty));
  assert.deepEqual(normalizeSnapshot(empty).orders, empty.orders);
  for (const status of ['pending', 'accepted', 'completed']) {
    const invalid = structuredClone(empty);
    invalid.orders[0].status = status;
    assert.throws(() => validateSnapshot(invalid), /存储格式/);
  }
  for (const key of ['entries', 'selections']) {
    const invalid = structuredClone(empty);
    invalid.orders[0][key] = original[key];
    assert.throws(() => validateSnapshot(invalid), /存储格式/);
  }
});

test('cancelling a meal normally still retains its dishes and supports restoration', () => {
  const app = fixture();
  app.actions.submitOrder({ tomato: 1 }, slot);
  const before = structuredClone(app.state.orders[0]);
  app.actions.updateOrder(before.id, 'cancelled');
  assert.deepEqual(app.state.orders[0].items, before.items);
  app.actions.updateOrder(before.id, 'accepted');
  assert.equal(app.state.orders[0].status, 'accepted');
  assert.deepEqual(app.state.orders[0].items, before.items);
});

test('unknown dishes, ended meals, missing orders and dates outside the reservation window do not mutate data', () => {
  const app = fixture();
  app.actions.submitOrder({ tomato: 1, soup: 1 }, slot);
  const orderId = app.state.orders[0].id;
  for (const [target, recipeId] of [['missing', 'tomato'], [orderId, 'missing']]) {
    const before = structuredClone(app.state);
    assert.throws(() => app.actions.removeOrderDish(target, recipeId), error => error.code === 'CONFLICT');
    assert.deepEqual(app.state, before);
  }
  app.actions.removeOrderDish(orderId, 'tomato');
  const after = structuredClone(app.state);
  assert.throws(() => app.actions.removeOrderDish(orderId, 'tomato'), /已从本餐移除/);
  assert.deepEqual(app.state, after);
  for (const status of ['completed', 'cancelled']) {
    app.state.orders[0].status = status;
    assert.throws(() => app.actions.removeOrderDish(orderId, 'soup'), /结束或已取消/);
  }
  app.state.orders[0].status = 'accepted';
  app.state.orders[0].date = '2026-10-26';
  assert.throws(() => app.actions.removeOrderDish(orderId, 'soup'), /今天|日期/);
  assert.deepEqual(normalizeCommand('removeOrderDish', [orderId, 'soup', 'ignored'], today), [orderId, 'soup']);
  for (const recipeId of [null, '', '$all', 1]) assert.throws(() => normalizeCommand('removeOrderDish', [orderId, recipeId], today), /标识/);
});
