import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { computed, ref, reactive, watch, effectScope, nextTick } from 'vue';
import { mealDateLabel, reservationDays } from '../src/domain/kitchen.js';
import { mealAdditionOptions, mealAdditionCart, mealAdditionCount } from '../src/domain/meal-additions.js';

const source = readFileSync(new URL('../src/components/AddDishesSheet.vue', import.meta.url), 'utf8');
const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;$/gm, '');
function fixture() {
  const scope = effectScope();
  const props = reactive({ order: { id: 'dinner', status: 'pending', date: '2026-10-20', meal: '晚餐', items: [], selections: [{ memberId: 'me', items: [{ recipe: { id: 'rice' } }] }] }, memberId: 'me', entries: [{ key: 'rice', title: '米饭', label: '主食', recipes: [{ id: 'rice' }] }, { key: 'dish', title: '青菜', label: '素菜', recipes: [{ id: 'dish' }] }], today: '2026-10-20', saving: false, error: '' });
  const events = [];
  let keyboardDismissals = 0;
  const component = scope.run(() => runInNewContext(`${script}\n;({ sheet, selected, search, options, cart, count, filtered, locked, notice, toggle, save, clearSearch });`, { computed, ref, watch, mealDateLabel, reservationDays, mealAdditionOptions, mealAdditionCart, mealAdditionCount, dismissFocusedKeyboard: () => { keyboardDismissals += 1; }, defineProps: () => props, defineEmits: () => (...args) => events.push(args) }));
  return { ...component, props, events, keyboardDismissals: () => keyboardDismissals, stop: () => scope.stop() };
}

test('add sheet searches names/categories and submits only new picks, not an order replacement', () => {
  const current = fixture();
  current.toggle(current.options.value[0]); assert.equal(current.count.value, 0);
  current.search.value = '素菜'; assert.equal(current.filtered.value[0].key, 'dish');
  current.toggle(current.filtered.value[0]); assert.equal(current.count.value, 1);
  current.save();
  assert.deepEqual(JSON.parse(JSON.stringify(current.events)), [['save', { dish: 1 }]]);
  assert.equal(current.props.order.selections[0].items.length, 1);
  assert.doesNotMatch(source, /useMealDraft|mealDraft\.|submitOrder/);
  current.stop();
});

test('failed save keeps picks, saving blocks duplicate submit, and preparing still allows additions', () => {
  const current = fixture();
  current.toggle(current.options.value[1]);
  current.props.error = '网络不稳定';
  assert.equal(current.count.value, 1);
  current.props.saving = true; current.save(); current.toggle(current.options.value[1]);
  assert.equal(current.events.length, 0); assert.equal(current.count.value, 1);
  current.props.saving = false;
  current.props.order.status = 'accepted';
  assert.equal(current.locked.value, false); assert.equal(current.notice.value, '');
  current.save(); assert.equal(current.events.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(current.events)), [['save', { dish: 1 }]]);
  current.props.order.status = 'completed';
  current.save(); assert.equal(current.events.length, 1);
  assert.equal(current.locked.value, true); assert.match(current.notice.value, /已结束/);
  current.stop();
});

test('member/meal changes clear isolated picks, deleted menu choices are pruned and expired slots lock', async () => {
  const current = fixture();
  current.toggle(current.options.value[1]);
  current.props.memberId = 'partner'; await nextTick();
  assert.equal(current.count.value, 0);
  current.toggle(current.options.value[1]);
  current.props.entries = current.props.entries.slice(0, 1);
  assert.equal(current.count.value, 0);
  current.props.today = '2026-10-21';
  assert.equal(current.locked.value, true);
  current.props.order = undefined; await nextTick();
  assert.equal(current.locked.value, true);
  current.stop();
});

test('available add-dishes sheet omits the explanatory lines and their empty spacing', () => {
  const current = fixture();
  assert.equal(current.locked.value, false);
  assert.equal(current.notice.value, '');
  assert.match(source, /<text v-if="notice" class="meal-addition-notice" role="status">/);
  assert.doesNotMatch(source, /仅记录选菜|不生成采购清单或扣减库存|家人点过的菜|同一道菜只做一份|加菜后自动更新采购|做好时按这餐|meal-addition-hint|props\.features/);
  assert.match(source, /v-if="error" class="error-message" role="alert"/);
  current.stop();
});

test('searching, empty results and clearing restore the list immediately without changing selected dishes', async () => {
  const current = fixture();
  const resets = [];
  current.sheet.value = { resetScroll: options => resets.push(options) };
  current.toggle(current.options.value[1]);
  current.search.value = '  素菜  ';
  await nextTick();
  assert.equal(current.filtered.value.length, 1);
  current.search.value = '没有匹配的菜';
  await nextTick();
  assert.equal(current.filtered.value.length, 0);
  assert.equal(current.count.value, 1);
  assert.equal(current.keyboardDismissals(), 0);
  current.clearSearch();
  assert.equal(current.search.value, '');
  assert.equal(current.filtered.value.length, 2);
  assert.equal(current.count.value, 1);
  assert.equal(current.keyboardDismissals(), 1);
  await nextTick();
  assert.deepEqual(JSON.parse(JSON.stringify(resets)), Array.from({ length: 3 }, () => ({ preserveFocus: true })));
  assert.deepEqual(current.events, []);
  current.stop();
});

test('add-dishes uses a stable bounded sheet and an inline empty-result message without extra actions', () => {
  assert.match(source, /<Sheet ref="sheet"[^>]*:preferred-height="640"[^>]*:fit-content="false"/);
  assert.match(source, /watch\(search,[^\n]*preserveFocus: true[^\n]*flush: 'post'/);
  assert.match(source, /class="meal-addition-empty" role="status"/);
  assert.match(source, /没有找到相关菜品或套餐/);
  assert.match(source, /换一换试试/);
  assert.doesNotMatch(source, /:key="search"|:key="filtered|setTimeout|uni\.pageScrollTo/);
});

test('unavailable meals keep actionable warnings and cannot be submitted after the explanations are removed', () => {
  const current = fixture();
  current.toggle(current.options.value[1]);
  for (const status of ['completed', 'cancelled']) {
    current.props.order.status = status;
    assert.equal(current.locked.value, true);
    assert.match(current.notice.value, /请返回厨房查看/);
    current.save();
    assert.equal(current.events.length, 0);
  }
  current.props.order.status = 'pending';
  assert.equal(current.notice.value, '');
  current.props.today = '2026-10-21';
  assert.match(current.notice.value, /不在可点餐日期内/);
  current.save();
  assert.equal(current.events.length, 0);
  current.stop();
});
