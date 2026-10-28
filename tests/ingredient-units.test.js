import test from 'node:test';
import assert from 'node:assert/strict';
import { UNITS, SELECTABLE_UNITS, validateIngredient, normalizedIngredient, purchaseQuantity, aggregateItems, getShoppingRequirements, completeOrder } from '../src/domain/kitchen.js';
import { createSeed } from '../src/data/seed.js';
import { normalizeCommand } from '../server/validation.mjs';

test('unit choices omit only the three retired spoon labels while keeping stored values supported', () => {
  assert.deepEqual(UNITS.filter(unit => !SELECTABLE_UNITS.includes(unit)), ['小勺', '大勺', '铲勺']);
  assert.deepEqual(SELECTABLE_UNITS, UNITS.filter(unit => !['小勺', '大勺', '铲勺'].includes(unit)));
  for (const unit of ['勺', '茶匙', '汤匙']) assert.ok(SELECTABLE_UNITS.includes(unit));
  assert.equal(new Set(SELECTABLE_UNITS).size, SELECTABLE_UNITS.length);
});

test('all shared units work for recipes, stock and purchases without accepting editor mode labels', () => {
  assert.equal(new Set(UNITS).size, UNITS.length);
  for (const unit of ['瓶', '罐', '包', '块', '片', '瓣', '颗', '粒', '朵', '棵', '把', '束', '条', '勺', '茶匙', '汤匙', '杯', '碗', '斤', '两']) assert.ok(UNITS.includes(unit));
  for (const unit of UNITS) {
    const ingredient = { name: '食材', quantity: 0.5, unit };
    const recipe = { ...createSeed().recipes[0], ingredients: [ingredient] };
    assert.doesNotThrow(() => validateIngredient(ingredient));
    assert.deepEqual(normalizeCommand('saveRecipe', [recipe])[0].ingredients, [ingredient]);
    assert.equal(normalizeCommand('addStock', [{ ...ingredient, image: '', location: '常温', expiresOn: '' }])[0].unit, unit);
    assert.equal(normalizeCommand('recordPurchase', [ingredient])[0].unit, unit);
  }
  for (const unit of ['适量', '少许', '自定义', '文字', 'unknown']) assert.throws(() => validateIngredient({ name: '盐', quantity: 1, unit }));
});

test('packaged and household measures round purchases up and never assume a package size', () => {
  for (const unit of UNITS.filter(unit => !['g', 'kg', '斤', '两', 'ml', 'L'].includes(unit))) {
    assert.equal(purchaseQuantity(0.5, unit), 1);
    assert.equal(purchaseQuantity(1.2, unit), 2);
    assert.equal(purchaseQuantity(0, unit), 0);
    assert.equal(purchaseQuantity(1.0000001, unit), 1);
    assert.equal(normalizedIngredient({ name: '原料', quantity: 0.5, unit }).factor, 1);
  }
  const dish = { ...createSeed().recipes[0], ingredients: [{ name: '牛奶', quantity: 0.5, unit: '瓶' }, { name: '牛奶', quantity: 100, unit: 'ml' }] };
  const rows = aggregateItems([{ recipe: dish, quantity: 1 }]);
  assert.deepEqual(rows.map(row => [row.unit, row.quantity]), [['瓶', 0.5], ['ml', 100]]);
});

test('mainland 斤 and 两 convert consistently to grams without changing recipe amounts', () => {
  const amounts = [{ name: '米', quantity: 0.5, unit: '斤' }, { name: '米', quantity: 2, unit: '两' }, { name: '米', quantity: 0.1, unit: 'kg' }];
  const dish = { ...createSeed().recipes[0], ingredients: amounts };
  assert.equal(aggregateItems([{ recipe: dish, quantity: 1 }])[0].quantity, 450);
  assert.equal(purchaseQuantity(0.501, '斤'), 0.502);
  assert.equal(purchaseQuantity(0.11, '两'), 0.12);
  assert.equal(purchaseQuantity(0.2505, 'kg'), 0.251);
  assert.deepEqual(dish.ingredients, amounts);
});

test('new units stay separate and completion does not change stock', () => {
  const today = '2026-09-11';
  const state = createSeed();
  const recipe = { ...state.recipes[0], ingredients: [{ name: '啤酒', quantity: 0.5, unit: '瓶' }, { name: '米', quantity: 0.5, unit: '斤' }] };
  state.family.features = { fridge: true, shopping: true };
  state.purchases = [];
  state.orders = [{ id: 'test-order', date: today, meal: '晚餐', status: 'accepted', items: [{ recipe, quantity: 1 }] }];
  state.inventory = [
    { id: 'beer', name: '啤酒', quantity: 1, unit: '瓶', location: '常温', expiresOn: '' },
    { id: 'rice', name: '米', quantity: 0.4, unit: 'kg', location: '常温', expiresOn: '' },
  ];
  assert.ok(getShoppingRequirements(state, today).every(row => row.toBuy === 0));
  const completed = completeOrder(state, 'test-order', today);
  assert.equal(completed.inventory.find(item => item.id === 'beer').quantity, 1);
  assert.equal(completed.inventory.find(item => item.id === 'rice').quantity, 0.4);
  state.inventory = [];
  const missing = getShoppingRequirements(state, today);
  assert.equal(missing.find(item => item.name === '啤酒').toBuy, 1);
  assert.equal(missing.find(item => item.name === '米').toBuy, 250);
});
