import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeed, collections } from '../src/data/seed.js';
import { aggregateItems, completeOrder, dateOffset, expiryLabel, getRequirements, importCollection, isExpired, localDate, makeOrder, normalizedIngredient, validateIngredient, validateRecipe, validateSnapshot, validDate } from '../src/domain/kitchen.js';

const today = '2026-09-07';
const selection = { date: today, meal: '晚餐' };
const ingredient = (name, quantity, unit = 'g') => ({ name, quantity, unit });
const batch = (id, name, quantity, unit = 'g', expiresOn = '') => ({ id, name, quantity, unit, expiresOn, location: '冷藏' });
const recipe = (ingredients = [ingredient('番茄', 400)]) => ({ id: 'sample', title: '测试菜', category: '素菜', servings: 2, minutes: 15, ingredients, steps: [{ text: '煮熟后装盘。', image: '/static/step-cook.png' }] });
const order = (dish = recipe(), quantity = 1, overrides = {}) => ({ id: 'order', ...selection, status: 'pending', items: [{ recipe: dish, quantity }], ...overrides });

test('standard recipe seeds and all collection recipes validate', () => {
  [...createSeed().recipes, ...collections.flatMap((collection) => collection.recipes)].forEach((dish) => assert.doesNotThrow(() => validateRecipe(dish)));
});
test('weight and volume convert to base units', () => {
  assert.deepEqual(normalizedIngredient(ingredient('西红柿', 0.4, 'kg')), { name: '番茄', unit: 'g', factor: 1000, quantity: 400, key: '番茄|g' });
  assert.equal(normalizedIngredient(ingredient('牛奶', 0.25, 'L')).quantity, 250);
});
test('count units remain separate from weights', () => {
  const [result] = getRequirements([order()], [batch('stock', '番茄', 3, '个')], selection, today);
  assert.equal(result.missing, 400);
  assert.equal(result.unitMismatch, true);
});
test('same ingredients across recipes and members aggregate', () => {
  const orders = [order(recipe([ingredient('鸡蛋', 3, '个')]), 2), order(recipe([ingredient('鸡蛋', 2, '个')]), 1, { id: 'another' })];
  const [result] = getRequirements(orders, [batch('eggs', '鸡蛋', 5, '个')], selection, today);
  assert.equal(result.quantity, 8);
  assert.equal(result.missing, 3);
});
test('multiple inventory batches are combined before subtracting', () => {
  const [result] = getRequirements([order()], [batch('first', '番茄', 100), batch('second', '西红柿', 0.2, 'kg')], selection, today);
  assert.equal(result.available, 300);
  assert.equal(result.missing, 100);
});
test('expired stock is not counted but stock expiring today is', () => {
  const [result] = getRequirements([order()], [batch('expired', '番茄', 400, 'g', '2026-09-06'), batch('today', '番茄', 120, 'g', today)], selection, today);
  assert.equal(result.available, 120);
  assert.equal(result.missing, 280);
});
test('future meal excludes stock expiring before the meal date', () => {
  const future = { date: '2026-09-09', meal: '晚餐' };
  const [result] = getRequirements([order(recipe(), 1, future)], [batch('stock', '番茄', 500, 'g', '2026-09-08')], future, today);
  assert.equal(result.available, 0);
});
test('completed, cancelled, different-date and other-meal orders are excluded', () => {
  const orders = [order(), order(recipe(), 1, { status: 'completed' }), order(recipe(), 1, { status: 'cancelled' }), order(recipe(), 1, { meal: '早餐' }), order(recipe(), 1, { date: '2026-09-08' })];
  assert.equal(getRequirements(orders, [], selection, today)[0].quantity, 400);
});
test('enough stock produces zero shortage, never negative', () => {
  assert.equal(getRequirements([order()], [batch('stock', '番茄', 900)], selection, today)[0].missing, 0);
});
test('empty selection does not fabricate shopping data', () => {
  assert.deepEqual(getRequirements([], [], selection, today), []);
});
test('recipe snapshot does not change after source edits', () => {
  const dish = recipe();
  const submitted = makeOrder({ id: 'new', recipes: [dish], cart: { sample: 1 }, member: { id: 'me', name: '我' }, ...selection });
  dish.ingredients[0].quantity = 999;
  assert.equal(submitted.items[0].recipe.ingredients[0].quantity, 400);
  assert.equal(submitted.items[0].quantity, 1);
});
test('invalid or excessive cart quantities are rejected', () => {
  for (const quantity of [0, -1, 2, 21, 1.5, NaN]) assert.throws(() => makeOrder({ id: 'new', recipes: [recipe()], cart: { sample: quantity }, member: { id: 'me', name: '我' }, ...selection }), /选中一次/);
});
test('unknown recipes, empty cart and bad dates fail explicitly', () => {
  const base = { id: 'new', recipes: [recipe()], member: { id: 'me', name: '我' }, ...selection };
  assert.throws(() => makeOrder({ ...base, cart: {} }), /先选/);
  assert.throws(() => makeOrder({ ...base, cart: { missing: 1 } }), /不在家庭菜单/);
  assert.throws(() => makeOrder({ ...base, cart: { sample: 1 }, date: '2026-02-30' }), /有效/);
  assert.throws(() => makeOrder({ ...base, cart: { sample: 1 }, note: '长'.repeat(201) }), /200/);
});
test('completion retains all fridge batches and the source state', () => {
  const state = { orders: [order(recipe(), 1, { status: 'accepted' })], inventory: [batch('later', '番茄', 500, 'g', '2026-09-15'), batch('first', '番茄', 100, 'g', '2026-09-08'), batch('unknown', '番茄', 200)] };
  const result = completeOrder(state, 'order', today);
  assert.equal(result.orders[0].status, 'completed');
  assert.equal(result.inventory.find((stock) => stock.id === 'later').quantity, 500);
  assert.equal(result.inventory.find((stock) => stock.id === 'first').quantity, 100);
  assert.equal(result.inventory.find((stock) => stock.id === 'unknown').quantity, 200);
  assert.equal(state.inventory[1].quantity, 100);
  assert.equal(state.orders[0].status, 'accepted');
});
test('completion leaves kg batches unchanged', () => {
  const result = completeOrder({ orders: [order(recipe(), 1, { status: 'accepted' })], inventory: [batch('stock', '番茄', 0.65, 'kg')] }, 'order', today);
  assert.equal(result.inventory[0].quantity, 0.65);
});
test('only today can complete and rejected dates retain the meal and shopping records', () => {
  for (const status of ['pending', 'accepted']) {
    for (const date of ['2026-09-06', '2026-09-08', '2026-09-09']) {
      const state = {
        orders: [order(recipe(), 1, { date, status, shoppingDrafts: [{ recipeId: 'sample', ingredients: [ingredient('番茄', 400)] }] })],
        inventory: [batch('stock', '番茄', 800)],
        purchases: [{ id: 'purchase', orderIds: ['order', 'another'] }],
      };
      const before = structuredClone(state);
      assert.throws(() => completeOrder(state, 'order', today), /^Error: 只能当天开饭$/);
      assert.deepEqual(state, before);
    }
  }
});
test('a second completion is rejected without altering inventory', () => {
  const result = completeOrder({ orders: [order(recipe(), 1, { status: 'accepted' })], inventory: [batch('stock', '番茄', 800)] }, 'order', today);
  assert.throws(() => completeOrder(result, 'order', today), /不能重复完成/);
  assert.equal(result.inventory[0].quantity, 800);
});
test('shortage does not block completion or change inventory', () => {
  const state = { orders: [order(recipe([ingredient('番茄', 400), ingredient('鸡蛋', 3, '个')]), 1, { status: 'accepted' })], inventory: [batch('tomato', '番茄', 600), batch('eggs', '鸡蛋', 1, '个')] };
  const before = JSON.stringify(state);
  const completed = completeOrder(state, 'order', today);
  assert.equal(completed.orders[0].status, 'completed');
  assert.deepEqual(completed.inventory, state.inventory);
  assert.equal(JSON.stringify(state), before);
});
test('pending meals can skip preparation, while cancelled or completed meals cannot complete', () => {
  assert.equal(completeOrder({ orders: [order()], inventory: [] }, 'order', today).orders[0].status, 'completed');
  for (const status of ['completed', 'cancelled']) assert.throws(() => completeOrder({ orders: [order(recipe(), 1, { status })], inventory: [] }, 'order', today), /不能重复完成/);
});
test('expired batches are preserved but not consumed', () => {
  const state = { orders: [order(recipe(), 1, { status: 'accepted' })], inventory: [batch('bad', '番茄', 800, 'g', '2026-09-01'), batch('good', '番茄', 400)] };
  const result = completeOrder(state, 'order', today);
  assert.deepEqual(result.inventory, state.inventory);
});
test('one completed meal no longer generates shopping requirements', () => {
  const state = { orders: [order(recipe(), 1, { status: 'accepted' })], inventory: [batch('stock', '番茄', 400)] };
  const result = completeOrder(state, 'order', today);
  assert.deepEqual(getRequirements(result.orders, result.inventory, selection, today), []);
});
test('import adds only new sources and repeated import is idempotent', () => {
  const seed = createSeed();
  const first = importCollection(seed.recipes, collections[0]);
  assert.equal(first.length, seed.recipes.length + 1);
  assert.equal(importCollection(first, collections[0]).length, first.length);
  assert.equal(first.at(-1).sourceId, 'tofu');
  assert.equal(seed.recipes.length, 6);
});
test('import deduplicates inside a collection and copies deeply', () => {
  const dish = recipe();
  const result = importCollection([], { author: '作者', recipes: [dish, dish] });
  assert.equal(result.length, 1);
  result[0].ingredients[0].quantity = 500;
  assert.equal(dish.ingredients[0].quantity, 400);
});
test('invalid units and nonfinite or nonpositive quantities are rejected', () => {
  for (const quantity of [0, -1, Infinity, NaN, 100001, 0.0001, '']) assert.throws(() => validateIngredient(ingredient('番茄', quantity)));
  assert.throws(() => validateIngredient(ingredient('', 1)), /名称/);
  assert.throws(() => validateIngredient(ingredient('番茄', 1, '适量')), /单位/);
});
test('recipe editor requires title and ingredients but allows omitted steps', () => {
  assert.throws(() => validateRecipe({ ...recipe(), title: '' }), /菜名/);
  assert.throws(() => validateRecipe({ ...recipe(), ingredients: [] }), /食材/);
  assert.doesNotThrow(() => validateRecipe({ ...recipe(), steps: [] }));
  assert.throws(() => validateRecipe({ ...recipe(), servings: 0 }), /份量/);
});
test('floating point aggregation stays stable', () => {
  const result = aggregateItems([{ recipe: recipe([ingredient('番茄', 0.1, 'kg'), ingredient('西红柿', 0.2, 'kg')]), quantity: 3 }]);
  assert.equal(result[0].quantity, 900);
});
test('local calendar handles leap days and month boundaries', () => {
  assert.equal(validDate('2026-02-29'), false);
  assert.equal(validDate('2028-02-29'), true);
  assert.equal(validDate('2026-2-9'), false);
  assert.equal(localDate(new Date(2026, 8, 7, 0, 1)), today);
  assert.equal(dateOffset(1, new Date(2026, 8, 30, 12)), '2026-10-01');
});
test('expiry hints distinguish absent, expired, today and soon', () => {
  assert.equal(expiryLabel({ expiresOn: '' }, today), '未填写到期日');
  assert.equal(isExpired({ expiresOn: today }, today), false);
  assert.equal(expiryLabel({ expiresOn: today }, today), '今天到期');
  assert.equal(expiryLabel({ expiresOn: '2026-09-09' }, today), '2 天内到期');
  assert.match(expiryLabel({ expiresOn: '2026-09-06' }, today), /已过期/);
});
test('persisted seed is valid and malformed orders are rejected before rendering', () => {
  assert.doesNotThrow(() => validateSnapshot(createSeed()));
  assert.throws(() => validateSnapshot({ ...createSeed(), orders: [null] }), /损坏/);
  assert.throws(() => validateSnapshot({ ...createSeed(), orders: [{ ...order(), memberName: '我', items: [null] }] }), /损坏/);
  assert.throws(() => validateSnapshot({ ...createSeed(), activeMemberId: 'stranger' }), /损坏/);
});
test('invalid ingredient structures fail validation rather than rendering later', () => {
  assert.throws(() => validateIngredient(null), /名称/);
  assert.throws(() => validateRecipe({ ...recipe(), ingredients: null }), /食材/);
  assert.throws(() => validateRecipe({ ...recipe(), steps: [null] }), /做法/);
});
