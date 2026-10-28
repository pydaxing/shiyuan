import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandQueue } from '../src/services/command-queue.js';
import { createCommandJournal } from '../src/services/command-journal.js';
import { createKitchenActions } from '../src/domain/actions.js';
import { createSeed } from '../src/data/seed.js';
import { clone, normalizeSnapshot } from '../src/domain/kitchen.js';
import { preparationMeals } from '../src/domain/meal-preparation.js';
import { shoppingEditSignature, wholeDishShoppingDraft } from '../src/domain/meal-shopping.js';
import { normalizeCommand } from '../server/validation.mjs';

const timestamp = Date.parse('2026-10-26T04:00:00Z');
const today = '2026-10-26';
const context = { scope: 'environment:function:me:family-1', familyId: 'family-1', userId: 'me', revision: 1 };
const failure = (code, message = code) => Object.assign(new Error(message), { code });
const tick = () => new Promise(resolve => setImmediate(resolve));

function initialSnapshot() {
  const snapshot = normalizeSnapshot(createSeed());
  snapshot.family.id = 'family-1';
  snapshot.family.features = { fridge: false, shopping: false };
  snapshot.family.members.find(member => member.id === 'me').isChef = false;
  snapshot.activeMemberId = 'me';
  snapshot.orders = [];
  snapshot.purchases = [];
  snapshot.comments = [];
  return snapshot;
}

function harness({ initial = initialSnapshot(), storage = new Map(), platform, refresh } = {}) {
  const requests = [];
  const frames = [];
  let view;
  let status;
  let server = clone(initial);
  let revision = 1;
  let sequence = 0;
  const journal = createCommandJournal({ key: 'queue-test', platform: () => platform || { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value) } });
  const queue = createCommandQueue({
    snapshot: initial, journal, now: () => timestamp, newId: () => `operation-test-${++sequence}`,
    send: payload => new Promise((resolve, reject) => requests.push({ payload, resolve, reject })),
    reconcile: async (result, id) => { queue.receive(result.snapshot, result.revision, id); },
    refresh: async () => { if (refresh) await refresh({ queue, server }); },
    onChange: value => { view = value; frames.push(clone(value)); },
    onStatus: value => { status = value; },
  });
  queue.activate(initial, context);
  function confirm(index, mutate = () => {}) {
    const request = requests[index];
    const name = request.payload.name === 'customizeFamilyWithSubtitle' ? 'customizeFamily' : request.payload.name;
    const actions = createKitchenActions({ getState: () => server, commit: value => { server = value; }, newId: prefix => `${prefix}-canonical-${++sequence}`, today: () => today, now: () => timestamp + 9000 });
    const value = actions[name](...normalizeCommand(name, request.payload.args, today)) ?? null;
    mutate(server);
    revision += 1;
    request.resolve({ snapshot: clone(server), revision, value });
  }
  return { queue, requests, frames, storage, journal, confirm, get view() { return view; }, get status() { return status; }, get server() { return server; } };
}

function withOrder() {
  let state = initialSnapshot();
  createKitchenActions({ getState: () => state, commit: next => { state = next; }, newId: () => 'order-1', today: () => today }).submitOrder({ [state.recipes[0].id]: 1 }, { date: today, meal: '晚餐' });
  return state;
}

test('dish removal is projected before the server response and survives reconciliation', async () => {
  let initial = withOrder();
  createKitchenActions({ getState: () => initial, commit: next => { initial = next; }, today: () => today }).addOrderDishes('order-1', { [initial.recipes[1].id]: 1 });
  const app = harness({ initial });
  const recipeId = initial.orders[0].items[0].recipe.id;
  const task = app.queue.enqueue('removeOrderDish', ['order-1', recipeId]);
  assert.equal(task.accepted, true);
  assert.equal(app.view.orders[0].items.length, 1);
  assert.equal(app.server.orders[0].items.length, 2);
  app.confirm(0);
  await task;
  assert.equal(app.view.orders[0].items.length, 1);
  assert.equal(app.server.orders[0].items.length, 1);
});

test('a definite removal failure restores the dish and preserves a recoverable failure', async () => {
  const initial = withOrder();
  const app = harness({ initial });
  const task = app.queue.enqueue('removeOrderDish', ['order-1', initial.orders[0].items[0].recipe.id]);
  const rejected = assert.rejects(task, /FORBIDDEN/);
  assert.equal(app.view.orders[0].status, 'cancelled');
  assert.deepEqual(app.view.orders[0].items, []);
  app.requests[0].reject(failure('FORBIDDEN'));
  await rejected;
  assert.equal(app.view.orders[0].status, 'accepted');
  assert.equal(app.view.orders[0].items.length, 1);
  assert.equal(app.status.failures.length, 1);
});

test('rapid removals serialize and an older response cannot resurrect the removed final dish', async () => {
  let initial = withOrder();
  createKitchenActions({ getState: () => initial, commit: next => { initial = next; }, today: () => today }).addOrderDishes('order-1', { [initial.recipes[1].id]: 1 });
  const app = harness({ initial });
  const [first, last] = initial.orders[0].items.map(item => item.recipe.id);
  const firstTask = app.queue.enqueue('removeOrderDish', ['order-1', first]);
  const lastTask = app.queue.enqueue('removeOrderDish', ['order-1', last]);
  assert.equal(app.view.orders[0].status, 'cancelled');
  assert.deepEqual(app.view.orders[0].items, []);
  assert.deepEqual(app.view.orders[0].selections, []);
  const frame = app.frames.length;
  app.confirm(0);
  await firstTask;
  await tick();
  assert.ok(app.frames.slice(frame).every(snapshot => snapshot.orders[0].status === 'cancelled' && snapshot.orders[0].items.length === 0 && snapshot.orders[0].selections.length === 0));
  assert.equal(app.requests.length, 2);
  app.confirm(1);
  await lastTask;
  assert.equal(app.view.orders[0].status, 'cancelled');
  assert.deepEqual(app.view.orders[0].items, []);
  assert.deepEqual(app.server.orders[0].items, []);
  assert.equal(app.status.pendingCount, 0);
});

test('admission returns a native confirmation promise with immediate immutable metadata and projection', async () => {
  const app = harness();
  const args = ['fridge', true];
  const saved = app.queue.enqueue('setFeature', args);
  args[1] = false;
  assert.ok(saved instanceof Promise);
  assert.equal(saved.accepted, true);
  assert.equal(saved.projected, true);
  assert.equal(app.view.family.features.fridge, true);
  assert.equal(app.queue.getBase().family.features.fridge, false);
  assert.deepEqual(app.requests[0].payload.args, ['fridge', true]);
  let settled = false;
  saved.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  app.confirm(0);
  await saved;
  assert.equal(app.status.pendingCount, 0);
});

test('invalid drafts are never admitted, projected, persisted or sent', async () => {
  const app = harness();
  const invalid = app.queue.enqueue('saveRecipe', [{ title: '' }]);
  assert.equal(invalid.accepted, undefined);
  await assert.rejects(invalid);
  assert.equal(app.requests.length, 0);
  assert.equal(app.storage.size, 0);
  assert.deepEqual(app.view, app.queue.getBase());
});

test('rapid commands serialize at confirmed revisions without flashing an older acknowledged value', async () => {
  const app = harness();
  const first = app.queue.enqueue('setFeature', ['fridge', true]);
  const second = app.queue.enqueue('setFeature', ['fridge', false]);
  const start = app.frames.length;
  assert.equal(app.requests.length, 1);
  assert.equal(app.view.family.features.fridge, false);
  app.confirm(0);
  await first;
  await tick();
  assert.equal(app.requests[1].payload.revision, 2);
  assert.ok(app.frames.slice(start).every(frame => frame.family.features.fridge === false));
  app.confirm(1);
  await second;
  assert.equal(app.queue.getRevision(), 3);
});

test('an older definite failure cannot roll back a later full edit of the same recipe', async () => {
  const app = harness();
  const recipe = clone(app.view.recipes[0]);
  const first = app.queue.enqueue('saveRecipe', [{ ...recipe, title: '第一次修改' }, recipe.id]);
  const rejected = assert.rejects(first, /INVALID/);
  const latest = app.queue.enqueue('saveRecipe', [{ ...recipe, title: '最后一次修改' }, recipe.id]);
  const start = app.frames.length;
  app.requests[0].reject(failure('INVALID'));
  await rejected;
  await tick();
  assert.equal(app.requests.length, 2);
  assert.ok(app.frames.slice(start).every(frame => frame.recipes.find(entry => entry.id === recipe.id).title === '最后一次修改'));
  app.confirm(1);
  await latest;
  assert.equal(app.status.failures[0].id, first.operationId);
  assert.deepEqual(app.status.failures[0].args[0].title, '第一次修改');
});

test('unrelated server conflicts rebase once without changing request ID or payload', async () => {
  const app = harness({ refresh: ({ queue }) => { const next = clone(queue.getBase()); next.family.name = '家人改了家庭名'; queue.receive(next, 7); } });
  const saved = app.queue.enqueue('setFeature', ['fridge', true]);
  const first = clone(app.requests[0].payload);
  app.requests[0].reject(failure('CONFLICT'));
  await tick();
  assert.equal(app.requests.length, 2);
  assert.deepEqual(app.requests[1].payload, { ...first, revision: 7 });
  const next = clone(app.queue.getBase());
  next.family.features.fridge = true;
  app.requests[1].resolve({ snapshot: next, revision: 8 });
  await saved;
});

test('conflicted and blocked dependent projections never hide newer family content', async () => {
  const initial = initialSnapshot();
  const recipe = clone(initial.recipes[0]);
  const app = harness({ initial, refresh: ({ queue }) => { const next = clone(queue.getBase()); next.recipes[0].title = '家人的新内容'; queue.receive(next, 8); } });
  const first = app.queue.enqueue('saveRecipe', [{ ...recipe, title: '旧草稿' }, recipe.id]);
  const failed = assert.rejects(first, /CONFLICT/);
  const second = app.queue.enqueue('saveRecipe', [{ ...recipe, title: '依赖旧草稿' }, recipe.id]);
  const blocked = assert.rejects(second, /相关内容已变化/);
  app.requests[0].reject(failure('CONFLICT'));
  await Promise.all([failed, blocked]);
  assert.equal(app.requests.length, 1);
  assert.equal(app.view.recipes[0].title, '家人的新内容');
  assert.equal(app.status.failures.find(entry => entry.id === second.operationId).status, 'blocked');
  await assert.rejects(app.queue.retry(second.operationId), /不会覆盖/);
  app.queue.receive(app.queue.getBase(), 9);
  assert.equal(app.view.recipes[0].title, '家人的新内容');
});

test('uncertainty survives restart, requires explicit retry and uses the exact original envelope', async () => {
  const app = harness();
  const first = app.queue.enqueue('setFeature', ['fridge', true]);
  const failed = assert.rejects(first, /断网/);
  app.requests[0].reject(new Error('断网'));
  await failed;
  const envelope = clone(app.requests[0].payload);
  const restarted = harness({ storage: app.storage });
  assert.equal(restarted.requests.length, 0);
  assert.equal(restarted.status.failures[0].status, 'uncertain');
  await assert.rejects(restarted.queue.discard(first.operationId), /不能放弃/);
  const retried = restarted.queue.retry(first.operationId);
  assert.equal(retried.accepted, true);
  assert.deepEqual(restarted.requests[0].payload, envelope);
  restarted.confirm(0);
  await retried;
  assert.equal(restarted.status.failures.length, 0);
});

test('an uncertain request that later fails time-dependent validation remains uncertain', async () => {
  const app = harness();
  const first = app.queue.enqueue('setFeature', ['fridge', true]);
  const failed = assert.rejects(first);
  app.requests[0].reject(new Error('timeout'));
  await failed;
  const retried = app.queue.retry(first.operationId);
  const rejected = assert.rejects(retried, /日期/);
  await tick();
  app.requests[1].reject(failure('INVALID', '日期已失效'));
  await rejected;
  assert.equal(app.status.failures[0].status, 'uncertain');
  assert.equal(app.status.failures[0].canDismiss, false);
});

test('unreadable journals are never overwritten by receive, retry, or rejected admission', async () => {
  const key = `queue-test:${encodeURIComponent(context.scope)}`;
  const storage = new Map([[key, 'corrupt original bytes']]);
  const app = harness({ storage });
  assert.equal(app.status.failures[0].id, 'journal');
  const saved = app.queue.enqueue('setFeature', ['fridge', true]);
  assert.equal(saved.accepted, undefined);
  await assert.rejects(saved, /无法读取/);
  app.queue.receive(initialSnapshot(), 2);
  await assert.rejects(app.queue.retry('journal'), /无法读取/);
  assert.equal(storage.get(key), 'corrupt original bytes');
  assert.equal(app.requests.length, 0);
  storage.set(key, JSON.stringify({ version: 1, scope: context.scope, operations: [] }));
  await app.queue.retry('journal');
  assert.equal(app.status.failures.length, 0);
});

test('storage admission failure leaves no optimistic success or network write', async () => {
  const app = harness({ platform: { getStorageSync: () => '', setStorageSync() { throw new Error('disk full'); } } });
  const saved = app.queue.enqueue('setFeature', ['fridge', true]);
  assert.equal(saved.accepted, undefined);
  await assert.rejects(saved, /保存失败/);
  assert.equal(app.view.family.features.fridge, false);
  assert.equal(app.requests.length, 0);
});

test('late responses and journals cannot cross user or family scopes', async () => {
  const app = harness();
  const saved = app.queue.enqueue('setFeature', ['fridge', true]);
  const rejected = assert.rejects(saved, /家庭或账号/);
  const next = initialSnapshot();
  next.family.id = 'family-2';
  app.queue.activate(next, { ...context, familyId: 'family-2', scope: 'environment:function:me:family-2' });
  await rejected;
  app.confirm(0);
  await tick();
  assert.equal(app.view.family.id, 'family-2');
  assert.equal(app.view.family.features.fridge, false);
  assert.equal(app.status.pendingCount, 0);
  app.queue.activate(initialSnapshot(), { ...context, userId: 'another', scope: 'environment:function:another:family-1' });
  assert.equal(app.status.failures.length, 0);
  app.queue.activate(initialSnapshot(), context);
  assert.equal(app.status.failures[0].id, saved.operationId);
  assert.equal(app.status.failures[0].status, 'uncertain');
});

test('new recipes, sets, stock and orders have stable provisional records that cannot be submitted as IDs', async () => {
  for (const name of ['saveRecipe', 'saveMealSet', 'addStock', 'submitOrder']) {
    const app = harness();
    const recipe = app.view.recipes[0];
    const args = name === 'saveRecipe' ? [{ ...recipe, title: '新菜' }] : name === 'saveMealSet' ? [{ title: '新套餐', image: '', recipeIds: app.view.recipes.slice(0, 2).map(entry => entry.id) }] : name === 'addStock' ? [{ name: '玉米', quantity: 2, unit: '根', image: '', location: '冷藏', expiresOn: '' }] : [{ [recipe.id]: 1 }, { date: today, meal: '晚餐' }];
    const field = { saveRecipe: 'recipes', saveMealSet: 'mealSets', addStock: 'inventory', submitOrder: 'orders' }[name];
    const saved = app.queue.enqueue(name, args);
    const provisional = app.view[field].find(entry => entry.pendingOperationId === saved.operationId);
    assert.equal(saved.projected, true);
    assert.match(provisional.id, /^pending-/);
    app.queue.receive(app.queue.getBase(), 1);
    assert.equal(app.view[field].find(entry => entry.pendingOperationId === saved.operationId).id, provisional.id);
    const invalid = app.queue.enqueue('removeOrder', [provisional.id]);
    assert.equal(invalid.accepted, undefined);
    await assert.rejects(invalid, /尚未同步/);
    app.confirm(0);
    await saved;
    assert.ok(app.view[field].every(entry => !entry.id.startsWith('pending-')));
    assert.equal(app.status.pendingCount, 0);
  }
});

test('existing edits preserve IDs and share IDs while meal selection preserves the original order ID', async () => {
  const app = harness({ initial: withOrder() });
  const recipe = app.view.recipes[0];
  const saved = app.queue.enqueue('saveRecipe', [{ ...recipe, title: '新菜名' }, recipe.id]);
  assert.equal(app.view.recipes[0].id, recipe.id);
  assert.equal(app.view.recipes[0].shareId, recipe.shareId);
  app.confirm(0);
  await saved;
  const selection = app.queue.enqueue('submitOrder', [{ [recipe.id]: 1 }, { date: today, meal: '晚餐' }, '新备注']);
  assert.equal(selection.projected, true);
  assert.equal(app.view.orders.length, 1);
  assert.equal(app.view.orders[0].id, 'order-1');
  await tick();
  app.confirm(1);
  await selection;
});

test('preparation projections reset readiness and acknowledgements never revert a later draft', async () => {
  const app = harness({ initial: withOrder() });
  const dish = preparationMeals(app.view, today)[0].dishes[0];
  const first = app.queue.enqueue('saveDishPreparation', ['order-1', dish.recipe.id, { ingredients: dish.ingredients, note: '少盐' }, dish.editSignature]);
  const updated = preparationMeals(app.view, today)[0].dishes[0];
  assert.equal(first.expectedSignature, updated.editSignature);
  const second = app.queue.enqueue('saveDishPreparation', ['order-1', dish.recipe.id, { ingredients: dish.ingredients, note: '最后的备注' }, updated.editSignature]);
  const start = app.frames.length;
  app.confirm(0);
  await first;
  await tick();
  assert.ok(app.frames.slice(start).every(frame => preparationMeals(frame, today)[0].dishes[0].note === '最后的备注'));
  app.confirm(1);
  await second;
  assert.equal(second.expectedSignature, preparationMeals(app.view, today)[0].dishes[0].editSignature);
});

test('shopping signatures translate only matching semantic dependencies to the confirmed timestamp echo', async () => {
  const app = harness({ initial: withOrder() });
  const dish = preparationMeals(app.view, today)[0].dishes[0];
  const draft = wholeDishShoppingDraft(dish);
  const first = app.queue.enqueue('saveShoppingDraft', ['order-1', dish.recipe.id, draft, shoppingEditSignature(app.view.orders[0], dish.recipe.id)]);
  const secondDraft = clone(draft);
  secondDraft.ingredients = secondDraft.ingredients.slice(0, 1);
  const second = app.queue.enqueue('saveShoppingDraft', ['order-1', dish.recipe.id, secondDraft, shoppingEditSignature(app.view.orders[0], dish.recipe.id)]);
  app.confirm(0);
  await first;
  await tick();
  assert.equal(app.requests[1].payload.args[3], shoppingEditSignature(app.server.orders[0], dish.recipe.id));
  assert.notEqual(app.requests[1].payload.args[3], app.status.operations.find(entry => entry.id === second.operationId).args[3]);
  app.confirm(1);
  await second;
  assert.equal(second.expectedSignature, shoppingEditSignature(app.view.orders[0], dish.recipe.id));
});

test('order deletion projects linked purchase cleanup and confirmed completion clears shopping only', async () => {
  const initial = withOrder();
  initial.purchases = [{ id: 'purchase-1', name: '番茄', quantity: 100, unit: 'g', orderIds: ['order-1'] }];
  const app = harness({ initial });
  const saved = app.queue.enqueue('removeOrder', ['order-1']);
  assert.deepEqual(app.view.orders, []);
  assert.deepEqual(app.view.purchases, []);
  assert.deepEqual(app.view.inventory, initial.inventory);
  app.confirm(0);
  await saved;
  const completed = harness({ initial });
  const done = completed.queue.enqueue('updateOrder', ['order-1', 'completed']);
  assert.equal(completed.view.orders[0].status, 'completed');
  assert.deepEqual(completed.view.purchases, []);
  completed.confirm(0);
  await done;
});

test('non-today completion is rejected before optimistic state, journal or network changes', async () => {
  for (const date of ['2026-10-25', '2026-10-27', '2026-10-28']) {
    const initial = withOrder();
    initial.orders[0].date = date;
    initial.purchases = [{ id: 'purchase-1', name: '番茄', quantity: 100, unit: 'g', orderIds: ['order-1'] }];
    const app = harness({ initial });
    const task = app.queue.enqueue('updateOrder', ['order-1', 'completed']);
    assert.notEqual(task.accepted, true);
    await assert.rejects(task, /只能当天开饭/);
    assert.deepEqual(app.view, initial);
    assert.deepEqual(app.server, initial);
    assert.deepEqual(app.requests, []);
    assert.deepEqual(app.status.operations, []);
  }
});

test('like projections are desired-state overlays, not a second toggle after refresh', async () => {
  const initial = initialSnapshot();
  initial.comments = [{ id: 'comment-1', postId: 'post-1', likes: [] }];
  const app = harness({ initial });
  const saved = app.queue.enqueue('toggleCommentLike', ['comment-1']);
  assert.deepEqual(app.view.comments[0].likes, ['me']);
  const current = clone(initial);
  current.comments[0].likes = ['me', 'another'];
  app.queue.receive(current, 1);
  assert.deepEqual(app.view.comments[0].likes, ['me', 'another']);
  app.requests[0].resolve({ snapshot: current, revision: 1 });
  await saved;
  assert.deepEqual(app.view.comments[0].likes, ['me', 'another']);
});
