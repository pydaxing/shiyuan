import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileTemplate } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import { foodMinutesLabel, mealVoterRows } from '../src/domain/presentation.js';
import { presentMutation, isPendingRecord } from '../src/services/mutation-feedback.js';
import { NATIVE_UI_COLORS } from '../src/domain/ui-theme.js';

const page = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8');
const source = readFileSync(new URL('../src/components/MealDishList.vue', import.meta.url), 'utf8');
const compiled = compileTemplate({ source: parse(source).descriptor.template.content, filename: 'MealDishList.vue', id: 'meal-dish-removal' });
assert.deepEqual(compiled.errors, []);
const render = new Function('Vue', compiled.code.replace(/import \{([^}]+)\} from "vue"/g, (_, imports) => `const {${imports.replace(/ as /g, ': ')}} = Vue;`).replace('export function render', 'return function render'))({ ...Vue, resolveComponent: name => name });
function nodes(node) {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== 'object') return [];
  return [node, ...nodes(node.children)];
}
function draw({ editable = true, removable = false, minutes = 25, busy = false } = {}) {
  const events = [];
  const recipe = { id: 'dish-1', title: '很长的菜品标题', category: '荤菜', minutes };
  const displayedRows = mealVoterRows([{ recipe, groups: [], chosenBy: [{ id: 'me' }, { id: 'partner' }] }]).map(item => ({ ...item, minutesLabel: foodMinutesLabel(item.recipe.minutes) }));
  const rendered = render({ displayedRows, editable, removable, busy, $emit: (...event) => events.push(event) }, []);
  return { recipe, events, nodes: nodes(rendered) };
}

test('kitchen metadata shows category, optional clock duration and voter count without changing checkout', () => {
  const row = draw();
  const texts = row.nodes.filter(node => node.type === 'text').map(node => node.children);
  assert.deepEqual(texts, ['很长的菜品标题', '荤菜', '25 分钟', '2 人想吃']);
  assert.match(row.nodes.find(node => node.type === 'text' && node.children === '荤菜').props.class, /\bhome-menu-item-category\b/);
  assert.ok(row.nodes.some(node => node.type === 'AppIcon' && node.props.name === 'clock'));
  for (const minutes of [null, 0, '', 'unknown']) assert.ok(!draw({ minutes }).nodes.some(node => node.type === 'AppIcon' && node.props.name === 'clock'));
  assert.equal(foodMinutesLabel(undefined), '');
  const checkout = draw({ removable: true });
  assert.ok(!checkout.nodes.some(node => node.props?.class === 'meal-dish-meta'));
  assert.equal(checkout.nodes.filter(node => node.type === 'button').length, 2);
});

test('only active kitchen rows expose the separate minus action, which never opens the recipe', () => {
  const row = draw();
  const remove = row.nodes.find(node => node.props?.class === 'meal-dish-remove');
  assert.equal(remove.props['aria-label'], '从本餐移除很长的菜品标题');
  remove.props.onClick({ stopPropagation() {} });
  assert.deepEqual(row.events, [['remove', 'dish-1']]);
  assert.ok(!draw({ editable: false }).nodes.some(node => node.props?.class === 'meal-dish-remove'));
  assert.equal(draw({ busy: true }).nodes.find(node => node.props?.class === 'meal-dish-remove').props.disabled, true);
  assert.match(page, /:editable="\['pending', 'accepted'\]\.includes\(order.status\)"/);
});

function interaction({ immediate = false, reject = false } = {}) {
  const modals = [];
  const calls = [];
  const state = Vue.ref({ family: { id: 'family' }, activeMemberId: 'me' });
  const orderSavingId = Vue.ref('');
  const orderFailure = Vue.ref(null);
  let finish;
  const result = new Promise((resolve, fail) => { finish = () => reject ? fail(new Error('移除失败')) : resolve(); });
  if (immediate) result.accepted = true;
  const bindings = { state, NATIVE_UI_COLORS, isPendingRecord, presentMutation, openedOrderId: Vue.ref('order'), orderSavingId, orderFailure, orderActionBusy: Vue.computed(() => Boolean(orderSavingId.value)), uni: { showModal: options => modals.push(options) }, removeOrderDish: (...args) => { calls.push(args); return result; } };
  const code = page.match(/async function removeMealDish\(order, recipeId\) \{[^]*?(?=\nasync function orderAction)/)[0];
  const remove = new Function(...Object.keys(bindings), `let orderActionRevision = 0; ${code}; return removeMealDish;`)(...Object.values(bindings));
  const order = { id: 'order', status: 'accepted', items: [{ recipe: { id: 'dish', title: '牛肉' } }] };
  return { state, order, remove, modals, calls, finish, orderSavingId, orderFailure };
}

test('ordinary and last-dish removal dispatch immediately without a confirmation', async () => {
  for (const status of ['pending', 'accepted']) {
    for (const lastDish of [false, true]) {
      const app = interaction({ immediate: true });
      app.order.status = status;
      if (!lastDish) app.order.items.push({ recipe: { id: 'other', title: '青菜' } });
      const task = app.remove(app.order, 'dish');
      assert.deepEqual(app.modals, []);
      assert.deepEqual(app.calls, [['order', 'dish']]);
      assert.equal(app.orderSavingId.value, '');
      app.finish();
      await task;
      assert.equal(app.orderFailure.value, null);
    }
  }
});

test('accepted removal releases the UI without waiting and a rejected operation shows an inline error', async () => {
  const app = interaction({ immediate: true, reject: true });
  const task = app.remove(app.order, 'dish');
  assert.deepEqual(app.modals, []);
  assert.deepEqual(app.calls, [['order', 'dish']]);
  assert.equal(app.orderSavingId.value, '');
  app.finish();
  await task;
  assert.equal(app.orderFailure.value.message, '移除失败');
});

test('removal not yet accepted retains its lock and prevents repeated requests', async () => {
  const app = interaction();
  const task = app.remove(app.order, 'dish');
  assert.equal(app.orderSavingId.value, 'order');
  await app.remove(app.order, 'dish');
  assert.deepEqual(app.calls, [['order', 'dish']]);
  assert.deepEqual(app.modals, []);
  app.finish();
  await task;
  assert.equal(app.orderSavingId.value, '');
  assert.equal(app.orderFailure.value, null);
});

test('old removal responses cannot change the active family or member feedback', async () => {
  for (const changed of ['family', 'member']) {
    for (const reject of [false, true]) {
      const app = interaction({ reject });
      const task = app.remove(app.order, 'dish');
      if (changed === 'family') app.state.value.family.id = 'other';
      else app.state.value.activeMemberId = 'other';
      app.orderSavingId.value = 'new-order';
      app.orderFailure.value = { id: 'new-order', message: '当前餐单提示' };
      app.finish();
      await task;
      assert.equal(app.orderSavingId.value, 'new-order');
      assert.deepEqual(app.orderFailure.value, { id: 'new-order', message: '当前餐单提示' });
    }
  }
});

test('finished orders, unsynced IDs and missing dishes never dispatch removal', async () => {
  for (const status of ['completed', 'cancelled']) {
    const app = interaction();
    app.order.status = status;
    await app.remove(app.order, 'dish');
    assert.deepEqual(app.calls, []);
    assert.deepEqual(app.modals, []);
  }
  const app = interaction();
  await app.remove(app.order, 'missing');
  app.order.id = 'pending-order';
  await app.remove(app.order, 'dish');
  assert.deepEqual(app.calls, []);
  assert.deepEqual(app.modals, []);
});

test('menu deletion and whole-meal actions retain their existing confirmations', () => {
  const menuRemoval = page.match(/async function remove\(entry\) \{[^]*?(?=\nasync function removeMealDish)/)[0];
  const mealAction = page.match(/async function orderAction\(order, action\) \{[^]*?(?=\n<\/script>)/)[0];
  assert.match(menuRemoval, /uni\.showModal\(/);
  assert.match(menuRemoval, /confirmText: '确认删除'/);
  assert.match(mealAction, /title: '取消这一餐？'/);
  assert.match(mealAction, /confirmText: '删除', cancelText: '保留'/);
});
