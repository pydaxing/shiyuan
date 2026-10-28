import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeed } from '../src/data/seed.js';
import { normalizeSnapshot, makeOrder, getShoppingRequirements, completeOrder, shoppingOrders } from '../src/domain/kitchen.js';

test('shopping follows the same three days as the kitchen, not forgotten historical orders', () => {
  const state = normalizeSnapshot(createSeed());
  state.family.features.fridge = false;
  state.orders = ['2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12'].map((date) => makeOrder({ id: date, recipes: state.recipes, cart: { tomato: 1 }, member: state.family.members[0], date, meal: '晚餐' }));
  assert.deepEqual(shoppingOrders(state.orders, '2026-09-09').map(order => order.id), ['2026-09-09', '2026-09-10', '2026-09-11']);
  assert.equal(getShoppingRequirements(state, '2026-09-09').find(item => item.name === '番茄').quantity, 1200);
  state.orders.forEach(order => { if (order.date >= '2026-09-09' && order.date <= '2026-09-11') order.status = 'cancelled'; });
  assert.deepEqual(getShoppingRequirements(state, '2026-09-09'), []);
  assert.equal(state.orders.length, 5);
});

test('cooking without fridge or any purchase removes the meal from shopping and keeps the diary', () => {
  const state = normalizeSnapshot(createSeed());
  state.family.features.fridge = false;
  state.orders = [makeOrder({ id: 'dinner', recipes: state.recipes, cart: { tomato: 1 }, member: state.family.members[0], date: '2026-09-09', meal: '晚餐' })];
  state.orders[0].status = 'accepted';
  const cooked = completeOrder(state, 'dinner', '2026-09-09');
  assert.deepEqual(getShoppingRequirements(cooked, '2026-09-09'), []);
  assert.equal(cooked.orders[0].status, 'completed');
  assert.ok(cooked.orders[0].completedAt);
});

test('unbought requirements expire from shopping across month and year boundaries', () => {
  const state = normalizeSnapshot(createSeed());
  state.family.features.fridge = false;
  state.orders = [makeOrder({ id: 'old', recipes: state.recipes, cart: { tomato: 1 }, member: state.family.members[0], date: '2026-12-31', meal: '宵夜' })];
  assert.ok(getShoppingRequirements(state, '2026-12-31').length);
  assert.deepEqual(getShoppingRequirements(state, '2027-01-01'), []);
  assert.equal(state.orders[0].status, 'accepted');
});
