import test from 'node:test';
import assert from 'node:assert/strict';
import { createKitchenActions } from '../src/domain/actions.js';
import { createSeed } from '../src/data/seed.js';
import { kitchenOrders, normalizeSnapshot } from '../src/domain/kitchen.js';

const today = '2026-10-23';
const selection = { date: today, meal: '晚餐' };

function fixture() {
  let state = { ...createSeed(), orders: [], purchases: [] };
  let instant = Date.parse('2026-10-23T02:00:00Z');
  let sequence = 0;
  const actions = createKitchenActions({ getState: () => state, commit: next => { state = next; }, newId: prefix => `${prefix}-${++sequence}`, today: () => today, now: () => instant });
  const cart = { [state.recipes[0].id]: 1 };
  actions.submitOrder(cart, selection);
  const orderId = state.orders[0].id;
  return { actions, cart, orderId, state: () => state, setTime: value => { instant = Date.parse(value); } };
}

for (const status of ['completed', 'cancelled']) {
  test(`${status} records the operation clock, persists it and never rewrites it on repeated ending`, () => {
    const kitchen = fixture();
    const before = structuredClone(kitchen.state());
    const instant = '2026-10-23T03:20:00.000Z';
    const field = status === 'completed' ? 'completedAt' : 'cancelledAt';
    kitchen.setTime(instant);
    kitchen.actions.updateOrder(kitchen.orderId, status);
    assert.equal(kitchen.state().orders[0][field], instant);
    assert.equal(before.orders[0][field], undefined);
    assert.equal(normalizeSnapshot(JSON.parse(JSON.stringify(kitchen.state()))).orders[0][field], instant);
    const finished = structuredClone(kitchen.state());
    kitchen.setTime('2026-10-23T04:00:00Z');
    assert.throws(() => kitchen.actions.updateOrder(kitchen.orderId, status), /状态已变化/);
    assert.deepEqual(kitchen.state(), finished);
  });
}

test('withdrawing the final meal selection records the cancellation time', () => {
  const kitchen = fixture();
  kitchen.setTime('2026-10-23T04:10:00Z');
  kitchen.actions.submitOrder({}, selection);
  assert.equal(kitchen.state().orders[0].status, 'cancelled');
  assert.equal(kitchen.state().orders[0].cancelledAt, '2026-10-23T04:10:00.000Z');
});

test('withdrawing one member does not mark a still-active shared meal as finished', () => {
  const kitchen = fixture();
  const firstMember = kitchen.state().activeMemberId;
  const secondMember = kitchen.state().family.members.find(member => member.id !== firstMember);
  kitchen.state().activeMemberId = secondMember.id;
  kitchen.actions.submitOrder(kitchen.cart, selection);
  kitchen.state().activeMemberId = firstMember;
  kitchen.actions.submitOrder({}, selection);
  assert.equal(kitchen.state().orders[0].status, 'accepted');
  assert.equal(kitchen.state().orders[0].cancelledAt, undefined);
  assert.equal(kitchen.state().orders[0].selections.length, 1);
});

test('restoration re-enters chronological preparation and the next ending uses its latest operation time', () => {
  const kitchen = fixture();
  kitchen.actions.updateOrder(kitchen.orderId, 'cancelled');
  const firstCancellation = kitchen.state().orders[0].cancelledAt;
  kitchen.actions.submitOrder(kitchen.cart, { date: '2026-10-24', meal: '早餐' });
  const tomorrowId = kitchen.state().orders[0].id;
  assert.deepEqual(kitchenOrders(kitchen.state().orders, today).map(order => order.id), [tomorrowId, kitchen.orderId]);
  kitchen.setTime('2026-10-23T03:00:00Z');
  kitchen.actions.updateOrder(kitchen.orderId, 'accepted');
  assert.deepEqual(kitchenOrders(kitchen.state().orders, today).map(order => order.id), [kitchen.orderId, tomorrowId]);
  assert.equal(kitchen.state().orders.find(order => order.id === kitchen.orderId).cancelledAt, firstCancellation);
  kitchen.setTime('2026-10-23T04:00:00Z');
  assert.throws(() => kitchen.actions.updateOrder(tomorrowId, 'completed'), /只能当天开饭/);
  kitchen.actions.updateOrder(tomorrowId, 'cancelled');
  kitchen.setTime('2026-10-23T05:00:00Z');
  kitchen.actions.updateOrder(kitchen.orderId, 'cancelled');
  assert.equal(kitchen.state().orders.find(order => order.id === kitchen.orderId).cancelledAt, '2026-10-23T05:00:00.000Z');
  assert.deepEqual(kitchenOrders(kitchen.state().orders, today).map(order => order.id), [kitchen.orderId, tomorrowId]);
  kitchen.actions.updateOrder(kitchen.orderId, 'accepted');
  kitchen.setTime('2026-10-23T06:00:00Z');
  kitchen.actions.updateOrder(kitchen.orderId, 'completed');
  assert.equal(kitchen.state().orders.find(order => order.id === kitchen.orderId).completedAt, '2026-10-23T06:00:00.000Z');
});

test('finished sorting uses the matching status timestamp rather than a different state, creation or edit time', () => {
  const orders = [
    { id: 'cancelled', ...selection, status: 'cancelled', cancelledAt: '2026-10-23T10:00:00+08:00', completedAt: '2026-10-23T12:00:00Z', updatedAt: '2026-10-23T13:00:00Z' },
    { id: 'completed', ...selection, status: 'completed', completedAt: Date.parse('2026-10-23T03:00:00Z'), cancelledAt: '2026-10-23T01:00:00Z', createdAt: '2026-10-23T00:00:00Z' },
  ];
  assert.deepEqual(kitchenOrders(orders, today).map(order => order.id), ['completed', 'cancelled']);
});

test('legacy missing or invalid times remain stably at the end without invented completion times', () => {
  const orders = [
    { id: 'legacy-cancelled', ...selection, status: 'cancelled', createdAt: '2026-10-23T09:00:00Z', updatedAt: '2026-10-23T12:00:00Z' },
    { id: 'known-completed', ...selection, status: 'completed', completedAt: '2026-10-23T03:00:00Z' },
    { id: 'legacy-completed', ...selection, status: 'completed', completedAt: 'invalid' },
    { id: 'known-cancelled', ...selection, status: 'cancelled', cancelledAt: '2026-10-23T03:00:00Z' },
    { id: 'null-time', ...selection, status: 'cancelled', cancelledAt: null },
    { id: 'later-active', ...selection, status: 'accepted', date: '2026-10-25' },
    { id: 'same-slot-first', ...selection, status: 'pending' },
    { id: 'same-slot-second', ...selection, status: 'accepted' },
  ];
  const before = structuredClone(orders);
  assert.deepEqual(kitchenOrders(orders, today).map(order => order.id), ['same-slot-first', 'same-slot-second', 'later-active', 'known-completed', 'known-cancelled', 'legacy-cancelled', 'legacy-completed', 'null-time']);
  assert.deepEqual(orders, before);
});
