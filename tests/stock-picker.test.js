import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import * as catalog from '../src/domain/ingredient-catalog.js';
import { stockReminder } from '../src/domain/stock-reminders.js';
import { presentMutation } from '../src/services/mutation-feedback.js';
const source = readFileSync(new URL('../src/components/StockPicker.vue', import.meta.url), 'utf8');
const script = compileScript(parse(source).descriptor, { id: 'stock-picker-test' });
const code = script.content.replace(/import (\{[^}]+\}|\w+) from '[^']+';/g, (_, binding) => `const ${binding} = ${binding.startsWith('{') ? 'modules' : '{}'};`).replace('export default', 'return');
function mount(context, overrides = {}, initial = {}) {
  const calls = [], events = [];
  const scope = Vue.effectScope(); context.after(() => scope.stop());
  const component = new Function('modules', code)({ ...Vue, ...catalog, stockReminder, presentMutation, state: Vue.ref({}), addStock: async draft => calls.push(draft), ...overrides });
  const api = scope.run(() => component.setup({ initial }, { expose() {}, emit: (...args) => events.push(args) }));
  return { api, calls, events };
}
test('selection opens a quantity dialog without mutating inventory', context => {
  const { api, calls, events } = mount(context);
  api.query.value = '西红柿'; api.choose(api.suggestions.value[0]);
  assert.equal(api.selected.value.name, '番茄');
  assert.equal(api.editor.value, null); assert.deepEqual(calls, []); assert.deepEqual(events, []);
  api.selected.value = null; assert.equal(api.query.value, '西红柿');
});
test('directory renders in batches and resets when filtering', async context => {
  const { api } = mount(context); assert.equal(api.category.value, '常用'); assert.equal(api.matches.value.length, 40);
  api.category.value = '水果'; await Vue.nextTick(); assert.equal(api.suggestions.value.length, 40);
  api.more(); assert.equal(api.suggestions.value.length, 80);
  api.category.value = '叶菜'; await Vue.nextTick();
  assert.equal(api.limit.value, 40); assert.ok(api.suggestions.value.every(e => e.category === '叶菜'));
});
test('explicit storage zone overrides defaults, all zone keeps catalog choice', context => {
  assert.equal(mount(context, {}, { location: '冷冻' }).api.targetLocation.value, '冷冻');
  assert.equal(mount(context, {}, { location: '冷藏', useCatalogLocation: true }).api.targetLocation.value, undefined);
});
test('custom food retains search and gets editable estimated reminder', context => {
  const { api, calls } = mount(context); api.query.value = ' 自制豆干 '; api.custom();
  assert.equal(api.editor.value.name, '自制豆干'); assert.equal(api.editor.value.estimatedReminder, true);
  assert.equal(api.editor.value.expiresOn, stockReminder(null, '冷藏').date); assert.deepEqual(calls, []);
});

test('search ignores selected category and clearing returns to it', async context => {
  const {api} = mount(context); api.category.value = '水果'; api.query.value = '鸡肉'; await Vue.nextTick();
  assert.equal(api.suggestions.value[0].name, '鸡肉'); assert.equal(api.category.value, '水果');
  api.query.value = ''; await Vue.nextTick(); assert.ok(api.suggestions.value.every(e => e.category === '水果'));
});
test('card storage and reminder match quantity dialog defaults for explicit zone', context => {
  const {api} = mount(context, {}, {location: '冷冻'});
  for (const entry of api.suggestions.value) {
    assert.equal(entry.displayLocation, '冷冻');
    assert.equal(entry.reminderLabel, `预计保存 ${stockReminder(entry, '冷冻').days} 天`);
    assert.equal(catalog.stockFromIngredient(entry, api.targetLocation.value).location, entry.displayLocation);
  }
});
