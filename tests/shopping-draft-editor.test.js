import test from 'node:test';
import assert from 'node:assert/strict';
import * as Vue from 'vue';
import { createSeed } from '../src/data/seed.js';
import { createKitchenActions } from '../src/domain/actions.js';
import * as kitchen from '../src/domain/kitchen.js';
import * as preparation from '../src/domain/meal-preparation.js';
import * as shopping from '../src/domain/meal-shopping.js';
import { NATIVE_UI_COLORS } from '../src/domain/ui-theme.js';
import { componentSource, setupSource } from './helpers/sfc-setup.js';

const today = '2026-10-26';
function editor(context, { initialize = () => {}, wait = async () => {} } = {}) {
  const state = Vue.ref(kitchen.normalizeSnapshot(createSeed()));
  state.value.family.features = { fridge: false, shopping: false };
  state.value.orders = [];
  state.value.purchases = [];
  state.value.recipes.find(recipe => recipe.id === 'tomato').ingredients = [
    { name: '番茄', quantity: 300, unit: 'g' },
    { name: '鸡蛋', quantity: 2, unit: '个' },
    { name: '盐', quantity: null, unit: '', amountText: '适量' },
    { name: '葱', quantity: null, unit: '', amountText: '按口味酌量' },
  ];
  const actions = createKitchenActions({ getState: () => state.value, commit: next => { kitchen.validateSnapshot(next); state.value = next; }, newId: () => 'dinner', today: () => today });
  actions.submitOrder({ tomato: 1 }, { date: today, meal: '晚餐' });
  const order = () => state.value.orders[0];
  const dish = () => preparation.preparationMeals(state.value, today)[0]?.dishes[0];
  const addPackage = () => actions.saveShoppingDraft('dinner', 'tomato', { ingredients: [shopping.shoppingSourceIngredients(dish().ingredients)[0]] }, shopping.shoppingEditSignature(order(), 'tomato'));
  initialize({ state, actions, order, dish, addPackage });
  const calls = [];
  const events = [];
  const notices = [];
  const modals = [];
  const cloudStatus = Vue.ref({ busy: false });
  const scope = Vue.effectScope();
  context.after(() => scope.stop());
  const api = scope.run(() => setupSource('ShoppingDraftEditor', {
    computed: Vue.computed, nextTick: Vue.nextTick, onScopeDispose: Vue.onScopeDispose, ref: Vue.ref, watch: Vue.watch,
    ...kitchen, ...preparation, ...shopping, NATIVE_UI_COLORS, state, cloudStatus,
    defineProps: () => ({ orderId: 'dinner', recipeId: 'tomato', today }),
    defineEmits: () => (...args) => events.push(args),
    uni: { showModal: options => modals.push(options) },
    notify: message => notices.push(message),
    saveShoppingDraft: async (...args) => { calls.push(kitchen.clone(args)); await wait(); return actions.saveShoppingDraft(...args); },
  }, ['rows', 'draft', 'dish', 'existing', 'selectedRows', 'rowErrors', 'fieldErrors', 'fieldRefs', 'submitted', 'error', 'saving', 'busy', 'dirty', 'stale', 'unavailable', 'changedRequirements', 'toggle', 'toggleAll', 'changeUnit', 'useCurrentAmounts', 'loadCurrent', 'reloadLatest', 'close', 'save']));
  return { ...api, state, actions, calls, events, notices, modals, cloudStatus, scope, order, currentDish: dish };
}

test('opening procurement does not preselect ingredients or mutate the meal, recipe or fridge', context => {
  const view = editor(context);
  const before = kitchen.clone(view.state.value);
  assert.equal(view.rows.value.length, 4);
  assert.equal(view.selectedRows.value.length, 0);
  assert.equal(view.dirty.value, false);
  assert.deepEqual(view.fieldErrors.value, {});
  assert.deepEqual(view.calls, []);
  assert.deepEqual(kitchen.clone(view.state.value), before);
});

test('empty selection reveals its own inline error without saving or producing a footer message', async context => {
  const view = editor(context);
  const revealed = [];
  view.fieldRefs.ingredients = { reveal: () => revealed.push('ingredients') };
  await view.save();
  assert.deepEqual(revealed, ['ingredients']);
  assert.match(view.fieldErrors.value.ingredients, /请勾选/);
  assert.equal(view.error.value, '');
  assert.deepEqual(view.calls, []);
  assert.deepEqual(view.events, []);
});

test('partial selection and purchase quantities remain independent of meal requirements', async context => {
  const view = editor(context);
  const sourceBefore = kitchen.clone(view.currentDish().ingredients);
  view.toggle(view.rows.value[0]);
  view.rows.value[0].quantity = '120';
  view.toggle(view.rows.value[2]);
  await view.save();
  assert.equal(view.calls.length, 1);
  assert.deepEqual(view.order().shoppingDrafts[0].ingredients.map(ingredient => [ingredient.name, ingredient.quantity, ingredient.amountText]), [['番茄', 120, undefined], ['盐', null, '适量']]);
  assert.deepEqual(kitchen.clone(view.currentDish().ingredients), sourceBefore);
  assert.equal(view.currentDish().prepared, false);
  assert.deepEqual(view.events, [['saved']]);
});

for (const [value, field] of [['', 'quantity'], ['-1', 'quantity'], ['100001', 'quantity'], ['not-a-unit', 'amount']]) {
  test(`invalid selected purchase ${field} stays under its control: ${value}`, async context => {
    const view = editor(context);
    const row = view.rows.value[0];
    view.toggle(row);
    if (field === 'quantity') row.quantity = value;
    else row.unit = value;
    const revealed = [];
    view.fieldRefs[`${row.sourceKey}.${field}`] = { reveal: () => revealed.push(field) };
    await view.save();
    assert.deepEqual(revealed, [field]);
    assert.ok(view.rowErrors.value[row.sourceKey][field]);
    assert.equal(view.error.value, '');
    assert.deepEqual(view.calls, []);
  });
}

test('unchecked incomplete rows never block a valid partial package', async context => {
  const view = editor(context);
  view.rows.value[0].quantity = '';
  view.toggle(view.rows.value[1]);
  await view.save();
  assert.deepEqual(view.fieldErrors.value, {});
  assert.equal(view.calls.length, 1);
  assert.deepEqual(view.order().shoppingDrafts[0].ingredients.map(ingredient => ingredient.name), ['鸡蛋']);
});

test('all selection can be undone and arbitrary existing recipe amounts are preserved', async context => {
  const view = editor(context);
  view.toggleAll();
  assert.equal(view.selectedRows.value.length, 4);
  view.toggleAll();
  assert.equal(view.selectedRows.value.length, 0);
  const row = view.rows.value[3];
  assert.equal(row.choice, '原用量');
  view.toggle(row);
  await view.save();
  assert.equal(view.order().shoppingDrafts[0].ingredients[0].amountText, '按口味酌量');
});

test('changing from a text amount to a numeric unit requires a new valid quantity', async context => {
  const view = editor(context);
  const row = view.rows.value[2];
  view.toggle(row);
  view.changeUnit(row, 'g');
  assert.equal(row.quantity, '');
  assert.equal(row.amountText, undefined);
  await view.save();
  assert.ok(view.rowErrors.value[row.sourceKey].quantity);
  row.quantity = '3';
  await view.save();
  assert.equal(view.calls.length, 1);
  assert.equal(view.order().shoppingDrafts[0].ingredients[0].quantity, 3);
});

test('adjusting a package preserves purchase amounts until the user explicitly adopts new meal amounts', context => {
  const view = editor(context, { initialize({ addPackage, actions, dish }) {
    addPackage();
    const current = dish();
    const ingredients = kitchen.clone(current.ingredients);
    ingredients[0].quantity = 600;
    actions.saveDishPreparation('dinner', 'tomato', { ingredients, note: '' }, current.editSignature);
  } });
  assert.equal(view.changedRequirements.value, true);
  assert.equal(view.rows.value[0].quantity, 300);
  assert.equal(view.stale.value, false);
  view.useCurrentAmounts();
  assert.equal(view.rows.value[0].quantity, 600);
  assert.equal(view.selectedRows.value.length, 1);
  assert.equal(view.dirty.value, true);
});

test('a removed source remains visible for explicit deselection and cannot be silently repurchased', async context => {
  const view = editor(context, { initialize({ addPackage, actions, dish }) {
    addPackage();
    const current = dish();
    actions.saveDishPreparation('dinner', 'tomato', { ingredients: kitchen.clone(current.ingredients.slice(1)), note: '' }, current.editSignature);
  } });
  const removed = view.rows.value.find(row => row.removed);
  assert.equal(removed.name, '番茄');
  const revealed = [];
  view.fieldRefs[`${removed.sourceKey}.source`] = { reveal: () => revealed.push('source') };
  await view.save();
  assert.deepEqual(revealed, ['source']);
  assert.deepEqual(view.calls, []);
  view.toggleAll();
  assert.equal(removed.selected, false);
  await view.save();
  assert.equal(view.calls.length, 1);
  assert.ok(view.order().shoppingDrafts[0].ingredients.every(ingredient => ingredient.name !== '番茄'));
});

test('concurrent preparation changes prevent saving until explicitly reloaded', async context => {
  const view = editor(context);
  view.toggle(view.rows.value[0]);
  const current = view.currentDish();
  const ingredients = kitchen.clone(current.ingredients);
  ingredients[0].quantity = 550;
  view.actions.saveDishPreparation('dinner', 'tomato', { ingredients, note: '' }, current.editSignature);
  assert.equal(view.stale.value, true);
  await view.save();
  assert.deepEqual(view.calls, []);
  const reload = view.reloadLatest();
  view.modals[0].success({ confirm: false });
  await reload;
  assert.equal(view.rows.value[0].quantity, 300);
  assert.equal(view.stale.value, true);
  const acceptedReload = view.reloadLatest();
  view.modals[1].success({ confirm: true });
  await acceptedReload;
  assert.equal(view.rows.value[0].quantity, 550);
  assert.equal(view.selectedRows.value.length, 0);
  assert.equal(view.stale.value, false);
});

test('cloud failures retain selection and quantity for a single retry', async context => {
  let attempts = 0;
  const view = editor(context, { wait: async () => { if (++attempts === 1) throw new Error('连接失败，请重试'); } });
  view.toggle(view.rows.value[0]);
  view.rows.value[0].quantity = '180';
  await view.save();
  assert.equal(view.error.value, '连接失败，请重试');
  assert.equal(view.rows.value[0].quantity, '180');
  assert.equal(view.order().shoppingDrafts, undefined);
  await view.save();
  assert.equal(view.calls.length, 2);
  assert.deepEqual(view.calls[0], view.calls[1]);
  assert.deepEqual(view.events, [['saved']]);
});

test('pending save blocks duplicate taps, selection changes and closing the sheet', async context => {
  let finish;
  const view = editor(context, { wait: () => new Promise(resolve => { finish = resolve; }) });
  view.toggle(view.rows.value[0]);
  const saving = view.save();
  await view.save();
  view.toggle(view.rows.value[1]);
  await view.close();
  assert.equal(view.calls.length, 1);
  assert.equal(view.selectedRows.value.length, 1);
  assert.deepEqual(view.events, []);
  finish();
  await saving;
  assert.equal(view.saving.value, false);
});

for (const status of ['completed', 'cancelled']) {
  test(`${status} meal stops procurement edits without discarding the entered quantity`, async context => {
    const view = editor(context);
    view.toggle(view.rows.value[0]);
    view.rows.value[0].quantity = '250';
    view.state.value.orders[0].status = status;
    assert.ok(view.unavailable.value);
    await view.save();
    assert.deepEqual(view.calls, []);
    assert.equal(view.rows.value[0].quantity, '250');
  });
}

test('shopping editor has inline field owners and no notes, payment or logistics surface', () => {
  const source = componentSource('ShoppingDraftEditor');
  assert.match(source, /<FieldError.*fieldRefs.ingredients.*:error="fieldErrors.ingredients"/);
  assert.match(source, /<FormField.*:error="rowErrors\[row.sourceKey\]\?\.quantity"/);
  assert.match(source, /<SelectField.*:error="rowErrors\[row.sourceKey\]\?\.amount"/);
  assert.doesNotMatch(source, /备注|确认收货|物流|立即支付|查看做法/);
});
