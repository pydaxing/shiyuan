import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSeed } from '../src/data/seed.js';
import { createKitchenActions } from '../src/domain/actions.js';
import { aggregateItems, getShoppingRequirements, normalizeSnapshot, validateSnapshot } from '../src/domain/kitchen.js';
import { mealAdditionOptions, mealAdditionCart, mealAdditionCount } from '../src/domain/meal-additions.js';
import { mealVoterRows } from '../src/domain/presentation.js';
import { checkoutPresentation } from '../src/domain/checkout.js';

const today = '2026-10-20';
const slot = { date: today, meal: '晚餐' };
function fixture(features = { fridge: false, shopping: true }) {
  let state = normalizeSnapshot(createSeed());
  let sequence = 0;
  state.orders = []; state.inventory = []; state.purchases = [];
  state.family.features = features;
  state.family.members = [{ id: 'me', name: '我' }, { id: 'partner', name: '家人' }];
  state.activeMemberId = 'me';
  const actions = createKitchenActions({ getState: () => state, commit: next => { validateSnapshot(next); state = next; }, newId: prefix => `${prefix}-${++sequence}`, today: () => today });
  return { get state() { return state; }, actions };
}

test('add dishes preserves previous own picks, notes, other members and one meal identity', () => {
  const context = fixture();
  context.actions.submitOrder({ tomato: 1 }, slot, '少盐');
  const orderId = context.state.orders[0].id;
  context.actions.switchMember('partner');
  context.actions.addOrderDishes(orderId, { tomato: 1, chicken: 1 });
  context.actions.switchMember('me');
  context.actions.addOrderDishes(orderId, { soup: 1 });
  const [order] = context.state.orders;
  assert.equal(context.state.orders.length, 1);
  assert.equal(order.id, orderId);
  assert.equal(order.items.length, 3);
  assert.equal(order.note, '我：少盐');
  assert.deepEqual(order.items.find(item => item.recipe.id === 'tomato').chosenBy.map(member => member.id), ['me', 'partner']);
  assert.deepEqual(order.selections.find(selection => selection.memberId === 'partner').items.map(item => item.recipe.id), ['tomato', 'chicken']);
  assert.equal(aggregateItems(order.items).find(item => item.name === '番茄').quantity, 400);
  const before = structuredClone(order);
  context.actions.addOrderDishes(orderId, { soup: 1 });
  assert.deepEqual(context.state.orders[0], before);
});

test('adding a set and a single dish deduplicates dishes, and preserves removed recipe snapshots', () => {
  const context = fixture();
  context.actions.saveMealSet({ title: '两菜套餐', image: '', recipeIds: ['tomato', 'soup'] });
  const setId = context.state.mealSets[0].id;
  context.actions.submitOrder({ [`set:${setId}`]: 1, tomato: 1 }, slot, '准时吃');
  const orderId = context.state.orders[0].id;
  const original = structuredClone(context.state.orders[0].items[0].recipe);
  context.actions.removeFamilyEntry('tomato');
  context.actions.addOrderDishes(orderId, { chicken: 1 });
  const [order] = context.state.orders;
  assert.equal(order.items.length, 3);
  assert.deepEqual(order.items.find(item => item.recipe.id === 'tomato').recipe, original);
  assert.ok(order.entries.some(entry => entry.id === `set:${setId}`));
  assert.equal(order.note, '我：准时吃');
});

test('adding a changed set extends its snapshot without removing dishes already ordered', () => {
  const context = fixture();
  context.actions.saveMealSet({ title: '套餐', image: '', recipeIds: ['tomato', 'soup'] });
  const mealSet = context.state.mealSets[0];
  context.actions.submitOrder({ [`set:${mealSet.id}`]: 1 }, slot);
  const orderId = context.state.orders[0].id;
  context.actions.saveMealSet({ ...mealSet, recipeIds: ['tomato', 'chicken'] }, mealSet.id);
  context.actions.addOrderDishes(orderId, { [`set:${mealSet.id}`]: 1 });
  const [order] = context.state.orders;
  assert.deepEqual(order.entries[0].recipeIds, ['tomato', 'soup', 'chicken']);
  assert.equal(order.entries[0].dishCount, 3);
  assert.equal(order.items.length, 3);
});

test('new meals start preparing and remain editable until served or cancelled', () => {
  const context = fixture();
  context.actions.submitOrder({ tomato: 1 }, slot, '少盐');
  const orderId = context.state.orders[0].id;
  assert.equal(context.state.orders[0].status, 'accepted');
  const beforeLegacyStart = structuredClone(context.state);
  context.actions.updateOrder(orderId, 'accepted');
  assert.deepEqual(context.state, beforeLegacyStart);
  context.actions.switchMember('partner');
  context.actions.submitOrder({ chicken: 1 }, slot, '保留家人备注');
  context.actions.switchMember('me');
  context.actions.addOrderDishes(orderId, { soup: 1 });
  assert.deepEqual(context.state.orders[0].items.map(item => item.recipe.id), ['tomato', 'soup', 'chicken']);
  context.actions.submitOrder({ soup: 1 }, slot, '改备注');
  assert.equal(context.state.orders[0].note, '我：改备注\n家人：保留家人备注');
  context.actions.submitOrder({}, slot);
  assert.equal(context.state.orders[0].id, orderId);
  assert.equal(context.state.orders[0].status, 'accepted');
  assert.deepEqual(context.state.orders[0].items.map(item => item.recipe.id), ['chicken']);
  assert.equal(context.state.orders[0].note, '家人：保留家人备注');
});

test('legacy pending meals permit adding without migrating or replacing the stored meal', () => {
  const context = fixture();
  context.actions.submitOrder({ tomato: 1 }, slot, '少盐');
  context.state.orders[0].status = 'pending';
  const { id, createdAt } = context.state.orders[0];
  context.actions.addOrderDishes(id, { soup: 1 });
  assert.equal(context.state.orders[0].status, 'pending');
  assert.equal(context.state.orders[0].createdAt, createdAt);
  assert.equal(context.state.orders[0].id, id);
  assert.equal(context.state.orders[0].note, '我：少盐');
  assert.deepEqual(context.state.orders[0].items.map(item => item.recipe.id), ['tomato', 'soup']);
});

test('missing, cancelled, completed and out-of-window meals cannot be recreated by add-dishes', () => {
  const context = fixture();
  assert.throws(() => context.actions.addOrderDishes('missing', { tomato: 1 }), /结束或已取消/);
  context.actions.submitOrder({ tomato: 1 }, slot);
  const orderId = context.state.orders[0].id;
  context.actions.updateOrder(orderId, 'cancelled');
  assert.throws(() => context.actions.addOrderDishes(orderId, { soup: 1 }), /结束或已取消/);
  context.actions.submitOrder({ tomato: 1 }, slot);
  const activeId = context.state.orders[0].id;
  context.actions.updateOrder(activeId, 'accepted');
  context.actions.updateOrder(activeId, 'completed');
  assert.throws(() => context.actions.addOrderDishes(activeId, { soup: 1 }), /结束或已取消/);
  context.state.orders[0].status = 'pending';
  context.state.orders[0].date = '2026-10-19';
  assert.throws(() => context.actions.addOrderDishes(activeId, { soup: 1 }), /今天|日期/);
});

for (const fridge of [false, true]) for (const shopping of [false, true]) {
  test(`add-dishes stock and purchase lifecycle: fridge=${fridge}, shopping=${shopping}`, () => {
    const context = fixture({ fridge, shopping });
    context.state.recipes = context.state.recipes.slice(0, 2).map((recipe, index) => ({ ...recipe, ingredients: [{ name: '番茄', quantity: (index + 1) * 100, unit: 'g' }] }));
    const [first, second] = context.state.recipes;
    context.actions.submitOrder({ [first.id]: 1 }, slot);
    const orderId = context.state.orders[0].id;
    context.state.inventory = [{ id: 'stock', name: '番茄', quantity: 50, unit: 'g', location: '冷藏', expiresOn: '' }];
    if (shopping) context.actions.recordPurchase({ name: '番茄', quantity: 100, unit: 'g', location: '冷藏', expiresOn: '' });
    const supplies = structuredClone({ inventory: context.state.inventory, purchases: context.state.purchases });
    context.actions.addOrderDishes(orderId, { [second.id]: 1 });
    assert.deepEqual({ inventory: context.state.inventory, purchases: context.state.purchases }, supplies);
    const required = getShoppingRequirements(context.state, today).find(item => item.name === '番茄');
    assert.equal(required.quantity, 300);
    assert.equal(required.missing, 300 - (fridge ? 50 : 0) - (shopping ? 100 : 0));
    context.actions.switchMember('partner');
    context.actions.addOrderDishes(orderId, { [second.id]: 1 });
    assert.equal(getShoppingRequirements(context.state, today)[0].quantity, 300);
    context.actions.updateOrder(orderId, 'accepted');
    context.actions.updateOrder(orderId, 'completed');
    assert.equal(context.state.orders[0].status, 'completed');
    assert.equal(context.state.inventory.reduce((sum, batch) => sum + batch.quantity, 0), 50);
    assert.equal(context.state.purchases.length, 0);
    assert.throws(() => context.actions.updateOrder(orderId, 'completed'), /不能重复完成/);
  });
}

test('text-amount confirmation survives another vote but must be renewed when a new dish uses it', () => {
  const context = fixture();
  context.state.recipes = context.state.recipes.slice(0, 2).map(recipe => ({ ...recipe, ingredients: [{ name: '盐', quantity: null, unit: '', amountText: '适量' }] }));
  const [first, second] = context.state.recipes;
  context.actions.submitOrder({ [first.id]: 1 }, slot);
  const orderId = context.state.orders[0].id;
  context.actions.recordPurchase({ kind: 'confirmation', name: '盐', quantity: null, unit: '', amountText: '适量' });
  assert.equal(getShoppingRequirements(context.state, today)[0].needsConfirmation, false);
  const receipts = structuredClone(context.state.purchases);
  context.actions.switchMember('partner');
  context.actions.addOrderDishes(orderId, { [first.id]: 1 });
  assert.equal(getShoppingRequirements(context.state, today)[0].needsConfirmation, false);
  context.actions.addOrderDishes(orderId, { [second.id]: 1 });
  assert.equal(getShoppingRequirements(context.state, today)[0].needsConfirmation, true);
  assert.deepEqual(context.state.purchases, receipts);
});

test('add-dish choices allow other members dishes, disable own dishes and count overlapping sets once', () => {
  const entries = [{ key: 'tomato', title: '番茄炒蛋', recipes: [{ id: 'tomato' }] }, { key: 'soup', recipes: [{ id: 'soup' }] }, { key: 'set:meal', recipes: [{ id: 'tomato' }, { id: 'soup' }, { id: 'chicken' }] }];
  const order = { items: [{ recipe: { id: 'tomato' } }], selections: [{ memberId: 'me', items: [{ recipe: { id: 'soup' } }] }] };
  const options = mealAdditionOptions(entries, order, 'me');
  assert.equal(options[0].alreadySelected, false);
  assert.equal(options[0].inMeal, true);
  assert.equal(options[1].alreadySelected, true);
  const cart = mealAdditionCart({ tomato: 1, soup: 1, 'set:meal': 1, removed: 1 }, options);
  assert.deepEqual(cart, { tomato: 1, 'set:meal': 1 });
  assert.equal(mealAdditionCount(cart, options), 2);
  assert.equal(mealAdditionOptions(entries, order, 'partner')[1].alreadySelected, false);
});

test('order voter data stays intact while kitchen rows omit profile decoration', () => {
  const rows = [{ recipe: { id: 'tomato' }, chosenBy: [{ id: 'me', name: '旧昵称' }, { id: 'me', name: '重复' }, { id: 'gone', name: '离开家人' }, { id: 'blank' }] }];
  const [row] = mealVoterRows(rows, [{ id: 'me', name: '新昵称', avatar: 'cloud://example/avatar.png' }]);
  assert.deepEqual(row.voters.map(member => member.name), ['新昵称', '离开家人', '家人']);
  assert.equal(row.voters[0].avatar, 'cloud://example/avatar.png');
  assert.equal(row.voters[1].avatar, '');
  assert.equal(rows[0].chosenBy.length, 4);
  const source = readFileSync(new URL('../src/components/MealDishList.vue', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /LazyImage|dish-avatars/);
  assert.match(source, /item\.voters\.length \|\| 1/);
  assert.doesNotMatch(source, /:src="members.find|member\.name\.slice/);
});

test('checkout permits additions and own selection edits in both active storage statuses', () => {
  for (const status of ['pending', 'accepted']) {
    assert.equal(checkoutPresentation({ status, hasOrder: true, hasSelection: false, dishCount: 0 }).label, '去加菜');
    const saved = { status, hasOrder: true, hasSelection: true, dirty: false, dishCount: 2 };
    assert.equal(checkoutPresentation(saved).label, '去加菜');
    assert.match(checkoutPresentation(saved).tip, /备菜中也可以继续加菜/);
    assert.equal(checkoutPresentation({ ...saved, dirty: true }).action, 'update');
    assert.equal(checkoutPresentation({ ...saved, dirty: true, dishCount: 0 }).action, 'withdraw');
    assert.equal(checkoutPresentation({ ...saved, hasSelection: false, dirty: true }).action, 'submit');
  }
});
