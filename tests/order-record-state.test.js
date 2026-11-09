import test from 'node:test';
import assert from 'node:assert/strict';
import { withOrderRecordStates } from '../server/order-record-state.mjs';
import { orderStatusLabel } from '../src/domain/order-record-state.js';
import { checkoutPresentation } from '../src/domain/checkout.js';
import { memoryRepository } from './helpers/memory-repository.js';
import { legacyCompletedMealId, orderDiaryParticipants, captureOrderDiaryParticipants } from '../server/meal-auto-archive.mjs';
const today = '2026-11-09', spaceId = 'family';
const order = (id, patch = {}) => ({ id, status: 'completed', date: today, ...patch });

test('canonical records determine display without changing stored order status', async () => {
  const db = memoryRepository();
  await db.set('meal_posts', 'alive', { spaceId, orderId: 'a', status: 'published' });
  await db.set('meal_posts', 'deleted', { spaceId, orderId: 'b', status: 'deleted' });
  await db.set('meal_posts', legacyCompletedMealId(spaceId, 'c'), { spaceId, orderId: 'c', status: 'published' });
  await db.set('meal_posts', 'foreign', { spaceId: 'another', orderId: 'f', status: 'published' });
  await db.set('meal_posts', 'old-unlinked', { spaceId, orderId: 'g', status: 'published' });
  const input = [order('a', { mealPostId: 'alive' }), order('b', { mealPostId: 'deleted' }), order('c'), order('d'), order('e', { diaryDeletedAt: 1 }), order('f', { mealPostId: 'foreign' }), order('g')];
  const before = JSON.stringify(input);
  const output = await withOrderRecordStates(db, spaceId, input, today);
  assert.deepEqual(output.map(orderStatusLabel), ['已记录', '日记已删除', '已记录', '历史已结束', '日记已删除', '历史已结束', '已记录']);
  assert.equal(JSON.stringify(input), before);
  assert.ok(output.every(row => row.status === 'completed'));
});

test('active arrangements do not query diary data and cancelled meals stay cancelled', async () => {
  const input = [order('a', { status: 'pending' }), order('b', { status: 'cancelled' })];
  const result = await withOrderRecordStates({ get() { throw Error('unexpected read'); } }, spaceId, input, today);
  assert.deepEqual(result.map(orderStatusLabel), ['已安排', '已取消']);
});

test('all closed-slot explanations keep confirmation label and block duplicate creation', () => {
  for (const recordLabel of ['已记录', '日记已删除', '历史已结束']) {
    const result = checkoutPresentation({ closed: true, dishCount: 1, recordLabel });
    assert.equal(result.label, '确认安排');
    assert.equal(result.action, 'blocked');
    assert.match(result.tip, new RegExp(recordLabel));
  }
});

test('linked manual and automatic records use the same arrangement membership snapshot', () => {
  const original = { kind: 'family', members: [{ id: 'alice' }, { id: 'bob' }] };
  const captured = captureOrderDiaryParticipants({ memberId: 'alice' }, original, 1);
  const later = { ...original, members: [{ id: 'alice' }, { id: 'carol' }] };
  assert.deepEqual(orderDiaryParticipants(captured, later), ['alice', 'bob']);
  assert.deepEqual(orderDiaryParticipants({ memberId: 'alice', selections: [{ memberId: 'bob' }] }, later), ['alice', 'bob']);
});
