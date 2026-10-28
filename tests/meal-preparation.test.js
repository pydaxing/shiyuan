import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeed } from '../src/data/seed.js';
import { createKitchenActions } from '../src/domain/actions.js';
import { completeOrder, dateOffset, makeOrder, normalizeSnapshot, validateSnapshot } from '../src/domain/kitchen.js';
import { dishIngredientGroups, dishPreparationSignature, preparationKey, shoppingMeals, shoppingOrderAnchor } from '../src/domain/meal-preparation.js';

const today = '2026-10-22';
const slot = { date: today, meal: '晚餐' };

function fixture(features = { fridge: true, shopping: true }) {
  let snapshot = normalizeSnapshot(createSeed());
  snapshot.family.features = features;
  snapshot.orders = [];
  snapshot.purchases = [];
  let sequence = 0;
  const actions = createKitchenActions({ getState: () => snapshot, commit: next => { validateSnapshot(next); snapshot = next; }, newId: prefix => `${prefix}-${++sequence}`, today: () => today });
  actions.submitOrder({ tomato: 1, broccoli: 1 }, slot);
  return { actions, get snapshot() { return snapshot; }, get order() { return snapshot.orders[0]; } };
}

test('preparation retains each unfinished meal and dish without combining their ingredients', () => {
  const context = fixture();
  const member = context.snapshot.family.members[0];
  const dates = [dateOffset(1, today), today, dateOffset(-1, today), dateOffset(3, today)];
  const additional = dates.map((date, index) => makeOrder({ id: `extra-${index}`, recipes: context.snapshot.recipes, member, cart: { tomato: 1 }, date, meal: '早餐' }));
  context.snapshot.orders.push(...additional, { ...structuredClone(context.order), id: 'cancelled', status: 'cancelled' }, { ...structuredClone(context.order), id: 'completed', status: 'completed' });
  const meals = shoppingMeals(context.snapshot, today);
  assert.deepEqual(meals.map(order => [order.date, order.meal]), [[today, '早餐'], [today, '晚餐'], [dateOffset(1, today), '早餐'], [dateOffset(3, today), '早餐'], [dateOffset(-1, today), '早餐']]);
  assert.equal(meals[1].dishes.length, 2);
  assert.deepEqual(meals[1].dishes.map(dish => dish.recipe.id), ['tomato', 'broccoli']);
  assert.equal(meals[0].dishes[0].recipe.id, meals[1].dishes[0].recipe.id);
  assert.equal(meals[1].preparedCount, 0);
  assert.notEqual(preparationKey(meals[0].id, 'tomato'), preparationKey(meals[1].id, 'tomato'));
  assert.equal(shoppingOrderAnchor(2), 'shopping-meal-2');
});

test('ingredient bands preserve amounts, original units, text quantities and recipe order', () => {
  const item = { recipe: { id: 'dish', ingredients: [
    { name: '牛肉', quantity: 0.25, unit: 'kg' },
    { name: '土豆', quantity: 1, unit: '个' },
    { name: '盐', quantity: null, unit: '', amountText: '适量' },
    { name: '生抽', quantity: 1, unit: '勺' },
    { name: '食用油', quantity: null, unit: '', amountText: '少许' },
  ] }, quantity: 2, scale: 0.5 };
  const before = structuredClone(item);
  const groups = dishIngredientGroups(item);
  assert.deepEqual(groups.map(group => group.label), ['食材', '配料']);
  assert.deepEqual(groups[0].items.map(entry => [entry.name, entry.amount]), [['牛肉', '0.25 kg'], ['土豆', '1 个']]);
  assert.deepEqual(groups[1].items.map(entry => [entry.name, entry.amount]), [['盐', '适量'], ['生抽', '1 勺'], ['食用油', '少许']]);
  assert.deepEqual(item, before);
  assert.deepEqual(dishIngredientGroups({ ...item, recipe: { id: 'empty', ingredients: [] } }), []);
});

test('fridge stock, old purchase records and feature flags never auto-prepare a dish', () => {
  const context = fixture();
  const expected = shoppingMeals(context.snapshot, today);
  context.snapshot.inventory = [{ id: 'huge-stock', name: '番茄', quantity: 99999, unit: 'kg', location: '冷藏' }];
  context.snapshot.purchases = [{ id: 'legacy', name: '番茄', quantity: 99999, unit: 'g', orderIds: [context.order.id] }];
  context.snapshot.family.features = { fridge: false, shopping: false };
  assert.deepEqual(shoppingMeals(context.snapshot, today), expected);
});

for (const status of ['pending', 'accepted']) {
  test(`manual preparation persists, is shared and is reversible during ${status}`, () => {
    const context = fixture();
    context.order.status = status;
    const supplies = structuredClone({ inventory: context.snapshot.inventory, purchases: context.snapshot.purchases });
    const signature = dishPreparationSignature(context.order.items[0]);
    context.actions.setDishPrepared(context.order.id, 'tomato', true, signature);
    assert.equal(shoppingMeals(context.snapshot, today)[0].preparedCount, 1);
    assert.equal(context.order.preparedDishes[0].preparedBy, 'me');
    assert.ok(context.order.preparedDishes[0].preparedAt);
    const restored = normalizeSnapshot(JSON.parse(JSON.stringify(context.snapshot)));
    assert.equal(shoppingMeals(restored, today)[0].dishes[0].prepared, true);
    context.actions.setDishPrepared(context.order.id, 'tomato', true, signature);
    assert.equal(context.order.preparedDishes.length, 1);
    context.actions.switchMember('partner');
    assert.equal(shoppingMeals(context.snapshot, today)[0].preparedCount, 1);
    context.actions.setDishPrepared(context.order.id, 'tomato', false, signature);
    assert.equal(shoppingMeals(context.snapshot, today)[0].preparedCount, 0);
    assert.deepEqual(context.order.preparedDishes, []);
    assert.deepEqual({ inventory: context.snapshot.inventory, purchases: context.snapshot.purchases }, supplies);
  });
}

test('same dish on different meals has independent preparation records', () => {
  const context = fixture();
  const first = context.order;
  context.actions.submitOrder({ tomato: 1 }, { date: dateOffset(1, today), meal: '午餐' });
  context.actions.setDishPrepared(first.id, 'tomato', true, dishPreparationSignature(first.items[0]));
  assert.deepEqual(shoppingMeals(context.snapshot, today).map(order => order.preparedCount), [1, 0]);
});

test('another member choosing the same dish does not duplicate its pack or discard preparation', () => {
  const context = fixture();
  context.actions.setDishPrepared(context.order.id, 'tomato', true, dishPreparationSignature(context.order.items[0]));
  context.actions.switchMember('partner');
  context.actions.addOrderDishes(context.order.id, { tomato: 1 });
  const meal = shoppingMeals(context.snapshot, today)[0];
  assert.equal(meal.dishes.length, 2);
  assert.equal(meal.dishes[0].quantity, 1);
  assert.equal(meal.preparedCount, 1);
});

test('removing then re-adding a dish never resurrects its old prepared flag', () => {
  const context = fixture();
  const signature = dishPreparationSignature(context.order.items[0]);
  context.actions.setDishPrepared(context.order.id, 'tomato', true, signature);
  context.actions.submitOrder({ broccoli: 1 }, slot);
  assert.deepEqual(context.order.preparedDishes, []);
  context.actions.addOrderDishes(context.order.id, { tomato: 1 });
  assert.equal(shoppingMeals(context.snapshot, today)[0].preparedCount, 0);
});

test('a changed recipe or quantity invalidates previous preparation and rejects stale clicks', () => {
  for (const change of [item => { item.quantity = 2; }, item => { item.scale = 2; }, item => { item.recipe.ingredients[0].quantity += 1; }]) {
    const context = fixture();
    const signature = dishPreparationSignature(context.order.items[0]);
    context.actions.setDishPrepared(context.order.id, 'tomato', true, signature);
    change(context.order.items[0]);
    assert.equal(shoppingMeals(context.snapshot, today)[0].preparedCount, 0);
    const before = structuredClone(context.snapshot);
    assert.throws(() => context.actions.setDishPrepared(context.order.id, 'tomato', true, signature), { code: 'CONFLICT' });
    assert.deepEqual(context.snapshot, before);
  }
});

test('closed, missing or malformed preparation requests cannot mutate state', () => {
  const scenarios = [
    context => { context.order.status = 'completed'; },
    context => { context.order.status = 'cancelled'; },
  ];
  for (const prepare of scenarios) {
    const context = fixture();
    prepare(context);
    const before = structuredClone(context.snapshot);
    assert.throws(() => context.actions.setDishPrepared(context.order.id, 'tomato', true, dishPreparationSignature(context.order.items[0])));
    assert.deepEqual(context.snapshot, before);
  }
  const context = fixture();
  const signature = dishPreparationSignature(context.order.items[0]);
  for (const args of [['other', 'tomato', true, signature], [context.order.id, 'unknown', true, signature], [context.order.id, 'tomato', 'true', signature], [context.order.id, 'tomato', true, '']]) {
    const before = structuredClone(context.snapshot);
    assert.throws(() => context.actions.setDishPrepared(...args));
    assert.deepEqual(context.snapshot, before);
  }
});

for (const features of [{ fridge: true, shopping: false }, { fridge: false, shopping: true }, { fridge: false, shopping: false }]) {
  test(`legacy feature combination permits manual preparation: ${JSON.stringify(features)}`, () => {
    const context = fixture(features);
    context.actions.setDishPrepared(context.order.id, 'tomato', true, dishPreparationSignature(context.order.items[0]));
    assert.equal(shoppingMeals(context.snapshot, today)[0].preparedCount, 1);
  });
}

test('past unfinished meals remain manually preparable without disappearing at midnight', () => {
  const context = fixture({ fridge: false, shopping: false });
  context.order.date = dateOffset(-1, today);
  context.actions.setDishPrepared(context.order.id, 'tomato', true, dishPreparationSignature(context.order.items[0]));
  assert.equal(shoppingMeals(context.snapshot, today)[0].preparedCount, 1);
});

for (const status of ['pending', 'accepted']) for (const prepared of [false, true]) {
  test(`completion never gates on stock or readiness: ${status}, prepared=${prepared}`, () => {
    const context = fixture();
    context.order.status = status;
    context.snapshot.inventory = [];
    if (prepared) context.actions.setDishPrepared(context.order.id, 'tomato', true, dishPreparationSignature(context.order.items[0]));
    const completed = completeOrder(context.snapshot, context.order.id, today);
    assert.equal(completed.orders[0].status, 'completed');
    assert.ok(completed.orders[0].completedAt);
    assert.deepEqual(shoppingMeals(completed, today), []);
    assert.deepEqual(completed.inventory, []);
    assert.equal(context.order.status, status);
  });
}

for (const action of ['completed', 'cancelled']) {
  test(`${action} clears only that meal's legacy receipts and leaves other meals and fridge untouched`, () => {
    const context = fixture();
    const targetId = context.order.id;
    context.actions.submitOrder({ tomato: 1 }, { date: dateOffset(1, today), meal: '午餐' });
    const nextId = context.order.id;
    context.snapshot.purchases = [{ id: 'only', name: '盐', quantity: 1, unit: 'g', orderIds: [targetId] }, { id: 'shared', name: '番茄', quantity: 500, unit: 'g', orderIds: [targetId, nextId] }];
    const stock = structuredClone(context.snapshot.inventory);
    context.actions.updateOrder(targetId, action);
    assert.deepEqual(shoppingMeals(context.snapshot, today).map(order => order.id), [nextId]);
    assert.deepEqual(context.snapshot.purchases, [{ id: 'shared', name: '番茄', quantity: 500, unit: 'g', orderIds: [nextId] }]);
    assert.deepEqual(context.snapshot.inventory, stock);
    assert.equal(context.snapshot.orders.length, 2);
  });
}

test('snapshot validation rejects duplicate or malformed preparation records', () => {
  const context = fixture();
  context.actions.setDishPrepared(context.order.id, 'tomato', true, dishPreparationSignature(context.order.items[0]));
  assert.doesNotThrow(() => validateSnapshot(context.snapshot));
  const record = context.order.preparedDishes[0];
  for (const records of [[record, record], [{ ...record, recipeId: 'missing' }], [{ ...record, signature: '' }], [{ ...record, preparedAt: 'invalid' }]]) {
    const invalid = structuredClone(context.snapshot);
    invalid.orders[0].preparedDishes = records;
    assert.throws(() => validateSnapshot(invalid));
  }
});
