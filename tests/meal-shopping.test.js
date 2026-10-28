import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeed } from '../src/data/seed.js';
import { createKitchenActions } from '../src/domain/actions.js';
import { dateOffset, kitchenOrders, normalizeSnapshot, validateSnapshot } from '../src/domain/kitchen.js';
import { preparationMeals } from '../src/domain/meal-preparation.js';
import { normalizeShoppingDraft, shoppingCartMeals, shoppingEditSignature, shoppingSourceIngredients, wholeDishShoppingDraft } from '../src/domain/meal-shopping.js';

const today = '2026-10-26';
function fixture() {
  let snapshot = normalizeSnapshot(createSeed());
  snapshot.family.features = { fridge: false, shopping: false };
  snapshot.orders = [];
  snapshot.purchases = [];
  snapshot.recipes.find(recipe => recipe.id === 'tomato').ingredients = [{ name: '番茄', quantity: 300, unit: 'g' }, { name: '盐', quantity: null, unit: '', amountText: '适量' }];
  let sequence = 0;
  const actions = createKitchenActions({ getState: () => snapshot, commit: next => { validateSnapshot(next); snapshot = next; }, newId: prefix => `${prefix}-${++sequence}`, today: () => today, now: () => Date.parse(`${today}T03:00:00Z`) + sequence++ });
  actions.submitOrder({ tomato: 1, broccoli: 1 }, { date: today, meal: '晚餐' });
  const orderId = snapshot.orders[0].id;
  const order = (id = orderId) => snapshot.orders.find(entry => entry.id === id);
  const dish = (recipeId = 'tomato', id = orderId) => preparationMeals(snapshot, today).find(meal => meal.id === id).dishes.find(entry => entry.recipe.id === recipeId);
  const save = (recipeId = 'tomato', id = orderId, indexes = [0]) => actions.saveShoppingDraft(id, recipeId, { ingredients: indexes.map(index => shoppingSourceIngredients(dish(recipeId, id).ingredients)[index]) }, shoppingEditSignature(order(id), recipeId));
  return { actions, orderId, order, dish, save, get snapshot() { return snapshot; } };
}

test('arranging meals never creates an implicit cart and fridge settings do not gate preparation or purchasing', () => {
  const context = fixture();
  assert.equal(preparationMeals(context.snapshot, today)[0].dishes.length, 2);
  assert.deepEqual(shoppingCartMeals(context.snapshot, today), []);
  context.save();
  const [meal] = shoppingCartMeals(context.snapshot, today);
  assert.equal(meal.dishes.length, 1);
  assert.equal(meal.dishes[0].recipe.id, 'tomato');
  assert.deepEqual(meal.dishes[0].purchaseIngredients.map(ingredient => ingredient.name), ['番茄', '盐']);
  assert.equal(meal.dishes[0].prepared, false);
  assert.equal(meal.dishes[0].needsReview, undefined);
});

test('shopping follows enabled preparation materials and keeps disabled rows for later restoration', () => {
  const context = fixture();
  context.save();
  const original = structuredClone(context.dish().ingredients);
  const draft = { ingredients: structuredClone(original), note: '' };
  draft.ingredients[1].enabled = false;
  context.actions.saveDishPreparation(context.orderId, 'tomato', draft, context.dish().editSignature);
  assert.equal(context.dish().ingredients.length, 2);
  assert.deepEqual(shoppingCartMeals(context.snapshot, today)[0].dishes[0].purchaseIngredients.map(ingredient => ingredient.name), ['番茄']);
  const purchase = wholeDishShoppingDraft(context.dish());
  assert.equal(purchase.ingredients.length, 1);
  assert.equal(purchase.ingredients[0].name, '番茄');
  const invalid = { ingredients: shoppingSourceIngredients(original) };
  assert.throws(() => context.actions.saveShoppingDraft(context.orderId, 'tomato', invalid, shoppingEditSignature(context.order(), 'tomato')), /食材已变化/);
  draft.ingredients[0].enabled = false;
  context.actions.saveDishPreparation(context.orderId, 'tomato', draft, context.dish().editSignature);
  assert.deepEqual(shoppingCartMeals(context.snapshot, today), []);
  assert.throws(() => wholeDishShoppingDraft(context.dish()), /没有需要采购/);
  assert.equal(context.order().shoppingDrafts.length, 1);
  context.actions.saveDishPreparation(context.orderId, 'tomato', { ingredients: original, note: '' }, context.dish().editSignature);
  assert.deepEqual(shoppingCartMeals(context.snapshot, today)[0].dishes[0].purchaseIngredients.map(ingredient => ingredient.name), ['番茄', '盐']);
});

test('disabled duplicate names keep later material source keys stable', () => {
  const ingredients = [{ name: '盐', quantity: 1, unit: 'g' }, { name: '盐', quantity: 2, unit: 'g' }];
  const original = shoppingSourceIngredients(ingredients);
  ingredients[0].enabled = false;
  const selected = shoppingSourceIngredients(ingredients);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].sourceKey, original[1].sourceKey);
});

test('hiding old kitchen cards never clears or hides explicitly added ingredient packs', () => {
  const context = fixture();
  context.save();
  const before = JSON.stringify(context.snapshot);
  const later = dateOffset(1, today);
  assert.deepEqual(kitchenOrders(context.snapshot.orders, later), []);
  const cart = shoppingCartMeals(context.snapshot, later);
  assert.equal(cart.length, 1);
  assert.equal(cart[0].id, context.orderId);
  assert.equal(cart[0].dishes[0].recipe.id, 'tomato');
  assert.deepEqual(cart[0].dishes[0].purchaseIngredients.map(ingredient => ingredient.name), ['番茄', '盐']);
  assert.equal(JSON.stringify(context.snapshot), before);
});

test('explicit partial selection and purchase quantities never overwrite the recipe or meal preparation quantities', () => {
  const context = fixture();
  const before = structuredClone({ recipes: context.snapshot.recipes, item: context.order().items[0], inventory: context.snapshot.inventory, purchases: context.snapshot.purchases });
  const source = shoppingSourceIngredients(context.dish().ingredients);
  context.actions.saveShoppingDraft(context.orderId, 'tomato', { ingredients: [{ ...source[0], quantity: '520' }] }, shoppingEditSignature(context.order(), 'tomato'));
  const [draft] = context.order().shoppingDrafts;
  assert.equal(draft.ingredients[0].quantity, 520);
  assert.equal(draft.updatedBy, 'me');
  assert.equal(draft.sourceSignature, context.dish().signature);
  assert.deepEqual({ recipes: context.snapshot.recipes, item: context.order().items[0], inventory: context.snapshot.inventory, purchases: context.snapshot.purchases }, before);
  assert.doesNotThrow(() => validateSnapshot(normalizeSnapshot(context.snapshot)));
});

test('same recipe on different meals keeps independent packages, amounts and readiness', () => {
  const context = fixture();
  context.actions.submitOrder({ tomato: 1 }, { date: dateOffset(1, today), meal: '午餐' });
  const tomorrowId = context.snapshot.orders.find(order => order.id !== context.orderId).id;
  context.save();
  context.save('tomato', tomorrowId, [1]);
  assert.deepEqual(shoppingCartMeals(context.snapshot, today).map(meal => meal.dishes[0].purchaseIngredients.map(ingredient => ingredient.name)), [['番茄', '盐'], ['番茄', '盐']]);
  context.actions.setDishPrepared(context.orderId, 'tomato', true, context.dish().signature);
  assert.deepEqual(shoppingCartMeals(context.snapshot, today).map(meal => meal.id), [tomorrowId]);
  assert.equal(context.dish('tomato', tomorrowId).prepared, false);
});

test('saving an existing package replaces it once and rejects stale writers', () => {
  const context = fixture();
  const initial = shoppingEditSignature(context.order(), 'tomato');
  context.save();
  const before = structuredClone(context.snapshot);
  const draft = { ingredients: shoppingSourceIngredients(context.dish().ingredients) };
  assert.throws(() => context.actions.saveShoppingDraft(context.orderId, 'tomato', draft, initial), { code: 'CONFLICT' });
  assert.deepEqual(context.snapshot, before);
  context.actions.saveShoppingDraft(context.orderId, 'tomato', draft, shoppingEditSignature(context.order(), 'tomato'));
  assert.equal(context.order().shoppingDrafts.length, 1);
  assert.equal(context.order().shoppingDrafts[0].ingredients.length, 2);
});

test('prepared clears only that dish package, undo never silently re-adds it', () => {
  const context = fixture();
  context.save(); context.save('broccoli');
  const before = structuredClone(context.snapshot.inventory);
  context.actions.setDishPrepared(context.orderId, 'tomato', true, context.dish().signature);
  assert.equal(context.dish().prepared, true);
  assert.deepEqual(context.order().shoppingDrafts.map(draft => draft.recipeId), ['broccoli']);
  assert.equal(context.order().status, 'accepted');
  assert.throws(() => context.save(), /已备齐/);
  context.actions.setDishPrepared(context.orderId, 'tomato', false, context.dish().signature);
  assert.equal(context.dish().prepared, false);
  assert.deepEqual(context.order().shoppingDrafts.map(draft => draft.recipeId), ['broccoli']);
  assert.deepEqual(context.snapshot.inventory, before);
});

test('removing a package does not mark ready or remove the dish from its meal', () => {
  const context = fixture();
  context.save();
  context.actions.removeShoppingDraft(context.orderId, 'tomato', shoppingEditSignature(context.order(), 'tomato'));
  assert.deepEqual(shoppingCartMeals(context.snapshot, today), []);
  assert.equal(context.order().items.length, 2);
  assert.equal(context.dish().prepared, false);
});

test('whole packages follow saved meal amounts while the original recipe and legacy draft stay untouched', () => {
  const context = fixture(); context.save();
  const previous = structuredClone(context.order().shoppingDrafts[0]);
  const dish = context.dish();
  const ingredients = structuredClone(dish.ingredients); ingredients[0].quantity = 800;
  context.actions.saveDishPreparation(context.orderId, 'tomato', { ingredients, note: '' }, dish.editSignature);
  const packageDish = shoppingCartMeals(context.snapshot, today)[0].dishes[0];
  assert.equal(packageDish.needsReview, undefined);
  assert.equal(packageDish.purchaseIngredients[0].quantity, 800);
  assert.equal(packageDish.purchaseIngredients.length, ingredients.length);
  assert.deepEqual(context.order().shoppingDrafts[0], previous);
  context.actions.saveShoppingDraft(context.orderId, 'tomato', { ingredients: previous.ingredients }, shoppingEditSignature(context.order(), 'tomato'));
  assert.equal(shoppingCartMeals(context.snapshot, today)[0].dishes[0].purchaseIngredients[0].quantity, 800);
  assert.equal(context.dish().ingredients[0].quantity, 800);
  assert.equal(context.snapshot.recipes.find(recipe => recipe.id === 'tomato').ingredients[0].quantity, 300);
});

test('renamed or removed ingredient sources cannot be silently purchased from stale drafts', () => {
  const context = fixture(); context.save();
  const previous = structuredClone(context.order().shoppingDrafts[0]);
  context.actions.saveDishPreparation(context.orderId, 'tomato', { ingredients: [{ name: '鸡蛋', quantity: 2, unit: '个' }], note: '' }, context.dish().editSignature);
  assert.throws(() => context.actions.saveShoppingDraft(context.orderId, 'tomato', previous, shoppingEditSignature(context.order(), 'tomato')), { code: 'CONFLICT' });
  assert.deepEqual(shoppingCartMeals(context.snapshot, today)[0].dishes[0].purchaseIngredients.map(ingredient => ingredient.name), ['鸡蛋']);
  context.save();
  assert.equal(context.order().shoppingDrafts[0].ingredients[0].name, '鸡蛋');
});

test('whole-package requests contain all current materials, preserve free-text amounts and use stable source keys', () => {
  const context = fixture();
  const before = structuredClone(context.snapshot);
  const draft = wholeDishShoppingDraft(context.dish());
  assert.deepEqual(draft.ingredients, shoppingSourceIngredients(context.dish().ingredients));
  assert.equal(draft.ingredients[1].amountText, '适量');
  assert.deepEqual(context.snapshot, before);
  assert.throws(() => wholeDishShoppingDraft({ ingredients: [] }), /补充食材/);
});

for (const action of ['completed', 'cancelled', 'deleted']) {
  test(`${action} removes only its pending packages, without touching fridge or requiring prepared flags`, () => {
    const context = fixture(); context.save();
    context.actions.submitOrder({ tomato: 1 }, { date: dateOffset(1, today), meal: '午餐' });
    const otherId = context.snapshot.orders.find(order => order.id !== context.orderId).id;
    context.save('tomato', otherId);
    const inventory = structuredClone(context.snapshot.inventory);
    if (action === 'deleted') context.actions.removeOrder(context.orderId);
    else context.actions.updateOrder(context.orderId, action);
    assert.deepEqual(shoppingCartMeals(context.snapshot, today).map(meal => meal.id), [otherId]);
    assert.deepEqual(context.snapshot.inventory, inventory);
    if (context.order()) assert.deepEqual(context.order().shoppingDrafts, []);
    if (action === 'cancelled') { context.actions.updateOrder(context.orderId, 'accepted'); assert.deepEqual(context.order().shoppingDrafts, []); }
  });
}

test('withdrawal of the last selection or removal of one dish clears only affected packages', () => {
  const context = fixture(); context.save(); context.save('broccoli');
  context.actions.submitOrder({ broccoli: 1 }, { date: today, meal: '晚餐' });
  assert.deepEqual(context.order().shoppingDrafts.map(draft => draft.recipeId), ['broccoli']);
  context.actions.submitOrder({}, { date: today, meal: '晚餐' });
  assert.equal(context.order().status, 'cancelled');
  assert.deepEqual(context.order().shoppingDrafts, []);
});

test('unfinished packages remain accessible at date rollover, but old legacy purchase records never become new packages', () => {
  const context = fixture(); context.save();
  context.snapshot.purchases.push({ id: 'old-purchase', name: '番茄', quantity: 900, unit: 'g', orderIds: [context.orderId] });
  const later = dateOffset(8, today);
  assert.equal(shoppingCartMeals(context.snapshot, later).length, 1);
  assert.equal(shoppingCartMeals(context.snapshot, later)[0].dishes.length, 1);
  context.actions.removeShoppingDraft(context.orderId, 'tomato', shoppingEditSignature(context.order(), 'tomato'));
  assert.deepEqual(shoppingCartMeals(context.snapshot, later), []);
  assert.equal(context.snapshot.purchases.length, 1);
});

test('source keys distinguish repeated names without requiring a product or merchant ID', () => {
  const source = shoppingSourceIngredients([{ name: ' 盐 ', quantity: 1, unit: 'g' }, { name: '盐', quantity: 2, unit: 'g' }]);
  assert.equal(new Set(source.map(item => item.sourceKey)).size, 2);
  assert.deepEqual(normalizeShoppingDraft({ ingredients: source }).ingredients.map(item => item.name), ['盐', '盐']);
});

test('invalid quantities, duplicate or forged source keys and empty packages fail atomically', () => {
  const context = fixture();
  const source = shoppingSourceIngredients(context.dish().ingredients)[0];
  const cases = [[], [source, source], [{ ...source, quantity: null }], [{ ...source, quantity: false }], [{ ...source, quantity: -1 }], [{ ...source, quantity: 'abc' }], [{ ...source, quantity: 100001 }], [{ ...source, quantity: .0001 }], [{ ...source, unit: '桶' }], [{ ...source, sourceKey: 'forged' }], [{ ...source, name: '牛肉' }], [{ ...source, amountText: '适量' }], [{ ...source, quantity: null, unit: '', amountText: '' }]];
  const before = structuredClone(context.snapshot);
  for (const ingredients of cases) {
    assert.throws(() => context.actions.saveShoppingDraft(context.orderId, 'tomato', { ingredients }, shoppingEditSignature(context.order(), 'tomato')));
    assert.deepEqual(context.snapshot, before);
  }
});

test('closed orders and removed recipes reject shopping writes with no state changes', () => {
  for (const status of ['completed', 'cancelled']) {
    const context = fixture();
    const signature = shoppingEditSignature(context.order(), 'tomato');
    const draft = { ingredients: shoppingSourceIngredients(context.dish().ingredients) };
    context.actions.updateOrder(context.orderId, status);
    const before = structuredClone(context.snapshot);
    assert.throws(() => context.actions.saveShoppingDraft(context.orderId, 'tomato', draft, signature), { code: 'CONFLICT' });
    assert.throws(() => context.actions.removeShoppingDraft(context.orderId, 'tomato', signature), { code: 'CONFLICT' });
    assert.deepEqual(context.snapshot, before);
  }
});

test('snapshot validation rejects malformed package metadata and orphaned dish associations', () => {
  const context = fixture(); context.save();
  for (const corrupt of [draft => { draft.recipeId = 'missing'; }, draft => { draft.ingredients = []; }, draft => { draft.updatedAt = 'invalid'; }, draft => { draft.updatedBy = ''; }, draft => { draft.sourceSignature = ''; }, draft => { draft.ingredients[0].quantity = '300'; }]) {
    const next = structuredClone(context.snapshot);
    corrupt(next.orders[0].shoppingDrafts[0]);
    assert.throws(() => validateSnapshot(next));
  }
});
