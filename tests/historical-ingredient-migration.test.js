import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { digest, exactJsonCondition } from '../scripts/normalize-community-recipes.mjs';
import { requirementSignature } from '../src/domain/kitchen.js';
import { acquireHistoricalLock, historicalIngredientUpdate, makeHistoricalPlan, releaseHistoricalLock, resumeHistoricalPendingWrite, setHistoricalIngredientFields, validateHistoricalPlan, verifyHistoricalCollections } from '../scripts/normalize-historical-ingredient-snapshots.mjs';

const referenceAt = Date.parse('2026-10-27T12:00:00Z');
const target = { appid: 'test-app', env: 'test-cloud' };
const amount = { name: '盐', quantity: null, unit: '', amountText: '1勺' };
const recipe = ingredients => ({ id: 'recipe-a', title: '盐水', category: '其他', servings: 1, minutes: 5, image: '', ingredients, steps: [{ title: '拌匀', text: '加水拌匀' }] });
function order(id, date, ingredients, status = 'cancelled') {
  const value = recipe(ingredients);
  return { _id: id, familyId: 'family-a', value: { id: `order-${id}`, date, meal: '晚餐', status, memberId: 'member-a', memberName: '甲', createdAt: '2026-09-29T10:00:00Z', note: '保留备注', items: [{ quantity: 1, chosenBy: [{ id: 'member-a', name: '甲' }], recipe: structuredClone(value) }], entries: [{ id: value.id, title: value.title, kind: 'dish', quantity: 1 }], selections: [{ memberId: 'member-a', memberName: '甲', note: '', items: [{ quantity: 1, recipe: structuredClone(value) }], entries: [{ id: value.id, title: value.title, kind: 'dish', quantity: 1 }] }] } };
}
function signedBackup(data) {
  const body = { version: 1, target, referenceAt, date: '2026-10-27', sourceShareIds: data.shares.map(row => row._id).sort(), scopes: { orders: {}, shares: { _id: { $in: data.shares.map(row => row._id).sort() } }, purchases: {} }, collections: data };
  return { ...body, digest: digest(body) };
}
function fixture() {
  const historical = order('order-doc', '2026-09-29', [structuredClone(amount), { name: '水', quantity: 200, unit: 'ml' }]);
  const current = order('current-doc', '2026-10-27', [{ name: '水', quantity: 300, unit: 'ml' }], 'accepted');
  const share = { _id: 'share-doc', familyId: 'family-a', createdBy: 'member-a', createdAt: referenceAt - 100000, expiresAt: referenceAt - 100, assetIds: [], post: { id: 'post-a', recipes: [recipe([{ name: '水', quantity: null, unit: '', amountText: '半瓶' }])] } };
  const stableShare = { ...structuredClone(share), _id: 'stable-share', post: { id: 'post-b', recipes: [recipe([{ name: '水', quantity: 1, unit: '杯' }])] } };
  const purchase = { _id: 'purchase-doc', familyId: 'family-a', value: { id: 'confirmation-a', kind: 'confirmation', ...structuredClone(amount), orderIds: [historical.value.id], signature: requirementSignature(historical.value, '盐|text:1勺') } };
  const backup = signedBackup({ orders: [current, historical], shares: [share, stableShare], purchases: [purchase] });
  const plan = makeHistoricalPlan(backup, '2026-10-27T12:00:00Z');
  const projected = Object.fromEntries(Object.entries(backup.collections).map(([collection, rows]) => [collection, rows.map(row => structuredClone(plan.operations.find(op => op.collection === collection && op.documentId === row._id)?.after || row))]));
  return { backup, plan, projected, orderOperation: plan.operations.find(op => op.collection === 'orders'), shareOperation: plan.operations.find(op => op.collection === 'shares') };
}
function pendingFixture(operation, plan) {
  const prepared = historicalIngredientUpdate(operation, operation.before);
  const guard = { tool: 'cloud_db_write_doc', state: 'pending', taskId: 'original-task', target: plan.target, args: ['--action', 'update', '--collection-name', operation.collection, '--query-file', 'query.json', '--update-file', 'update.json'] };
  return { guard, readPayload: async file => structuredClone(file === 'query.json' ? prepared.query : prepared.update) };
}

test('frozen history plan changes both order copies and only original expired shares while preserving all other content', () => {
  const { backup, plan, projected, orderOperation, shareOperation } = fixture();
  const original = structuredClone(backup);
  assert.equal(plan.operations.length, 2);
  assert.deepEqual(Object.keys(orderOperation.fields), ['value.items.0.recipe.ingredients', 'value.selections.0.items.0.recipe.ingredients']);
  assert.deepEqual(Object.keys(shareOperation.fields), ['post.recipes.0.ingredients']);
  assert.deepEqual(orderOperation.after.value.items[0].recipe.ingredients, orderOperation.after.value.selections[0].items[0].recipe.ingredients);
  assert.equal(orderOperation.after.value.status, 'cancelled');
  assert.equal(orderOperation.after.value.createdAt, orderOperation.before.value.createdAt);
  assert.equal(shareOperation.after.expiresAt, shareOperation.before.expiresAt);
  assert.equal(Object.hasOwn(shareOperation.after, 'revoked'), false);
  assert.deepEqual(projected.purchases, backup.collections.purchases);
  assert.equal(plan.audit.derivedSignatures.length, 1);
  assert.equal(plan.audit.purchases[0].originalSignatureMatches, true);
  assert.equal(plan.audit.purchases[0].projectedSignatureForOldKey, '[]');
  assert.equal(makeHistoricalPlan(signedBackup(projected)).operations.length, 0);
  validateHistoricalPlan(plan, backup, plan.digest);
  assert.deepEqual(backup, original);
  const tampered = structuredClone(plan); tampered.operations[0].after.value.status = 'completed';
  assert.throws(() => validateHistoricalPlan(tampered, backup, plan.digest), /摘要/);
  const expanded = structuredClone(backup); expanded.collections.shares[0].expiresAt = referenceAt + 1;
  assert.throws(() => makeHistoricalPlan(signedBackup(expanded.collections)), /尚未失效/);
});

test('history field setter refuses business fields, purchase writes, missing paths and hidden ingredient units', () => {
  const { orderOperation: order, shareOperation: share } = fixture();
  const valid = [{ name: '盐', quantity: 1, unit: '勺' }];
  for (const field of ['value.status', 'value.items.0.quantity', 'value.preparationEdits.0.ingredients', 'value.shoppingDrafts.0.ingredients', 'value.items.9.recipe.ingredients']) assert.throws(() => setHistoricalIngredientFields('orders', order.before, { [field]: valid }));
  for (const field of ['expiresAt', 'revoked', 'post.recipes.0.title', 'post.recipes.9.ingredients']) assert.throws(() => setHistoricalIngredientFields('shares', share.before, { [field]: valid }));
  assert.throws(() => setHistoricalIngredientFields('purchases', order.before, { 'value.ingredients': valid }));
  assert.throws(() => setHistoricalIngredientFields('orders', order.before, { 'value.items.0.recipe.ingredients': [{ name: '盐', quantity: 1, unit: '小勺' }] }));
});

test('guarded update accepts only complete before or after and refuses half-copy updates and concurrent business changes', () => {
  const { orderOperation: order, shareOperation: share } = fixture();
  assert.equal(historicalIngredientUpdate(order, order.before).alreadyApplied, false);
  assert.equal(historicalIngredientUpdate(order, order.after).alreadyApplied, true);
  assert.deepEqual(historicalIngredientUpdate(order, order.before).query.$expr, exactJsonCondition('$value', order.before.value));
  assert.deepEqual(historicalIngredientUpdate(share, share.before).query.$expr, exactJsonCondition('$$ROOT', share.before));
  assert.deepEqual(historicalIngredientUpdate(share, share.before).query.revoked, { $exists: false });
  for (const mutate of [row => { row.familyId = 'other'; }, row => { row.value.status = 'accepted'; }, row => { row.value.createdAt = 'changed'; }, row => { row.value.items[0].quantity = 2; }, row => { row.value.preparedDishes = [{ recipeId: 'recipe-a', signature: 'new' }]; }, row => { row.value.shoppingDrafts = [{}]; }, row => { row.value.extra = true; }, row => { row.value.items[0].recipe.ingredients = structuredClone(order.after.value.items[0].recipe.ingredients); }]) {
    const changed = structuredClone(order.before); mutate(changed);
    assert.throws(() => historicalIngredientUpdate(order, changed));
  }
  for (const mutate of [row => { row.expiresAt += 1; }, row => { row.revoked = false; }, row => { row.familyId = 'other'; }, row => { row.post.id = 'other'; }, row => { row.assetIds.push('new-image'); }]) {
    const changed = structuredClone(share.before); mutate(changed);
    assert.throws(() => historicalIngredientUpdate(share, changed), /计划外变化/);
  }
});

test('pending resume binds original payload to frozen operation and clears only after original task success plus complete readback', async () => {
  const { plan, orderOperation } = fixture();
  const { guard, readPayload } = pendingFixture(orderOperation, plan);
  const events = []; let tick = 0;
  const result = await resumeHistoricalPendingWrite(guard, plan, {
    readPayload, now: () => tick, wait: async ms => { tick += ms; },
    queryTask: async id => { assert.equal(id, 'original-task'); events.push('poll'); return { ok: true, result: { success: true, taskId: id, status: events.length === 1 ? 'pending' : 'success' } }; },
    readback: async (collection, id) => { assert.equal(collection, 'orders'); assert.equal(id, orderOperation.documentId); events.push('readback'); return structuredClone(orderOperation.after); },
    clearGuard: async id => { assert.equal(id, 'original-task'); events.push('clear'); },
  });
  assert.equal(result.state, 'resumed_pending_verified');
  assert.deepEqual(events, ['poll', 'poll', 'readback', 'clear']);
});

test('unconfirmed pending results retain guards, and competing stale-lock resumers cannot both acquire or release each other', async () => {
  const { plan, shareOperation } = fixture();
  for (const scenario of ['no-task', 'wrong-target', 'wrong-payload', 'timeout', 'wrong-task', 'failed', 'unknown', 'wrong-readback']) {
    const { guard, readPayload } = pendingFixture(shareOperation, plan);
    let cleared = false; let tick = 0; let polls = 0;
    if (scenario === 'no-task') { delete guard.taskId; guard.state = 'outcome_unknown'; }
    if (scenario === 'wrong-target') guard.target = { ...guard.target, appid: 'other' };
    await assert.rejects(resumeHistoricalPendingWrite(guard, plan, {
      readPayload: async file => { const value = await readPayload(file); if (scenario === 'wrong-payload' && file === 'update.json') value.$set.revoked = false; return value; },
      now: () => tick, wait: async ms => { tick += ms; },
      queryTask: async id => { polls += 1; return { ok: true, result: { success: true, taskId: scenario === 'wrong-task' ? 'another-task' : id, status: scenario === 'timeout' ? 'pending' : scenario === 'failed' ? 'failed' : scenario === 'unknown' ? 'completed' : 'success' } }; },
      readback: async () => structuredClone(scenario === 'wrong-readback' ? shareOperation.before : shareOperation.after),
      clearGuard: async () => { cleared = true; },
    }), scenario);
    assert.equal(cleared, false, scenario);
    if (['no-task', 'wrong-target', 'wrong-payload'].includes(scenario)) assert.equal(polls, 0, scenario);
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'shiyuan-history-lock-'));
  try {
    await writeFile(path.join(directory, 'write.lock'), JSON.stringify({ pid: 2147483647, owner: 'dead-owner' }));
    const results = await Promise.allSettled([acquireHistoricalLock(directory, true), acquireHistoricalLock(directory, true)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const lock = results.find(result => result.status === 'fulfilled').value;
    assert.equal(JSON.parse(await readFile(lock.file, 'utf8')).owner, lock.owner);
    await assert.rejects(releaseHistoricalLock({ ...lock, owner: 'other-owner' }), /归属变化/);
    assert.equal(JSON.parse(await readFile(lock.file, 'utf8')).owner, lock.owner);
    await releaseHistoricalLock(lock);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('final validator requires unchanged confirmations, unchanged current window and untouched records plus both strict copies', () => {
  const { backup, plan, projected } = fixture();
  const result = verifyHistoricalCollections(plan, backup, projected);
  assert.equal(result.alreadyApplied, 2);
  assert.equal(result.purchasesUnchanged, true);
  assert.equal(result.currentWindowUnchanged, true);
  assert.equal(verifyHistoricalCollections(plan, backup, backup.collections, { allowBefore: true }).unapplied, 2);
  assert.throws(() => verifyHistoricalCollections(plan, backup, backup.collections), /未应用/);
  for (const mutate of [data => { data.purchases[0].value.amountText = '适量'; }, data => { data.purchases[0].value.signature = '[]'; }, data => { data.orders.pop(); }, data => { data.orders[0].value.status = 'completed'; }, data => { data.shares.find(row => row._id === 'stable-share').revoked = false; }, data => { data.orders.find(row => row._id === 'order-doc').value.selections[0].items[0].recipe.ingredients[0] = structuredClone(amount); }, data => { data.shares.find(row => row._id === 'share-doc').post.recipes[0].ingredients[0].unit = '小勺'; }]) {
    const changed = structuredClone(projected); mutate(changed);
    assert.throws(() => verifyHistoricalCollections(plan, backup, changed));
  }
});
