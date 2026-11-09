import test from 'node:test';
import assert from 'node:assert/strict';
import { mealCutoffAt, mealIsDue, assertMealBeforeCutoff, chinaMealDate, mealArchiveWindow } from '../src/domain/meal-cutoff.js';
import { checkoutPresentation } from '../src/domain/checkout.js';
import { orderStatusLabel } from '../src/domain/order-record-state.js';
for (const [meal, hour] of [['早餐', 10], ['午餐', 14], ['晚餐', 20], ['加餐', 24], ['宵夜', 24]]) {
  test(`${meal} cutoff uses Beijing time, inclusive exact boundary`, () => {
    const order = { date: '2026-11-10', meal };
    const boundary = Date.parse('2026-11-10T00:00:00+08:00') + hour * 3600000;
    assert.equal(mealCutoffAt(order), boundary);
    assert.equal(mealIsDue(order, boundary - 1), false);
    assert.doesNotThrow(() => assertMealBeforeCutoff(order, boundary - 1));
    assert.throws(() => assertMealBeforeCutoff(order, boundary), { code: 'INVALID' });
    assert.equal(mealIsDue({ ...order, date: '2026-11-11' }, boundary), false);
    assert.notEqual(mealArchiveWindow(boundary), mealArchiveWindow(boundary - 1));
  });
}
test('invalid dates never archive and UTC date does not shift the China meal day', () => {
  assert.equal(mealIsDue({ date: '2026-02-31', meal: '早餐' }), false);
  assert.equal(mealIsDue({ date: '2026-11-10', meal: 'unknown' }), false);
  assert.equal(chinaMealDate(Date.parse('2026-11-09T16:00:00Z')), '2026-11-10');
});
test('expired selection stays on confirm with a warning; automatic record has recorded label', () => {
  assert.deepEqual(checkoutPresentation({ dishCount: 1, cutoffMessage: '早餐安排已截止' }), { action: 'expired', label: '确认安排', tip: '早餐安排已截止', warning: true });
  assert.equal(orderStatusLabel({ status: 'accepted', autoArchivedAt: 1, mealPostId: 'meal-1' }), '已记录');
});
