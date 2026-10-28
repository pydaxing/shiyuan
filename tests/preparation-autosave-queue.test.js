import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computed, effectScope, nextTick, onScopeDispose, ref, watch } from 'vue';
import { createSeed } from '../src/data/seed.js';
import { createKitchenActions } from '../src/domain/actions.js';
import { clone, makeOrder, normalizeSnapshot } from '../src/domain/kitchen.js';
import { preparationKey, preparationMeals } from '../src/domain/meal-preparation.js';
import { normalizeShoppingDraft, shoppingCartMeals, shoppingEditSignature, wholeDishShoppingDraft } from '../src/domain/meal-shopping.js';
import { NATIVE_UI_COLORS } from '../src/domain/ui-theme.js';
import { createCommandQueue } from '../src/services/command-queue.js';
import { createPreparationAutosave } from '../src/composables/preparation-autosave.js';

const today = '2026-10-26';
const timestamp = Date.parse(`${today}T04:00:00Z`);
const failure = (code, message = code) => Object.assign(new Error(message), { code });
const tick = async () => { for (let index = 0; index < 12; index += 1) await nextTick(); };

function fixture(context, options = {}) {
  const initial = normalizeSnapshot(createSeed());
  initial.family.id = 'family-one';
  initial.orders = [makeOrder({ id: 'dinner', recipes: initial.recipes, cart: { tomato: 1, broccoli: 1 }, member: initial.family.members[0], date: today, meal: '晚餐' })];
  const state = ref(initial);
  const status = ref({ operations: [] });
  const journal = new Map();
  const receipts = new Map();
  const requests = [];
  const operations = [];
  const retries = [];
  const discards = [];
  let server = clone(initial);
  let revision = 1;
  let sequence = 0;
  let writes = 0;
  const actions = createKitchenActions({ getState: () => server, commit: next => { server = next; }, today: () => today, now: () => timestamp + 9000 });
  const queue = createCommandQueue({
    snapshot: initial, now: () => timestamp, newId: () => `prep-operation-${++sequence}`,
    journal: { read: scope => clone(journal.get(scope) || []), write: (scope, entries) => { options.persist?.(); journal.set(scope, clone(entries)); } },
    send: payload => new Promise((resolve, reject) => requests.push({ payload, resolve, reject })),
    reconcile: async (response, operationId) => { queue.receive(response.snapshot, response.revision, operationId); },
    refresh: async () => { queue.receive(server, revision); },
    onChange: snapshot => { state.value = snapshot; },
    onStatus: next => { status.value = next; },
  });
  queue.activate(initial, { scope: 'test:family-one', familyId: 'family-one', userId: initial.activeMemberId, revision });
  const autosave = createPreparationAutosave({
    getState: () => state.value, getScope: () => `${state.value.family.id}:${state.value.activeMemberId}`, debounceMs: 60_000,
    send: (...args) => { const operation = queue.enqueue('saveDishPreparation', args); operations.push(operation); return operation; },
    retryOperation: operationId => { retries.push(operationId); return queue.retry(operationId); },
    discardOperation: operationId => { discards.push(operationId); return options.discard ? options.discard(queue, operationId) : queue.discard(operationId); },
    getOperations: () => status.value.operations,
  });
  context.after(() => { autosave.dispose(); queue.pause(); });
  const entry = autosave.edit('dinner', 'tomato');
  const dish = (recipeId = 'tomato', snapshot = state.value) => preparationMeals(snapshot, today)[0].dishes.find(dish => dish.recipe.id === recipeId);
  function commit(index) {
    const payload = requests[index].payload;
    if (!receipts.has(payload.requestId)) {
      const value = actions[payload.name](...payload.args);
      revision += 1;
      writes += 1;
      receipts.set(payload.requestId, { value, revision, snapshot: clone(server) });
    }
    return clone(receipts.get(payload.requestId));
  }
  function confirm(index) { requests[index].resolve(commit(index)); }
  function remoteEdit(quantity, publish = true) {
    const current = dish('tomato', server);
    actions.saveDishPreparation('dinner', 'tomato', { ingredients: current.ingredients.map((ingredient, index) => index ? ingredient : { ...ingredient, quantity }), note: '家人的备注' }, current.editSignature);
    revision += 1;
    if (publish) queue.receive(server, revision);
  }
  async function rejectFirst(code = 'NETWORK') {
    entry.ingredients[0].quantity = '600';
    const pending = assert.rejects(autosave.flush('dinner', 'tomato'), { code });
    await tick();
    requests[0].reject(failure(code));
    await pending;
    await tick();
    return operations[0].operationId;
  }
  return { state, status, queue, autosave, entry, requests, operations, retries, discards, dish, commit, confirm, remoteEdit, rejectFirst, get writes() { return writes; } };
}

function controls(context, view) {
  const scope = effectScope();
  const modals = [];
  const bindings = {
    computed, onScopeDispose, watch, preparationKey, normalizeShoppingDraft, shoppingEditSignature, wholeDishShoppingDraft, NATIVE_UI_COLORS,
    state: view.state,
    preparationMeals: (snapshot, date = today) => preparationMeals(snapshot, date),
    usePreparationAutosave: () => view.autosave,
    setDishPrepared: (...args) => view.queue.enqueue('setDishPrepared', args),
    saveShoppingDraft: (...args) => view.queue.enqueue('saveShoppingDraft', args),
    removeShoppingDraft: (...args) => view.queue.enqueue('removeShoppingDraft', args),
    uni: { showModal: modal => modals.push(modal) },
  };
  const useControl = name => {
    const source = readFileSync(new URL(`../src/composables/${name}.js`, import.meta.url), 'utf8').replace(/^import .*;\s*$/gm, '').replace('export function', 'function');
    const use = new Function(...Object.keys(bindings), `${source}\nreturn ${name};`)(...Object.values(bindings));
    return scope.run(() => use());
  };
  const prepared = useControl('usePreparationActions');
  const packages = useControl('useDishPackageActions');
  context.after(() => scope.stop());
  return {
    modals, prepared, packages,
    ready: (recipeId = 'tomato') => prepared.togglePrepared(preparationMeals(view.state.value, today)[0], view.dish(recipeId)),
    add: (recipeId = 'tomato') => packages.togglePackage('dinner', recipeId),
    cart: computed(() => shoppingCartMeals(view.state.value, today)),
  };
}

test('ready and package controls project before network responses and release the local action lock', { timeout: 3000 }, async context => {
  const view = fixture(context);
  const ui = controls(context, view);
  const prepared = ui.ready();
  await tick();
  assert.equal(view.requests.length, 1);
  assert.equal(view.dish().prepared, true);
  assert.equal(preparationMeals(view.state.value, today)[0].preparedCount, 1);
  assert.equal(view.entry.actionBusy, '');
  const added = ui.add('broccoli');
  await tick();
  assert.equal(ui.cart.value[0].dishes.length, 1);
  assert.equal(ui.cart.value[0].dishes[0].recipe.id, 'broccoli');
  assert.equal(ui.packages.busy.value, false);
  assert.equal(view.requests.length, 1, 'backend requests remain ordered while both UI states are visible');
  view.confirm(0); await prepared; await tick();
  view.confirm(1); await added;
  assert.equal(view.status.value.operations.length, 0);
});

test('latest unsent quantities and the package badge are projected together without waiting for autosave confirmation', { timeout: 3000 }, async context => {
  const view = fixture(context);
  const ui = controls(context, view);
  view.entry.ingredients[0].quantity = '600';
  const added = ui.add();
  await tick();
  assert.equal(view.requests.length, 1);
  assert.deepEqual(view.status.value.operations.map(operation => operation.name), ['saveDishPreparation', 'saveShoppingDraft']);
  assert.equal(view.dish().ingredients[0].quantity, 600);
  assert.equal(ui.cart.value[0].dishes[0].purchaseIngredients[0].quantity, 600);
  assert.equal(view.entry.actionBusy, '');
  assert.equal(view.entry.saving, true);
  view.confirm(0); await tick();
  assert.equal(view.requests[1].payload.args[2].ingredients[0].quantity, 600);
  view.confirm(1); await added;
  assert.equal(view.entry.conflict, false);
  assert.equal(view.entry.dirty, false);
});

test('a newer edit overtakes an older accepted autosave locally without mutating its payload or waiting for it', { timeout: 3000 }, async context => {
  const view = fixture(context);
  const ui = controls(context, view);
  const row = view.entry.ingredients[0];
  row.quantity = '600';
  const saved = view.autosave.flush('dinner', 'tomato'); await tick();
  row.quantity = '0800.0';
  const added = ui.add(); await tick();
  assert.equal(view.requests.length, 1);
  assert.equal(view.requests[0].payload.args[2].ingredients[0].quantity, 600);
  assert.equal(ui.cart.value[0].dishes[0].purchaseIngredients[0].quantity, 800);
  assert.equal(view.entry.ingredients[0], row);
  assert.equal(view.entry.actionBusy, '');
  view.confirm(0); await tick();
  assert.equal(view.dish().ingredients[0].quantity, 800);
  assert.equal(view.entry.conflict, false);
  assert.equal(view.entry.saving, true);
  assert.equal(view.requests[1].payload.args[2].ingredients[0].quantity, 800);
  view.confirm(1); await tick();
  assert.equal(view.requests[2].payload.args[2].ingredients[0].quantity, 800);
  view.confirm(2); await Promise.all([saved, added]);
  assert.equal(row.quantity, '0800.0');
  assert.equal(view.entry.dirty, false);
  assert.equal(view.entry.conflict, false);
});

test('another dish saving in the background cannot delay a target edit and ready state', { timeout: 3000 }, async context => {
  const view = fixture(context);
  const ui = controls(context, view);
  view.entry.ingredients[0].quantity = '600';
  const saved = view.autosave.flush('dinner', 'tomato'); await tick();
  const other = view.autosave.edit('dinner', 'broccoli');
  other.ingredients[0].quantity = '900';
  const prepared = ui.ready('broccoli'); await tick();
  assert.equal(view.dish('broccoli').prepared, true);
  assert.equal(view.dish('broccoli').ingredients[0].quantity, 900);
  assert.equal(other.actionBusy, '');
  assert.equal(view.requests.length, 1);
  view.confirm(0); await saved; await tick();
  view.confirm(1); await tick();
  view.confirm(2); await prepared;
  assert.equal(other.conflict, false);
  assert.equal(other.dirty, false);
});

for (const kind of ['ready', 'add']) for (const field of ['quantity', 'note']) test(`failed ${field} save blocks dependent ${kind} instead of applying it to old materials`, { timeout: 3000 }, async context => {
  const view = fixture(context);
  const ui = controls(context, view);
  if (field === 'quantity') view.entry.ingredients[0].quantity = '600';
  else view.entry.note = '本餐新备注';
  const pending = ui[kind](); await tick();
  assert.equal(view.entry.actionBusy, '');
  assert.equal(kind === 'ready' ? view.dish().prepared : ui.cart.value.length > 0, true);
  view.requests[0].reject(failure('INVALID', '本餐调整未保存'));
  assert.equal(await pending, false); await tick();
  assert.equal(view.requests.length, 1);
  assert.equal(view.dish().prepared, false);
  assert.equal(ui.cart.value.length, 0);
  assert.match(view.entry.error, /本餐调整未保存/);
  assert.match(view.entry.actionError.message, /相关内容已变化/);
  assert.deepEqual(view.status.value.operations.map(operation => operation.status), ['failed', 'blocked']);
});

test('a definite action rejection restores its projected state and leaves a scoped error', { timeout: 3000 }, async context => {
  const view = fixture(context);
  const ui = controls(context, view);
  const prepared = ui.ready(); await tick();
  assert.equal(view.dish().prepared, true);
  view.requests[0].reject(failure('FORBIDDEN', '没有修改权限'));
  assert.equal(await prepared, false);
  assert.equal(view.dish().prepared, false);
  assert.equal(view.entry.actionBusy, '');
  assert.equal(view.entry.actionError.message, '没有修改权限');
});

test('same-tick package taps are deduplicated and the next admitted tap cancels immediately', { timeout: 3000 }, async context => {
  const view = fixture(context);
  const ui = controls(context, view);
  const added = ui.add();
  assert.equal(await ui.add(), false);
  await tick();
  const removed = ui.add(); await tick();
  assert.equal(view.requests.length, 1);
  assert.equal(ui.cart.value.length, 0);
  assert.equal(view.status.value.operations.length, 2);
  assert.equal(view.entry.actionBusy, '');
  view.confirm(0); await added;
  await tick();
  assert.equal(ui.cart.value.length, 0, 'old add acknowledgement cannot put a cancelled package back');
  view.confirm(1); assert.equal(await removed, true);
  assert.equal(ui.cart.value.length, 0);
  assert.deepEqual(ui.modals, []);
});

test('rapid add remove and add keep the latest package through each older response', { timeout: 3000 }, async context => {
  const view = fixture(context);
  const ui = controls(context, view);
  const first = ui.add(); await tick();
  const removed = ui.add(); await tick();
  const last = ui.add(); await tick();
  assert.equal(view.requests.length, 1);
  assert.equal(ui.cart.value[0].dishes.length, 1);
  assert.deepEqual(view.status.value.operations.map(operation => operation.name), ['saveShoppingDraft', 'removeShoppingDraft', 'saveShoppingDraft']);
  view.confirm(0); await first; await tick();
  assert.equal(ui.cart.value[0].dishes.length, 1);
  view.confirm(1); await removed; await tick();
  assert.equal(ui.cart.value[0].dishes.length, 1);
  view.confirm(2); assert.equal(await last, true);
  assert.equal(view.status.value.operations.length, 0);
  assert.deepEqual(ui.modals, []);
});

test('failed package cancellation restores the package and permits a direct retry', { timeout: 3000 }, async context => {
  const view = fixture(context);
  const ui = controls(context, view);
  const added = ui.add(); await tick();
  view.confirm(0); await added;
  const removed = ui.add(); await tick();
  assert.equal(ui.cart.value.length, 0);
  view.requests[1].reject(failure('FORBIDDEN', '暂时不能移除'));
  assert.equal(await removed, false); await tick();
  assert.equal(ui.cart.value[0].dishes.length, 1);
  assert.equal(view.entry.actionError.message, '暂时不能移除');
  const retried = ui.add(); await tick();
  assert.equal(ui.cart.value.length, 0);
  view.confirm(2); assert.equal(await retried, true);
  assert.equal(view.entry.actionError, null);
  assert.deepEqual(ui.modals, []);
});

for (const kind of ['ready', 'add']) test(`cancelling ${kind} preserves an incomplete material without trying to save it`, { timeout: 3000 }, async context => {
  const view = fixture(context);
  const ui = controls(context, view);
  const enabled = ui[kind](); await tick();
  view.confirm(0); await enabled;
  view.autosave.add('dinner', 'tomato'); await tick();
  const draft = view.entry.ingredients.at(-1);
  assert.equal(draft.name, '');
  const cancelled = ui[kind](); await tick();
  assert.equal(view.requests.length, 2);
  assert.equal(view.requests[1].payload.name, kind === 'ready' ? 'setDishPrepared' : 'removeShoppingDraft');
  assert.equal(view.dish().prepared, false);
  assert.equal(ui.cart.value.length, 0);
  assert.equal(view.entry.ingredients.at(-1), draft);
  view.confirm(1); assert.equal(await cancelled, true);
  assert.equal(await ui[kind](), false);
  assert.equal(view.requests.length, 2, 'a positive action still requires complete materials');
  assert.equal(view.entry.ingredients.at(-1).name, '');
  assert.equal(view.entry.dirty, true);
});

for (const change of ['family', 'meal', 'dispose']) test(`cancellation cannot pass its local barrier after ${change} changes`, { timeout: 3000 }, async context => {
  const view = fixture(context);
  const ui = controls(context, view);
  const added = ui.add(); await tick();
  view.confirm(0); await added;
  const pending = ui.add();
  if (change === 'family') view.state.value.family.id = 'family-two';
  else if (change === 'meal') view.state.value.orders[0].status = 'completed';
  else view.autosave.dispose();
  assert.equal(await pending, false);
  assert.equal(view.requests.length, 1);
});

test('ready immediately removes an unacknowledged package and its older acknowledgement cannot restore it', { timeout: 3000 }, async context => {
  const view = fixture(context);
  const ui = controls(context, view);
  const added = ui.add(); await tick();
  const prepared = ui.ready(); await tick();
  assert.deepEqual(ui.modals, []);
  assert.equal(view.entry.actionBusy, '');
  assert.equal(view.dish().prepared, true);
  assert.equal(ui.cart.value.length, 0);
  view.confirm(0); await added;
  await tick();
  assert.equal(ui.cart.value.length, 0);
  assert.equal(view.dish().prepared, true);
  view.confirm(1); assert.equal(await prepared, true);
  assert.equal(view.entry.actionBusy, '');
});

test('rapid ready and undo preserve the latest intent even when the older request fails', { timeout: 3000 }, async context => {
  const view = fixture(context);
  const ui = controls(context, view);
  const prepared = ui.ready(); await tick();
  const undone = ui.ready(); await tick();
  assert.equal(view.dish().prepared, false);
  assert.equal(view.entry.actionBusy, '');
  view.requests[0].reject(failure('INVALID'));
  assert.equal(await prepared, false); await tick();
  assert.equal(view.entry.actionError, null);
  assert.equal(view.dish().prepared, false);
  view.confirm(1); assert.equal(await undone, true);
  assert.equal(view.dish().prepared, false);
});

test('local journal failure never displays a falsely accepted ready or package state', { timeout: 3000 }, async context => {
  const view = fixture(context, { persist: () => { throw new Error('本机存储不可用'); } });
  const ui = controls(context, view);
  assert.equal(await ui.ready(), false);
  assert.equal(view.dish().prepared, false);
  assert.equal(await ui.add(), false);
  assert.equal(ui.cart.value.length, 0);
  assert.equal(view.requests.length, 0);
  assert.match(view.entry.actionError.message, /本机存储不可用/);
});

test('uncertain older edits keep later admitted packages queued and retry the same request without duplicate writes', { timeout: 3000 }, async context => {
  const view = fixture(context);
  const ui = controls(context, view);
  view.entry.ingredients[0].quantity = '600';
  const saved = view.autosave.flush('dinner', 'tomato'); await tick();
  view.entry.ingredients[0].quantity = '800';
  const added = ui.add(); await tick();
  const original = clone(view.requests[0].payload);
  view.commit(0);
  view.requests[0].reject(failure('NETWORK'));
  await tick();
  assert.equal(view.requests.length, 1);
  assert.equal(view.status.value.operations[0].status, 'uncertain');
  assert.equal(ui.cart.value[0].dishes[0].purchaseIngredients[0].quantity, 800);
  const retried = view.queue.retry(original.requestId); await tick();
  assert.deepEqual(view.requests[1].payload, original);
  view.confirm(1); await retried; await tick();
  view.confirm(2); await tick();
  view.confirm(3); await Promise.all([saved, added]);
  assert.equal(view.writes, 3);
  assert.equal(view.status.value.operations.length, 0);
  assert.equal(view.entry.conflict, false);
  assert.equal(view.entry.error, '');
});

test('a newer full edit can replace an older rejected edit without blocking its matching ready action', { timeout: 3000 }, async context => {
  const view = fixture(context);
  const ui = controls(context, view);
  view.entry.ingredients[0].quantity = '600';
  const saved = view.autosave.flush('dinner', 'tomato'); await tick();
  view.entry.ingredients[0].quantity = '800';
  const prepared = ui.ready(); await tick();
  view.requests[0].reject(failure('INVALID'));
  await tick();
  assert.equal(view.requests[1].payload.args[2].ingredients[0].quantity, 800);
  assert.equal(view.dish().prepared, true);
  view.confirm(1); await tick();
  view.confirm(2); await Promise.all([saved, prepared]);
  assert.equal(view.dish().prepared, true);
  assert.equal(view.dish().ingredients[0].quantity, 800);
  assert.equal(view.entry.conflict, false);
  assert.equal(view.entry.error, '');
});

test('a family change during the local barrier cannot apply an old intent to a matching record in the new family', { timeout: 3000 }, async context => {
  const view = fixture(context);
  const ui = controls(context, view);
  const pending = ui.ready();
  const next = clone(view.queue.getBase());
  next.family.id = 'family-two';
  view.queue.activate(next, { scope: 'test:family-two', familyId: next.family.id, userId: next.activeMemberId, revision: 1 });
  assert.equal(await pending, false);
  assert.equal(view.dish().prepared, false);
  assert.equal(view.requests.length, 0);
});

test('real queue metadata identifies optimistic echoes without rebuilding raw inputs or inflight payloads', { timeout: 3000 }, async context => {
  const view = fixture(context);
  const row = view.entry.ingredients[0];
  row.quantity = '0600.0';
  const pending = view.autosave.flush('dinner', 'tomato');
  await tick();
  assert.equal(view.operations[0].accepted, true);
  assert.equal(view.operations[0].expectedSignature, view.dish().editSignature);
  assert.equal(view.entry.conflict, false);
  assert.equal(view.dish().ingredients[0].quantity, 600);
  row.quantity = '700'; await tick();
  row.quantity = '0800.0'; await tick();
  assert.equal(view.requests[0].payload.args[2].ingredients[0].quantity, 600);
  view.confirm(0); await tick();
  assert.equal(view.requests.length, 2);
  assert.equal(view.requests[1].payload.args[2].ingredients[0].quantity, 800);
  view.confirm(1); await pending;
  assert.equal(view.entry.ingredients[0], row);
  assert.equal(row.quantity, '0800.0');
  assert.equal(view.entry.dirty, false);
  assert.equal(view.entry.conflict, false);
});

test('uncertain retry uses the same operation and envelope without a second server mutation', { timeout: 3000 }, async context => {
  const view = fixture(context);
  view.entry.ingredients[0].quantity = '600';
  const failed = assert.rejects(view.autosave.flush('dinner', 'tomato'), /timeout/);
  await tick();
  view.commit(0);
  view.requests[0].reject(new Error('timeout'));
  await failed;
  const original = clone(view.requests[0].payload);
  const pending = view.autosave.retry('dinner', 'tomato'); await tick();
  assert.deepEqual(view.retries, [original.requestId]);
  assert.deepEqual(view.requests[1].payload, original);
  view.confirm(1); await pending;
  assert.equal(view.writes, 1);
  assert.equal(view.operations.length, 1);
  assert.equal(view.entry.error, '');
});

test('global retry after sheet disposal clears failure and coalesces the newer local draft', { timeout: 3000 }, async context => {
  const view = fixture(context);
  const sheet = effectScope();
  sheet.run(() => view.autosave.edit('dinner', 'tomato'));
  const operationId = await view.rejectFirst();
  sheet.stop();
  const row = view.entry.ingredients[0];
  row.quantity = '0800.0';
  const external = view.queue.retry(operationId); await tick();
  assert.equal(view.entry.externalSaving, true);
  view.confirm(1); await external; await tick();
  assert.equal(view.entry.error, '');
  assert.equal(view.requests.length, 3);
  assert.equal(view.requests[1].payload.requestId, operationId);
  assert.notEqual(view.requests[2].payload.requestId, operationId);
  view.confirm(2); await view.autosave.flush('dinner', 'tomato');
  assert.equal(view.autosave.edit('dinner', 'tomato'), view.entry);
  assert.equal(view.entry.ingredients[0], row);
  assert.equal(row.quantity, '0800.0');
  assert.equal(view.entry.externalSaving, false);
  await view.autosave.retry('dinner', 'tomato');
  assert.deepEqual(view.retries, []);
  assert.equal(view.status.value.operations.length, 0);
});

test('local retry and a target barrier join an ongoing global retry instead of retrying it twice', { timeout: 3000 }, async context => {
  const view = fixture(context);
  const operationId = await view.rejectFirst();
  const external = view.queue.retry(operationId);
  const retry = view.autosave.retry('dinner', 'tomato');
  let acted = false;
  const barrier = view.autosave.act('dinner', 'tomato', 'package', () => { acted = true; return true; });
  await tick();
  assert.equal(acted, false);
  assert.deepEqual(view.retries, []);
  view.confirm(1); await Promise.all([external, retry, barrier]);
  assert.equal(acted, true);
  assert.equal(view.entry.error, '');
});

test('global confirmation preserves an invalid newer draft without submitting it', { timeout: 3000 }, async context => {
  const view = fixture(context);
  const operationId = await view.rejectFirst();
  view.entry.ingredients[0].quantity = '1.';
  const external = view.queue.retry(operationId); await tick();
  view.confirm(1); await external; await tick();
  assert.equal(view.entry.error, '');
  assert.equal(view.entry.ingredients[0].quantity, '1.');
  assert.equal(view.entry.dirty, true);
  assert.equal(view.requests.length, 2);
  await assert.rejects(view.autosave.flush('dinner', 'tomato'), { code: 'PREPARATION_INVALID' });
});

test('a failed global retry stays retryable under its original uncertain operation', { timeout: 3000 }, async context => {
  const view = fixture(context);
  const operationId = await view.rejectFirst();
  const failed = assert.rejects(view.queue.retry(operationId), { code: 'INVALID' });
  await tick();
  view.requests[1].reject(failure('INVALID')); await failed; await tick();
  assert.equal(view.entry.uncertain, true);
  assert.equal(view.entry.externalSaving, false);
  assert.equal(view.entry.error, 'INVALID');
  const pending = view.autosave.retry('dinner', 'tomato'); await tick();
  assert.deepEqual(view.retries, [operationId]);
  assert.deepEqual(view.requests[2].payload, view.requests[0].payload);
  view.confirm(2); await pending;
  assert.equal(view.entry.error, '');
});

test('global discard adopts the base only when no newer raw draft exists', { timeout: 3000 }, async context => {
  const view = fixture(context);
  const original = view.entry.ingredients[0].quantity;
  const operationId = await view.rejectFirst('INVALID');
  await view.queue.discard(operationId); await tick();
  assert.equal(view.entry.ingredients[0].quantity, original);
  assert.equal(view.entry.error, '');
  assert.equal(view.entry.dirty, false);
  await view.autosave.retry('dinner', 'tomato');
  assert.equal(view.requests.length, 1);
  assert.deepEqual(view.retries, []);
});

test('global discard in the same tick as typing keeps the newer raw draft', { timeout: 3000 }, async context => {
  const view = fixture(context);
  const operationId = await view.rejectFirst('INVALID');
  const row = view.entry.ingredients[0];
  const discarded = view.queue.discard(operationId);
  row.quantity = '0800.0';
  await discarded; await tick();
  assert.equal(view.entry.ingredients[0], row);
  assert.equal(row.quantity, '0800.0');
  assert.equal(view.requests.length, 2);
  assert.notEqual(view.requests[1].payload.requestId, operationId);
  view.confirm(1); await view.autosave.flush('dinner', 'tomato');
  assert.equal(view.dish().ingredients[0].quantity, 800);
});

for (const blocked of [false, true]) test(`conflict reload discards the same ${blocked ? 'blocked' : 'rejected'} operation before adopting remote content`, { timeout: 3000 }, async context => {
  const view = fixture(context);
  if (blocked) view.queue.pause();
  view.entry.ingredients[0].quantity = '600';
  await view.autosave.dispatch('dinner', 'tomato'); await tick();
  const operationId = view.operations[0].operationId;
  view.remoteEdit(900, blocked);
  if (blocked) view.queue.resume();
  else view.requests[0].reject(failure('CONFLICT'));
  await tick();
  assert.equal(view.entry.conflict, true);
  assert.equal(view.status.value.operations[0].status, blocked ? 'blocked' : 'failed');
  await view.autosave.reload('dinner', 'tomato'); await tick();
  assert.deepEqual(view.discards, [operationId]);
  assert.equal(view.status.value.operations.length, 0);
  assert.equal(view.entry.ingredients[0].quantity, 900);
  assert.equal(view.entry.note, '家人的备注');
  assert.equal(view.entry.error, '');
  assert.equal(view.entry.conflict, false);
  assert.equal(view.entry.dirty, false);
});

test('reload never abandons uncertainty, and discard failures retain both the draft and queue reference', { timeout: 3000 }, async context => {
  const uncertain = fixture(context);
  const uncertainId = await uncertain.rejectFirst();
  await uncertain.autosave.reload('dinner', 'tomato');
  assert.deepEqual(uncertain.discards, []);
  assert.equal(uncertain.status.value.operations[0].id, uncertainId);
  assert.equal(uncertain.entry.ingredients[0].quantity, '600');
  const rejected = fixture(context, { discard: () => Promise.reject(new Error('journal write failed')) });
  const rejectedId = await rejected.rejectFirst('INVALID');
  await assert.rejects(rejected.autosave.reload('dinner', 'tomato'), /journal write failed/);
  assert.equal(rejected.status.value.operations[0].id, rejectedId);
  assert.equal(rejected.entry.ingredients[0].quantity, '600');
  const pending = rejected.autosave.retry('dinner', 'tomato'); await tick();
  assert.deepEqual(rejected.retries, [rejectedId]);
  rejected.confirm(1); await pending;
});

test('a different remote signature after global confirmation retains the newer draft as a conflict', { timeout: 3000 }, async context => {
  const view = fixture(context);
  const operationId = await view.rejectFirst();
  view.entry.ingredients[0].quantity = '800';
  const external = view.queue.retry(operationId); await tick();
  view.commit(1);
  view.remoteEdit(900);
  view.requests[1].resolve({ ...view.commit(1), snapshot: clone(view.queue.getBase()), revision: view.queue.getRevision() });
  await external; await tick();
  assert.equal(view.entry.error, '');
  assert.equal(view.entry.conflict, true);
  assert.equal(view.entry.ingredients[0].quantity, '800');
  assert.equal(view.requests.length, 2);
  await assert.rejects(view.autosave.flush('dinner', 'tomato'), { code: 'CONFLICT' });
});

test('typing during reload is retained while the rejected operation is safely discarded', { timeout: 3000 }, async context => {
  let release;
  const view = fixture(context, { discard: (queue, operationId) => new Promise(resolve => { release = async () => { await queue.discard(operationId); resolve(); }; }) });
  const operationId = await view.rejectFirst('INVALID');
  view.remoteEdit(900); await tick();
  const reloaded = view.autosave.reload('dinner', 'tomato');
  view.entry.ingredients[0].quantity = '800';
  await tick();
  assert.equal(view.requests.length, 1);
  await release(); await reloaded; await tick();
  assert.deepEqual(view.discards, [operationId]);
  assert.equal(view.status.value.operations.length, 0);
  assert.equal(view.entry.ingredients[0].quantity, '800');
  assert.equal(view.entry.conflict, true);
  await view.autosave.reload('dinner', 'tomato'); await tick();
  assert.equal(view.entry.ingredients[0].quantity, 900);
  assert.equal(view.entry.error, '');
  assert.equal(view.entry.conflict, false);
});

test('scope changes cannot mistake a hidden original-family operation for a discard', { timeout: 3000 }, async context => {
  const view = fixture(context);
  const operationId = await view.rejectFirst();
  const original = clone(view.queue.getBase());
  const other = clone(original);
  other.family.id = 'family-two';
  view.queue.activate(other, { scope: 'test:family-two', familyId: 'family-two', userId: other.activeMemberId, revision: 1 });
  await tick();
  assert.equal(view.entry.error, 'NETWORK');
  assert.equal(view.entry.ingredients[0].quantity, '600');
  assert.match(view.entry.unavailable, /家庭已切换/);
  view.queue.activate(original, { scope: 'test:family-one', familyId: 'family-one', userId: original.activeMemberId, revision: 1 });
  await tick();
  assert.equal(view.status.value.operations[0].id, operationId);
  const external = view.queue.retry(operationId); await tick();
  view.confirm(1); await external; await tick();
  assert.equal(view.entry.error, '');
  assert.equal(view.entry.dirty, false);
  assert.equal(view.entry.conflict, false);
  assert.equal(view.entry.ingredients[0].quantity, '600');
});

test('another queued dish cannot starve the retry needed to unblock the queue', { timeout: 3000 }, async context => {
  const view = fixture(context);
  const operationId = await view.rejectFirst();
  const other = view.autosave.edit('dinner', 'broccoli');
  other.ingredients[0].quantity = '900';
  const otherSaved = view.autosave.flush('dinner', 'broccoli'); await tick();
  assert.equal(view.requests.length, 1);
  const retried = view.autosave.retry('dinner', 'tomato'); await tick();
  assert.equal(view.requests[1].payload.requestId, operationId);
  view.confirm(1); await retried; await tick();
  assert.equal(view.requests[2].payload.args[1], 'broccoli');
  view.confirm(2); await otherSaved;
  assert.equal(view.status.value.operations.length, 0);
});
