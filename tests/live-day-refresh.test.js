import test from 'node:test';
import assert from 'node:assert/strict';
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue';
import { readFileSync } from 'node:fs';
import { setupSource, componentSource } from './helpers/sfc-setup.js';
import { expiryLabel, isExpired } from '../src/domain/kitchen.js';
import { cookingDays } from '../src/domain/cooking-diary.js';
import { useDiaryScroll } from '../src/composables/useDiaryScroll.js';

test('fridge expiry totals follow the live date without inventory mutations', () => {
  const props = reactive({ embedded: true, today: '2026-10-27' });
  const inventory = [
    { id: 'today', expiresOn: '2026-10-27' },
    { id: 'soon', expiresOn: '2026-10-31' },
    { id: 'undated' },
  ];
  const scope = effectScope();
  try {
    const view = scope.run(() => setupSource('InventoryView', {
      computed, ref, defineProps: () => props, state: ref({ inventory }),
      localDate: () => '2026-10-27', isExpired, expiryLabel,
    }, ['expiring', 'expired']));
    assert.equal(view.expiring.value, 1);
    assert.equal(view.expired.value, 0);
    props.today = '2026-10-28';
    assert.equal(view.expiring.value, 1);
    assert.equal(view.expired.value, 1);
    props.today = '2026-11-01';
    assert.equal(view.expiring.value, 0);
    assert.equal(view.expired.value, 2);
    assert.deepEqual(inventory, [{ id: 'today', expiresOn: '2026-10-27' }, { id: 'soon', expiresOn: '2026-10-31' }, { id: 'undated' }]);
  } finally { scope.stop(); }
});

test('diary today label advances across midnight without moving the selected history', async () => {
  const props = reactive({ today: '2026-12-31', orders: [] });
  const scope = effectScope();
  try {
    const diary = scope.run(() => setupSource('CookingDiary', {
      computed, ref, watch, defineProps: () => props, localDate: () => '2026-12-31',
      cookingDays, useDiaryScroll, getCurrentInstance: () => ({ proxy: {} }), onMounted() {},
    }, ['dateLabel', 'selectedDate', 'selected', 'expanded']));
    assert.equal(diary.dateLabel.value, '今日');
    diary.expanded.value = true;
    props.today = '2027-01-01';
    await nextTick();
    assert.equal(diary.dateLabel.value, '12月31日');
    assert.equal(diary.selectedDate.value, '2026-12-31');
    assert.equal(diary.expanded.value, true);
    diary.selectedDate.value = '2027-01-01';
    await nextTick();
    assert.equal(diary.dateLabel.value, '今日');
    assert.equal(diary.expanded.value, false);
    assert.deepEqual(diary.selected.value.meals, []);
  } finally { scope.stop(); }
});

test('the page clock reaches fridge labels and cooking diary through their parents', () => {
  const page = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8');
  assert.match(page, /<FamilyView\b[^>]*:today="today"/);
  assert.match(componentSource('FamilyView'), /<CookingDiary\b[^>]*:today="today"/);
  assert.match(componentSource('IngredientsView'), /<InventoryView\b[^>]*:today="today"/);
  const inventory = componentSource('InventoryView');
  assert.match(inventory, /expiryLabel\(batch, today\)/);
  assert.doesNotMatch(inventory, /isExpired\(batch\)/);
});
