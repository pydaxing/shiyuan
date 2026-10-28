import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope, nextTick, ref } from 'vue';
import { createSeed } from '../src/data/seed.js';
import { createKitchenActions } from '../src/domain/actions.js';
import { clone, makeOrder, normalizeSnapshot } from '../src/domain/kitchen.js';
import { preparationDefaults, preparationMeals } from '../src/domain/meal-preparation.js';
import { createPreparationAutosave } from '../src/composables/preparation-autosave.js';

const today = '2026-10-26';
const tick = async () => { for (let index = 0; index < 8; index += 1) await nextTick(); };
function fixture(context, { wait = async () => {}, optimistic = false, debounceMs = 500 } = {}) {
  const state = ref(normalizeSnapshot(createSeed()));
  state.value.family.id = 'family-one';
  state.value.orders = [makeOrder({ id: 'dinner', recipes: state.value.recipes, cart: { tomato: 1, broccoli: 1 }, member: state.value.family.members[0], date: today, meal: '晚餐' })];
  const actions = createKitchenActions({ getState: () => state.value, commit: next => { state.value = next; }, today: () => today });
  const calls = [];
  const busy = ref(false);
  const autosave = createPreparationAutosave({
    getState: () => state.value, getScope: () => `${state.value.family.id}:${state.value.activeMemberId}`, isBusy: () => busy.value, debounceMs,
    send: async (...args) => {
      calls.push(clone(args));
      const result = optimistic ? actions.saveDishPreparation(...args) : null;
      await wait(...args);
      return optimistic ? result : actions.saveDishPreparation(...args);
    },
  });
  context.after(() => autosave.dispose());
  const entry = autosave.edit('dinner', 'tomato');
  const dish = (recipeId = 'tomato') => preparationMeals(state.value, today)[0]?.dishes.find(dish => dish.recipe.id === recipeId);
  return { state, actions, calls, busy, autosave, entry, dish };
}

test('removal during an inflight save keeps the remaining keys and is never undone by the older response', async context => {
  const releases = [];
  const view = fixture(context, { optimistic: true, wait: () => new Promise(resolve => releases.push(resolve)) });
  const removed = view.entry.ingredients[0];
  removed.quantity = '600';
  const pending = view.autosave.flush('dinner', 'tomato');
  await tick();
  const remaining = view.entry.ingredients.slice(1);
  assert.equal(view.autosave.remove('dinner', 'tomato', removed.key), true);
  assert.deepEqual(view.entry.ingredients, remaining);
  assert.equal(view.autosave.remove('dinner', 'tomato', removed.key), false);
  await view.autosave.dispatch('dinner', 'tomato');
  assert.equal(view.calls.length, 1);
  assert.equal(view.calls[0][2].ingredients[0].quantity, 600);
  releases.shift()();
  await tick();
  assert.equal(view.calls.length, 2);
  assert.deepEqual(view.entry.ingredients, remaining);
  assert.equal(view.calls[1][2].ingredients.length, remaining.length);
  releases.shift()();
  await pending;
  assert.equal(view.dish().ingredients.length, remaining.length);
  assert.equal(view.entry.dirty, false);
  assert.equal(view.entry.conflict, false);
});

test('failed removal keeps the shorter draft for retry without altering another meal of the same dish', async context => {
  let rejected = true;
  const view = fixture(context, { wait: async () => { if (rejected) throw Object.assign(new Error('暂时无法保存'), { code: 'RATE_LIMIT' }); } });
  const secondMeal = { ...clone(view.state.value.orders[0]), id: 'another-meal', meal: '午餐' };
  view.state.value.orders.push(secondMeal);
  const ingredient = view.entry.ingredients[0];
  const originalLength = view.entry.ingredients.length;
  view.autosave.remove('dinner', 'tomato', ingredient.key);
  await assert.rejects(view.autosave.flush('dinner', 'tomato'), /暂时无法保存/);
  assert.equal(view.entry.ingredients.length, originalLength - 1);
  assert.equal(view.dish().ingredients.length, originalLength);
  rejected = false;
  await view.autosave.retry('dinner', 'tomato');
  const currentDish = preparationMeals(view.state.value, today).find(meal => meal.id === 'dinner').dishes.find(dish => dish.recipe.id === 'tomato');
  assert.equal(currentDish.ingredients.length, originalLength - 1);
  assert.deepEqual(view.state.value.orders.find(meal => meal.id === secondMeal.id), secondMeal);
  assert.equal(view.entry.error, '');
});

test('closed meals and a changed family reject stale row deletion without mutating the draft', context => {
  const view = fixture(context);
  const original = clone(view.entry.ingredients);
  const ingredientKey = view.entry.ingredients[0].key;
  view.state.value.orders[0].status = 'completed';
  assert.equal(view.autosave.remove('dinner', 'tomato', ingredientKey), false);
  assert.deepEqual(view.entry.ingredients, original);
  view.state.value.orders[0].status = 'accepted';
  view.state.value.family.id = 'another-family';
  assert.equal(view.autosave.remove('dinner', 'tomato', ingredientKey), false);
  assert.deepEqual(view.entry.ingredients, original);
  assert.equal(view.calls.length, 0);
});

test('opening and equivalent normalized edits do not dispatch, and debounce keeps only the latest draft', async context => {
  const view = fixture(context, { debounceMs: 12 });
  await tick();
  assert.equal(view.calls.length, 0);
  view.entry.ingredients[0].quantity = String(view.entry.ingredients[0].quantity);
  await view.autosave.flush('dinner', 'tomato');
  assert.equal(view.calls.length, 0);
  view.entry.ingredients[0].quantity = '500'; await tick();
  view.entry.ingredients[0].quantity = '600'; await tick();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(view.calls.length, 1);
  assert.equal(view.calls[0][2].ingredients[0].quantity, 600);
  assert.equal(view.entry.ingredients[0].quantity, '600');
});

test('immutable inflight writes and own optimistic echoes never rebuild or overwrite continuing input', async context => {
  const releases = [];
  const view = fixture(context, { optimistic: true, wait: () => new Promise(resolve => releases.push(resolve)) });
  const row = view.entry.ingredients[0];
  const keys = view.entry.ingredients.map(ingredient => ingredient.key);
  row.quantity = '600';
  const pending = view.autosave.flush('dinner', 'tomato');
  await tick();
  assert.equal(view.dish().ingredients[0].quantity, 600);
  assert.equal(view.entry.conflict, false);
  assert.equal(view.entry.saving, true);
  row.quantity = '700'; await tick();
  row.quantity = '800'; await tick();
  assert.equal(view.calls.length, 1);
  assert.equal(view.calls[0][2].ingredients[0].quantity, 600);
  releases.shift()(); await tick();
  assert.equal(view.calls.length, 2);
  assert.equal(view.calls[1][2].ingredients[0].quantity, 800);
  assert.equal(view.entry.ingredients[0], row);
  assert.deepEqual(view.entry.ingredients.map(ingredient => ingredient.key), keys);
  releases.shift()(); await pending;
  assert.equal(row.quantity, '800');
  assert.equal(view.entry.dirty, false);
  assert.equal(view.entry.conflict, false);
});

test('invalid, partial decimal and composing drafts cancel unsent candidates', async context => {
  const view = fixture(context, { debounceMs: 12 });
  view.entry.ingredients[0].quantity = '600'; await tick();
  for (const value of ['', '.', '1.', '-1', '0.0001']) {
    view.entry.ingredients[0].quantity = value;
    await assert.rejects(view.autosave.flush('dinner', 'tomato'), { code: 'PREPARATION_INVALID' });
    assert.equal(view.calls.length, 0);
  }
  view.entry.ingredients[0].quantity = '600';
  view.entry.composing = true;
  await tick();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(view.calls.length, 0);
  view.entry.composing = false;
  await view.autosave.flush('dinner', 'tomato');
  assert.equal(view.calls.length, 1);
});

test('invalid input during a request remains visible and never sends an older queued candidate', async context => {
  let release;
  const view = fixture(context, { wait: () => new Promise(resolve => { release = resolve; }) });
  view.entry.ingredients[0].quantity = '600';
  await view.autosave.dispatch('dinner', 'tomato');
  view.entry.ingredients[0].quantity = '700'; await tick();
  view.entry.ingredients[0].quantity = ''; await tick();
  release(); await tick();
  assert.equal(view.calls.length, 1);
  assert.equal(view.dish().ingredients[0].quantity, 600);
  assert.equal(view.entry.ingredients[0].quantity, '');
  await assert.rejects(view.autosave.flush('dinner', 'tomato'), { code: 'PREPARATION_INVALID' });
});

test('different dishes serialize while an invalid dish does not block another target barrier', async context => {
  const releases = [];
  const view = fixture(context, { wait: () => new Promise(resolve => releases.push(resolve)) });
  const second = view.autosave.edit('dinner', 'broccoli');
  view.entry.ingredients[0].quantity = '600';
  const first = view.autosave.flush('dinner', 'tomato'); await tick();
  second.ingredients[0].quantity = '900';
  const last = view.autosave.flush('dinner', 'broccoli'); await tick();
  assert.equal(view.calls.length, 1);
  releases.shift()(); await first; await tick();
  assert.equal(view.calls.length, 2);
  view.entry.ingredients[0].quantity = ''; await tick();
  releases.shift()(); await last;
  assert.equal(view.dish('broccoli').ingredients[0].quantity, 900);
  assert.equal(view.entry.ingredients[0].quantity, '');
});

test('drafts and requests survive component scope disposal and recover on reopening', async context => {
  let release;
  const view = fixture(context, { wait: () => new Promise(resolve => { release = resolve; }) });
  const component = effectScope();
  const entry = component.run(() => view.autosave.edit('dinner', 'tomato'));
  entry.ingredients[0].quantity = '600';
  const saved = view.autosave.flush('dinner', 'tomato'); await tick();
  component.stop();
  entry.ingredients[0].quantity = '600.0';
  release(); await saved;
  assert.equal(view.autosave.edit('dinner', 'tomato'), entry);
  assert.equal(entry.ingredients[0].quantity, '600.0');
  assert.equal(entry.dirty, false);
});

test('uncertain failures retain immutable retries before sending newer draft versions', async context => {
  let offline = true;
  const view = fixture(context, { wait: async () => { if (offline) throw new Error('网络连接失败'); } });
  view.entry.ingredients[0].quantity = '600';
  await assert.rejects(view.autosave.flush('dinner', 'tomato'), /网络/);
  view.entry.ingredients[0].quantity = '800'; await tick();
  assert.match(view.autosave.edit('dinner', 'tomato').error, /网络/);
  assert.equal(view.calls.length, 1);
  offline = false;
  await view.autosave.retry('dinner', 'tomato');
  assert.deepEqual(view.calls[1], view.calls[0]);
  assert.equal(view.calls[2][2].ingredients[0].quantity, 800);
  assert.equal(view.entry.error, '');
});

test('clean sessions reload external content but dirty sessions retain a conflicting draft', async context => {
  const view = fixture(context);
  view.actions.saveDishPreparation('dinner', 'tomato', { ingredients: view.dish().ingredients, note: '家人的备注' }, view.dish().editSignature);
  await tick();
  assert.equal(view.entry.note, '家人的备注');
  view.entry.ingredients[0].quantity = '800';
  view.actions.saveDishPreparation('dinner', 'tomato', { ingredients: view.dish().ingredients, note: '另一条备注' }, view.dish().editSignature);
  await tick();
  assert.equal(view.entry.conflict, true);
  assert.equal(view.entry.ingredients[0].quantity, '800');
  await assert.rejects(view.autosave.flush('dinner', 'tomato'), { code: 'CONFLICT' });
  assert.equal(view.calls.length, 0);
  view.autosave.reload('dinner', 'tomato');
  assert.equal(view.entry.note, '另一条备注');
  assert.equal(view.entry.conflict, false);
});

test('scope changes and removed meals cannot dispatch queued drafts into a different scope', async context => {
  const view = fixture(context);
  view.busy.value = true;
  view.entry.ingredients[0].quantity = '600';
  await view.autosave.dispatch('dinner', 'tomato');
  view.state.value.family.id = 'family-two'; view.busy.value = false;
  await tick();
  assert.equal(view.calls.length, 0);
  assert.match(view.entry.unavailable, /家庭已切换/);
  view.state.value.family.id = 'family-one';
  view.state.value.orders[0].status = 'completed';
  await tick();
  await assert.rejects(view.autosave.flush('dinner', 'tomato'), { code: 'PREPARATION_UNAVAILABLE' });
});

test('reset is a latest intent, retains hidden notes and restores order snapshot amounts scaled once', async context => {
  const releases = [];
  const view = fixture(context, { wait: () => new Promise(resolve => releases.push(resolve)) });
  view.state.value.orders[0].items[0].quantity = 2;
  view.state.value.orders[0].items[0].scale = 1.5;
  await tick();
  view.entry.note = '保留的历史备注';
  view.entry.ingredients[0].quantity = '600';
  await view.autosave.dispatch('dinner', 'tomato');
  const item = view.state.value.orders[0].items[0];
  const expected = preparationDefaults(item, view.entry.note);
  view.autosave.add('dinner', 'tomato');
  view.autosave.defaults('dinner', 'tomato');
  releases.shift()(); await tick();
  assert.equal(view.calls.length, 2);
  assert.deepEqual(view.calls[1][2], expected);
  releases.shift()(); await view.autosave.flush('dinner', 'tomato');
  assert.equal(view.entry.ingredients[0].quantity, expected.ingredients[0].quantity);
  assert.equal(view.entry.note, '保留的历史备注');
  assert.equal(view.entry.ingredients[0].quantity, item.recipe.ingredients[0].quantity * 3);
});

test('target actions await the latest draft, isolate duplicate targets and retain failures', async context => {
  let release;
  const view = fixture(context, { wait: () => new Promise(resolve => { release = resolve; }) });
  view.entry.ingredients[0].quantity = '600';
  const seen = [];
  const action = view.autosave.act('dinner', 'tomato', 'package', () => { seen.push(view.dish().ingredients[0].quantity); return true; });
  await tick();
  assert.deepEqual(seen, []);
  assert.equal(await view.autosave.act('dinner', 'tomato', 'prepared', () => false), false);
  assert.equal(await view.autosave.act('dinner', 'broccoli', 'package', () => true), true);
  release(); assert.equal(await action, true);
  assert.deepEqual(seen, [600]);
  await view.autosave.act('dinner', 'tomato', 'package', () => { throw new Error('加购失败'); });
  assert.equal(view.autosave.edit('dinner', 'tomato').actionError.message, '加购失败');
});
