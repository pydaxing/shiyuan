import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeed } from '../src/data/seed.js';
import { aggregateItems, completeOrder, getShoppingRequirements, makeOrder, normalizeSnapshot, validateMealSet, validateSnapshot } from '../src/domain/kitchen.js';
import { makeShare, parseShare } from '../src/domain/sharing.js';

const seed = () => normalizeSnapshot(createSeed());
const date = '2026-09-07';
const base = () => ({ id: 'order', recipes: seed().recipes, mealSets: [{ id: 'pair', title: '家常双拼', recipeIds: ['tomato', 'broccoli'] }], member: { id: 'me', name: '我' }, date, meal: '晚餐', diners: 2 });

test('legacy snapshots receive fridge-off and shopping-off defaults and empty sets without mutation', () => {
  const previous = createSeed();
  const next = normalizeSnapshot(previous);
  assert.deepEqual(next.family.features, { fridge: false, shopping: false });
  assert.deepEqual(next.mealSets, []);
  assert.equal(previous.mealSets, undefined);
});
test('set only ordering keeps set grouping and snapshots every ingredient', () => {
  const order = makeOrder({ ...base(), cart: { 'set:pair': 1 } });
  assert.equal(order.entries[0].kind, 'set');
  assert.equal(order.entries[0].dishCount, 2);
  assert.equal(order.items.length, 2);
  assert.equal(order.diners, undefined);
});
test('mixed set and dish orders deduplicate overlapping dishes', () => {
  const order = makeOrder({ ...base(), cart: { 'set:pair': 1, tomato: 1 }, diners: 4 });
  assert.equal(order.entries.length, 2);
  assert.equal(order.items.length, 2);
  assert.equal(order.items[0].chosenBy.length, 1);
  assert.equal(aggregateItems(order.items).find((item) => item.name === '番茄').quantity, 400);
  assert.equal(aggregateItems(order.items).find((item) => item.name === '西兰花').quantity, 300);
});
test('old diner arguments no longer scale standard recipe quantities', () => {
  const order = makeOrder({ ...base(), cart: { soup: 1 }, diners: 6 });
  assert.equal(order.items[0].recipe.servings, 3);
  assert.equal(aggregateItems(order.items).find((item) => item.name === '排骨').quantity, 500);
  assert.equal(aggregateItems(order.items).find((item) => item.name === '玉米').quantity, 2);
  const state = seed(); state.orders = [order];
  assert.doesNotThrow(() => validateSnapshot(state));
});
test('missing sets and duplicate set members are rejected', () => {
  assert.throws(() => makeOrder({ ...base(), cart: { 'set:missing': 1 } }), /不在家庭菜单/);
  assert.throws(() => validateMealSet({ title: '坏套餐', recipeIds: ['tomato', 'tomato'] }, seed().recipes), /不同菜品/);
});
test('all-order shopping shares stock once across dates and meal times', () => {
  const state = seed();
  state.family.features.fridge = true;
  state.inventory = [{ id: 'stock', name: '番茄', quantity: 500, unit: 'g', expiresOn: '2026-09-20' }];
  state.orders = [makeOrder({ ...base(), cart: { tomato: 1 } }), makeOrder({ ...base(), id: 'second', date: '2026-09-08', meal: '午餐', cart: { tomato: 1 } })];
  const result = getShoppingRequirements(state, date).find((item) => item.name === '番茄');
  assert.equal(result.quantity, 800);
  assert.equal(result.available, 500);
  assert.equal(result.missing, 300);
});
test('all-order shopping assigns early-expiring stock only to eligible dates', () => {
  const state = seed();
  state.family.features.fridge = true;
  state.inventory = [{ id: 'stock', name: '番茄', quantity: 900, unit: 'g', expiresOn: date }];
  state.orders = [makeOrder({ ...base(), id: 'later', date: '2026-09-08', cart: { tomato: 1 } }), makeOrder({ ...base(), cart: { tomato: 1 } })];
  assert.equal(getShoppingRequirements(state, date).find((item) => item.name === '番茄').missing, 400);
});
test('enabling the fridge preserves legacy receipts and completion only detaches its own order', () => {
  const state = seed();
  state.orders = [{ ...makeOrder({ ...base(), cart: { tomato: 1 } }), status: 'accepted' }, makeOrder({ ...base(), id: 'second', cart: { tomato: 1 } })];
  state.purchases = [{ id: 'receipt', name: '番茄', quantity: 600, unit: 'g', orderIds: ['order', 'second'] }];
  state.inventory = [{ id: 'stock', name: '番茄', quantity: 300, unit: 'g' }, { id: 'eggs', name: '鸡蛋', quantity: 10, unit: '个' }, { id: 'oil', name: '食用油', quantity: 100, unit: 'ml' }, { id: 'salt', name: '盐', quantity: 100, unit: 'g' }];
  const tomatoRequirement = (snapshot) => getShoppingRequirements(snapshot, date).find((item) => item.name === '番茄');
  assert.equal(tomatoRequirement(state).missing, 200);
  state.family.features.fridge = true;
  assert.equal(tomatoRequirement(state).missing, 0);
  const completed = completeOrder(state, 'order', date);
  assert.equal(completed.purchases[0].quantity, 600);
  assert.deepEqual(completed.purchases[0].orderIds, ['second']);
  assert.equal(completed.inventory[0].quantity, 300);
  assert.equal(tomatoRequirement(completed).missing, 0);
  assert.equal(state.purchases[0].quantity, 600);
  completed.family.features.fridge = false;
  assert.equal(tomatoRequirement(completed).missing, 0);
});
test('purchase receipts never cover unrelated orders when the fridge is enabled', () => {
  const state = seed();
  state.family.features.fridge = true;
  state.inventory = [];
  state.orders = [makeOrder({ ...base(), cart: { tomato: 1 } })];
  state.purchases = [{ id: 'receipt', name: '番茄', quantity: 900, unit: 'g', orderIds: ['cancelled-order'] }];
  assert.equal(getShoppingRequirements(state, date).find((item) => item.name === '番茄').missing, 400);
});
test('fridge disabled allows completion without stock or inventory mutation', () => {
  const state = seed(); state.family.features.fridge = false;
  state.orders = [{ ...makeOrder({ ...base(), cart: { 'set:pair': 1 } }), status: 'accepted' }];
  const completed = completeOrder(state, 'order', date);
  assert.equal(completed.orders[0].status, 'completed');
  assert.deepEqual(completed.inventory, state.inventory);
});
test('shopping without fridge tracks only purchases for the linked unfinished orders', () => {
  const state = seed(); state.family.features.fridge = false;
  state.orders = [makeOrder({ ...base(), cart: { tomato: 1 } })];
  state.purchases = [{ id: 'purchase', name: '番茄', unit: 'g', quantity: 600, orderIds: ['order'] }];
  assert.equal(getShoppingRequirements(state, date).find((item) => item.name === '番茄').missing, 0);
  state.orders.push(makeOrder({ ...base(), id: 'new-order', cart: { tomato: 1 } }));
  assert.equal(getShoppingRequirements(state, date).find((item) => item.name === '番茄').missing, 400);
  state.orders[0].status = 'cancelled';
  assert.equal(getShoppingRequirements(state, date).find((item) => item.name === '番茄').missing, 400);
});
test('completing without fridge retains shared receipts for the remaining meal without changing amounts', () => {
  const state = seed(); state.family.features.fridge = false;
  state.orders = [{ ...makeOrder({ ...base(), cart: { tomato: 1 } }), status: 'accepted' }, makeOrder({ ...base(), id: 'second', cart: { tomato: 1 } })];
  state.purchases = [{ id: 'purchase', name: '番茄', quantity: 0.5, unit: 'kg', orderIds: ['order', 'second'] }];
  const completed = completeOrder(state, 'order', date);
  assert.equal(completed.purchases[0].quantity, 0.5);
  assert.deepEqual(completed.purchases[0].orderIds, ['second']);
  assert.equal(getShoppingRequirements(completed, date).find((item) => item.name === '番茄').missing, 0);
});
test('dish and set sharing round trip recipes and steps without personal family data', () => {
  const state = seed();
  const dish = parseShare(makeShare(state.recipes[0], state.recipes, '我'));
  assert.equal(dish.kind, 'dish');
  assert.deepEqual(dish.recipes[0].steps, state.recipes[0].steps);
  assert.equal(dish.family, undefined);
  const mealSet = parseShare(makeShare(base().mealSets[0], state.recipes, '我', 'set'));
  assert.equal(mealSet.kind, 'menu');
  assert.equal(mealSet.recipes.length, 2);
});
test('malformed and unsafe share contents never import', () => {
  assert.throws(() => parseShare('broken'), /不完整/);
  assert.throws(() => parseShare('{}'), /有效/);
  const text = JSON.parse(makeShare(seed().recipes[0], seed().recipes, '我'));
  text.recipes[0].image = 'javascript:alert(1)';
  assert.throws(() => parseShare(JSON.stringify(text)), /图片/);
});
