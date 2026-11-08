import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import * as kitchen from '../src/domain/kitchen.js';
import * as catalog from '../src/domain/ingredient-catalog.js';
import { stockReminder } from '../src/domain/stock-reminders.js';
import { presentMutation } from '../src/services/mutation-feedback.js';
const source = readFileSync(new URL('../src/components/StockAmountSheet.vue', import.meta.url), 'utf8');
const script = compileScript(parse(source).descriptor, { id: 'stock-amount-test' });
const code = script.content.replace(/import (\{[^}]+\}|\w+) from '[^']+';/g, (_, binding) => `const ${binding} = ${binding.startsWith('{') ? 'modules' : '{}'};`).replace('export default', 'return');
function mount(context, overrides = {}) {
  const calls = [], events = []; const scope = Vue.effectScope(); context.after(() => scope.stop());
  const component = new Function('modules', code)({ ...Vue, ...kitchen, ...catalog, stockReminder, presentMutation, addStock: async draft => calls.push(draft), ...overrides });
  const api = scope.run(() => component.setup({entry: catalog.COMMON_INGREDIENTS[0]}, { expose() {}, emit: (...args) => events.push(args) }));
  return {api, calls, events};
}
test('opening amount dialog is read only; confirmation saves edited quantity and reminder', async context => {
  const {api, calls, events} = mount(context); assert.deepEqual(calls, []);
  api.draft.value.quantity = 125; await api.save();
  assert.equal(calls[0].quantity, 125); assert.ok(kitchen.validDate(calls[0].expiresOn)); assert.deepEqual(events, [['saved']]);
  await api.save(); assert.equal(calls.length, 1);
});
test('invalid quantities do not write inventory', async context => {
  const {api, calls} = mount(context);
  for (const value of [0, -1, '', 'abc']) { api.draft.value.quantity = value; await api.save(); }
  assert.deepEqual(calls, []);
});
test('location recomputes defaults until user edits reminder', async context => {
  const {api} = mount(context); api.draft.value.location = '冷冻'; await Vue.nextTick();
  assert.equal(api.draft.value.expiresOn, stockReminder(catalog.COMMON_INGREDIENTS[0], '冷冻').date);
  api.setDate('2027-03-01'); api.draft.value.location = '冷藏'; await Vue.nextTick();
  assert.equal(api.draft.value.expiresOn, '2027-03-01');
});
test('pending add blocks duplicates; failures preserve draft and allow retry', async context => {
  let reject, count = 0;
  const {api, events} = mount(context, {addStock: () => {count++; return new Promise((_, fail) => {reject = fail;});}});
  const first = api.save(); await api.save(); api.close(); assert.equal(count, 1); assert.deepEqual(events, []);
  reject(new Error('网络暂不可用')); await first; assert.equal(api.error.value, '网络暂不可用');
  const retry = api.save(); assert.equal(count, 2); reject(new Error('失败')); await retry;
});
test('all directory entries have finite editable reminders and valid future calendar dates', () => {
  assert.equal(new Set(catalog.COMMON_INGREDIENTS.map(e => e.name)).size, catalog.COMMON_INGREDIENTS.length);
  for (const entry of catalog.COMMON_INGREDIENTS) for (const place of kitchen.STOCK_LOCATIONS) {
    const reminder = stockReminder(entry, place, '2026-12-31');
    assert.ok(Number.isFinite(reminder.days)); assert.ok(kitchen.validDate(reminder.date));
    assert.ok(reminder.date >= '2026-12-31');
  }
  assert.equal(stockReminder(null, '冷藏', '2028-02-28').date, '2028-02-29');
});
