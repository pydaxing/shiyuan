import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRecipeFields, buildNormalizationPlan, digest, exactJsonCondition, guardedRecipeUpdate, verifyPendingRecipeWrite } from '../scripts/normalize-community-recipes.mjs';

function fixture() {
  const recipe = { id: 'recipe-1', title: '清蒸土豆', minutes: null, ingredients: [{ name: '土豆', quantity: 1, unit: '个' }], steps: [{ title: '', text: '土豆切块蒸熟。' }] };
  const post = { _id: 'post-1', id: 'post-1', kind: 'dish', status: 'published', familyId: 'family-a', publisherId: 'owner-a', familyItemId: 'dish-a', recipes: [recipe], card: { recipes: [{ id: recipe.id, title: recipe.title, minutes: null }] }, importedFamilyCount: 2 };
  const original = { target: { appid: 'fixture', env: 'fixture' }, collections: { posts: [post, { ...structuredClone(post), _id: 'deleted', id: 'deleted', status: 'deleted' }] } };
  const backup = { ...original, digest: digest(original) };
  const review = { index: 0, key: 'post-1/0', recipeDigest: digest(recipe), minutes: 25, stepTitles: ['切块蒸熟'], minuteReason: '备料五分钟，加热二十分钟', ingredientReason: '逐项确认食材名称、数量和单位完整' };
  return { backup, review, post };
}

test('normalization covers published recipes and keeps compact minutes consistent', () => {
  const { backup, review } = fixture();
  const plan = buildNormalizationPlan(backup, [review], []);
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].after.recipes[0].minutes, 25);
  assert.equal(plan.operations[0].after.card.recipes[0].minutes, 25);
  assert.equal(plan.operations[0].after.familyId, 'family-a');
  assert.equal(plan.operations[0].after.recipes[0].steps[0].text, '土豆切块蒸熟。');
});

test('normalization rejects missing reviews and semantic input drift', () => {
  const { backup, review } = fixture();
  assert.throws(() => buildNormalizationPlan(backup, [], []), /逐份审核/);
  assert.throws(() => buildNormalizationPlan(backup, [{ ...review, recipeDigest: 'stale' }], []), /原菜谱已变化/);
  assert.throws(() => buildNormalizationPlan(backup, [{ ...review, stepTitles: [] }], []), /数量不匹配/);
});

test('guard refuses changed ownership and changed cooking instructions', () => {
  const { backup, review, post } = fixture();
  const operation = buildNormalizationPlan(backup, [review], []).operations[0];
  assert.throws(() => guardedRecipeUpdate(operation, { ...post, familyId: 'family-b' }), /分享归属已变化/);
  const edited = structuredClone(post);
  edited.recipes[0].steps[0].text = '改成煎熟';
  assert.throws(() => guardedRecipeUpdate(operation, edited), /步骤内容已变化/);
  const ingredientEdited = structuredClone(post);
  ingredientEdited.recipes[0].ingredients[0].quantity = 9;
  assert.throws(() => guardedRecipeUpdate(operation, ingredientEdited), /未修改的配料已变化/);
});

test('card-only updates still compare the recipe used to estimate time', () => {
  const { backup, review, post } = fixture();
  const operation = buildNormalizationPlan(backup, [review], []).operations[0];
  operation.fields = { 'card.recipes.0.minutes': 25 };
  operation.after = applyRecipeFields(operation.before, operation.fields);
  const changed = structuredClone(post);
  changed.recipes[0].ingredients[0].quantity = 3;
  assert.throws(() => guardedRecipeUpdate(operation, changed), /未修改的配料已变化/);
  const timeChanged = structuredClone(post);
  timeChanged.recipes[0].minutes = 30;
  assert.throws(() => guardedRecipeUpdate(operation, timeChanged), /主菜谱时间已变化/);
});

test('guard preserves concurrent social fields and dispatches recipe/card compare conditions', () => {
  const { backup, review, post } = fixture();
  const operation = buildNormalizationPlan(backup, [review], []).operations[0];
  const current = { ...post, importedFamilyCount: 12 };
  const update = guardedRecipeUpdate(operation, current);
  assert.deepEqual(update.query.$expr.$and, [exactJsonCondition('$recipes', post.recipes), exactJsonCondition('$card.recipes', post.card.recipes)]);
  assert.equal(update.query.familyId, 'family-a');
  assert.equal(update.expected.importedFamilyCount, 12);
  assert.equal(guardedRecipeUpdate(operation, update.expected).alreadyApplied, true);
});

test('CAS refuses ambiguous dotted, operator, NUL and prototype keys', () => {
  for (const key of ['a.b', '$eq', 'a\0b', '__proto__', 'constructor', 'prototype']) {
    assert.throws(() => exactJsonCondition('$recipes', JSON.parse(JSON.stringify({ [key]: 1 }))), /字段名不安全/);
  }
  for (const value of [undefined, NaN, Infinity]) assert.throws(() => exactJsonCondition('$recipes', value), /有限 JSON/);
});

test('normalization cannot edit identity, original step body, or remove posts', () => {
  const { post } = fixture();
  for (const field of ['familyId', 'status', 'recipes.0.id', 'recipes.0.steps.0.text', 'card.familyId']) {
    assert.throws(() => applyRecipeFields(post, { [field]: 'changed' }), /禁止修改/);
  }
});

function pendingFixture(statuses = ['success']) {
  let clock = 0;
  let attempts = 0;
  const events = [];
  const expected = { _id: 'post-1', recipes: [{ minutes: 25 }] };
  const options = {
    now: () => clock,
    wait: async milliseconds => { clock += milliseconds; events.push(['wait', milliseconds]); },
    queryTask: async (taskId, timeout) => {
      events.push(['query', taskId, timeout]);
      return { ok: true, result: { success: true, taskId, status: statuses[Math.min(attempts++, statuses.length - 1)] } };
    },
    expected,
    readback: async () => { events.push(['readback']); return structuredClone(expected); },
    clearGuard: async taskId => { events.push(['clear', taskId]); },
  };
  return { options, events, elapsed: () => clock };
}

test('pending writes query only the original task and clear the guard after exact readback', async () => {
  const { options, events } = pendingFixture(['pending', 'success']);
  assert.deepEqual(await verifyPendingRecipeWrite('original-write', options), options.expected);
  assert.deepEqual(events, [
    ['wait', 5000], ['query', 'original-write', 85000],
    ['wait', 5000], ['query', 'original-write', 80000],
    ['readback'], ['clear', 'original-write'],
  ]);
});

test('pending write readback mismatch retains the guard and original task ID', async () => {
  const { options, events } = pendingFixture();
  options.readback = async () => ({ _id: 'post-1', recipes: [{ minutes: null }] });
  await assert.rejects(verifyPendingRecipeWrite('original-write', options), error => /回读不符/.test(error.message) && error.taskId === 'original-write');
  assert.equal(events.some(([event]) => event === 'clear'), false);
});

test('pending writes stop on unknown task status instead of retrying or clearing the guard', async () => {
  const { options, events } = pendingFixture(['unrecognized-state']);
  await assert.rejects(verifyPendingRecipeWrite('original-write', options), /状态未知/);
  assert.equal(events.filter(([event]) => event === 'query').length, 1);
  assert.equal(events.some(([event]) => event === 'readback' || event === 'clear'), false);
});

test('pending writes reject a different task result and leave reconciliation required', async () => {
  const { options, events } = pendingFixture();
  options.queryTask = async () => ({ ok: true, result: { success: true, taskId: 'other-write', status: 'success' } });
  await assert.rejects(verifyPendingRecipeWrite('original-write', options), /不同任务 ID/);
  assert.equal(events.some(([event]) => event === 'readback' || event === 'clear'), false);
});

test('pending writes wait at most ninety seconds without dispatching another write', async () => {
  const { options, events, elapsed } = pendingFixture(['pending']);
  await assert.rejects(verifyPendingRecipeWrite('original-write', options), error => /90秒/.test(error.message) && error.taskId === 'original-write');
  assert.equal(elapsed(), 90000);
  assert.equal(events.filter(([event]) => event === 'query').length, 17);
  assert.ok(events.filter(([event]) => event === 'wait').every(([, milliseconds]) => milliseconds === 5000));
  assert.equal(events.some(([event]) => event === 'readback' || event === 'clear'), false);
});

test('pending write query failures preserve the original task for reconciliation', async () => {
  const { options, events } = pendingFixture();
  options.queryTask = async () => { throw new Error('query transport failed'); };
  await assert.rejects(verifyPendingRecipeWrite('original-write', options), error => error.message === 'query transport failed' && error.taskId === 'original-write');
  assert.equal(events.some(([event]) => event === 'readback' || event === 'clear'), false);
});
