import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeed } from '../src/data/seed.js';
import { createKitchenActions } from '../src/domain/actions.js';
import { normalizeSnapshot, validateSnapshot, preparationFieldErrors } from '../src/domain/kitchen.js';
import { dishPreparationSignature, ingredientListGroups, preparationEditSignature, normalizePreparationDraft, shoppingMeals, mealPreparationRequirements } from '../src/domain/meal-preparation.js';
import { normalizeCommand } from '../server/validation.mjs';

const today = '2026-10-22';
function fixture() {
  let snapshot = normalizeSnapshot(createSeed());
  snapshot.family.features = { fridge: true, shopping: true };
  snapshot.orders = [];
  snapshot.purchases = [];
  let sequence = 0;
  const actions = createKitchenActions({ getState: () => snapshot, commit: next => { validateSnapshot(next); snapshot = next; }, newId: prefix => `${prefix}-${++sequence}`, today: () => today });
  actions.submitOrder({ tomato: 1, broccoli: 1 }, { date: today, meal: '晚餐' });
  return { actions, get snapshot() { return snapshot; }, get order() { return snapshot.orders[0]; }, get dish() { return shoppingMeals(snapshot, today)[0].dishes[0]; } };
}
const draftOf = dish => structuredClone({ ingredients: dish.ingredients, note: dish.note });
const edit = (context, draft = draftOf(context.dish), signature = context.dish.editSignature) => context.actions.saveDishPreparation(context.order.id, 'tomato', draft, signature);

test('disabled ingredients are persisted rather than removed and do not count toward preparation requirements', () => {
  const context = fixture();
  const original = structuredClone(context.snapshot);
  const previousSignature = context.dish.signature;
  const draft = draftOf(context.dish);
  draft.ingredients[0].enabled = false;
  edit(context, draft);
  assert.equal(context.dish.ingredients.length, original.orders[0].items[0].recipe.ingredients.length);
  assert.deepEqual(context.dish.ingredients[0], { ...original.orders[0].items[0].recipe.ingredients[0], enabled: false });
  assert.equal(context.order.preparationEdits[0].ingredients[0].enabled, false);
  assert.notEqual(context.dish.signature, previousSignature);
  assert.ok(!mealPreparationRequirements(context.order).some(ingredient => ingredient.name === draft.ingredients[0].name));
  assert.deepEqual(context.snapshot.recipes, original.recipes);
  assert.deepEqual(context.snapshot.inventory, original.inventory);
  assert.deepEqual(context.snapshot.purchases, original.purchases);
  assert.doesNotThrow(() => validateSnapshot(normalizeSnapshot(context.snapshot)));
  const disabledSignature = context.dish.editSignature;
  const enabled = draftOf(context.dish);
  delete enabled.ingredients[0].enabled;
  edit(context, enabled, disabledSignature);
  assert.equal(context.dish.signature, previousSignature);
  assert.deepEqual(context.dish.ingredients, original.orders[0].items[0].recipe.ingredients);
  assert.throws(() => edit(context, draft, disabledSignature), /已更新/);
});

test('enabled defaults preserve existing signatures and the cloud whitelist retains only valid toggles', () => {
  const context = fixture();
  const signature = context.dish.signature;
  const draft = draftOf(context.dish);
  draft.ingredients[0].enabled = true;
  edit(context, draft);
  assert.equal(context.dish.signature, signature);
  assert.equal(context.order.preparationEdits[0].ingredients[0].enabled, undefined);
  const raw = { ...draft, ingredients: draft.ingredients.map(ingredient => ({ ...ingredient, enabled: false, section: 'seasonings', admin: true })) };
  const normalized = normalizeCommand('saveDishPreparation', [context.order.id, 'tomato', raw, context.dish.editSignature]);
  assert.ok(normalized[2].ingredients.every(ingredient => ingredient.enabled === false && ingredient.section === undefined && ingredient.admin === undefined));
  for (const enabled of ['false', 0, null, {}]) {
    const invalid = { ...draft, ingredients: [{ ...draft.ingredients[0], enabled }] };
    assert.ok(preparationFieldErrors(invalid)['ingredients.0.enabled']);
    assert.throws(() => normalizeCommand('saveDishPreparation', [context.order.id, 'tomato', invalid, context.dish.editSignature]));
  }
});

test('grouped ingredient rows keep source indexes, references and disabled seasonings', () => {
  const ingredients = [{ name: '盐', quantity: null, unit: '', amountText: '少许', enabled: false }, { name: '番茄', quantity: 200, unit: 'g' }, { name: '蒜', quantity: 2, unit: '瓣' }];
  const groups = ingredientListGroups(ingredients);
  assert.deepEqual(groups.map(group => [group.label, group.items.map(entry => entry.index)]), [['食材', [1]], ['配料', [0, 2]]]);
  assert.equal(groups[0].items[0].ingredient, ingredients[1]);
  assert.equal(groups[1].items[0].ingredient.enabled, false);
});

test('editing dish needs changes only that meal, not recipes, selections, other dishes, stock or purchases', () => {
  const context = fixture();
  context.actions.submitOrder({ tomato: 1 }, { date: today, meal: '早餐' });
  const target = context.snapshot.orders.find(order => order.meal === '晚餐');
  const original = structuredClone(context.snapshot);
  const dish = shoppingMeals(context.snapshot, today).find(order => order.id === target.id).dishes[0];
  const draft = { ingredients: [{ name: ' 西红柿 ', quantity: '600', unit: 'g' }, { name: '鸡蛋', quantity: 4, unit: '个' }, { name: '盐', quantity: null, unit: '', amountText: '少许' }], note: ' 晚上多做一点\n不要放糖 ' };
  context.actions.saveDishPreparation(target.id, 'tomato', draft, dish.editSignature);
  const current = shoppingMeals(context.snapshot, today).find(order => order.id === target.id);
  assert.equal(current.dishes[0].groups[0].items[0].amount, '600 g');
  assert.equal(current.dishes[0].groups[1].items[0].amount, '少许');
  assert.equal(current.dishes[0].note, '晚上多做一点\n不要放糖');
  assert.equal(current.dishes[1].note, '');
  for (const field of ['recipes', 'inventory', 'purchases', 'mealSets']) assert.deepEqual(context.snapshot[field], original[field]);
  for (const order of context.snapshot.orders) {
    const before = original.orders.find(item => item.id === order.id);
    assert.deepEqual(order.items, before.items);
    assert.deepEqual(order.selections, before.selections);
    if (order.id !== target.id) assert.deepEqual(order, before);
  }
  const restored = normalizeSnapshot(JSON.parse(JSON.stringify(context.snapshot)));
  assert.deepEqual(shoppingMeals(restored, today), shoppingMeals(context.snapshot, today));
  assert.equal(target.preparationEdits, undefined);
});

test('meal quantities are edited as totals and scaled once when existing legacy servings change', () => {
  const context = fixture();
  context.order.items[0].quantity = 2;
  context.order.items[0].scale = 1.5;
  const draft = draftOf(context.dish);
  draft.ingredients[0].quantity = 600;
  edit(context, draft);
  assert.equal(context.order.preparationEdits[0].quantity, 3);
  assert.equal(context.dish.ingredients[0].quantity, 600);
  assert.equal(context.dish.quantity, 3);
  context.actions.setDishPrepared(context.order.id, 'tomato', true, context.dish.signature);
  context.order.items[0].quantity = 4;
  assert.equal(context.dish.ingredients[0].quantity, 1200);
  assert.equal(context.dish.prepared, false);
  assert.equal(context.dish.quantity, 6);
});

test('changing ingredient needs clears only this dish readiness and rejects the old ready signature', () => {
  const context = fixture();
  const previous = context.dish.signature;
  context.actions.setDishPrepared(context.order.id, 'tomato', true, previous);
  const other = shoppingMeals(context.snapshot, today)[0].dishes[1];
  context.actions.setDishPrepared(context.order.id, 'broccoli', true, other.signature);
  const draft = draftOf(context.dish);
  draft.ingredients.push({ name: '小葱', quantity: 2, unit: '根' });
  assert.equal(edit(context, draft).readyReset, true);
  assert.equal(context.dish.prepared, false);
  assert.equal(shoppingMeals(context.snapshot, today)[0].dishes[1].prepared, true);
  assert.throws(() => context.actions.setDishPrepared(context.order.id, 'tomato', true, previous), /已变化/);
  context.actions.setDishPrepared(context.order.id, 'tomato', true, context.dish.signature);
  assert.equal(context.dish.prepared, true);
});

test('note-only changes and equivalent numeric values preserve readiness, while notes can be cleared', () => {
  const context = fixture();
  context.actions.setDishPrepared(context.order.id, 'tomato', true, context.dish.signature);
  const signature = context.dish.signature;
  const draft = draftOf(context.dish);
  draft.ingredients[0].quantity = String(draft.ingredients[0].quantity);
  draft.note = '少辣';
  assert.equal(edit(context, draft).readyReset, false);
  assert.equal(context.dish.signature, signature);
  assert.equal(context.dish.prepared, true);
  edit(context, { ...draftOf(context.dish), note: '' });
  assert.equal(context.dish.note, '');
  assert.equal(context.dish.prepared, true);
  assert.equal(context.order.preparationEdits.length, 1);
});

test('stale edits cannot overwrite changed notes, quantities or recipe snapshots', () => {
  const context = fixture();
  const old = context.dish.editSignature;
  edit(context, { ...draftOf(context.dish), note: '家人已修改' });
  const before = structuredClone(context.snapshot);
  assert.throws(() => edit(context, { ...draftOf(context.dish), note: '覆盖' }, old), /已更新/);
  assert.deepEqual(context.snapshot, before);
  const previous = context.dish.editSignature;
  context.order.items[0].recipe.ingredients[0].quantity += 100;
  assert.throws(() => edit(context, draftOf(context.dish), previous), /已更新/);
});

test('invalid edit values fail atomically with field-level errors and canonical units', () => {
  const context = fixture();
  const valid = draftOf(context.dish);
  for (const draft of [null, {}, { ...valid, note: null }, { ...valid, note: '字'.repeat(201) }, { ...valid, note: '\u0000' }, { ...valid, ingredients: '盐' }, { ...valid, ingredients: Array.from({ length: 31 }, () => valid.ingredients[0]) }, ...[
    { name: '', quantity: 1, unit: 'g' }, { name: '盐', quantity: '', unit: 'g' }, { name: '盐', quantity: false, unit: 'g' }, { name: '盐', quantity: null, unit: 'g' }, { name: '盐', quantity: -1, unit: 'g' }, { name: '盐', quantity: 100001, unit: 'g' }, { name: '盐', quantity: 0.0001, unit: 'g' }, { name: '盐', quantity: 1, unit: '自定义' }, { name: '盐', quantity: 1, unit: 'g', amountText: '适量' }, { name: '盐', quantity: null, unit: '', amountText: '' }, null,
  ].map(ingredient => ({ ...valid, ingredients: [ingredient] }))]) {
    const before = structuredClone(context.snapshot);
    assert.ok(Object.keys(preparationFieldErrors(draft)).length);
    assert.throws(() => edit(context, draft));
    assert.deepEqual(context.snapshot, before);
  }
  for (const unit of ['g', 'kg', '勺', '个', '小勺']) assert.doesNotThrow(() => normalizePreparationDraft({ ingredients: [{ name: '食材', quantity: 1, unit }], note: '' }));
});

test('removing all ingredients is explicit and persists without changing the original recipe', () => {
  const context = fixture();
  const original = structuredClone(context.snapshot.recipes);
  edit(context, { ingredients: [], note: '这一道只需加热' });
  assert.deepEqual(context.dish.ingredients, []);
  assert.deepEqual(context.dish.groups, []);
  assert.equal(context.dish.note, '这一道只需加热');
  assert.deepEqual(context.snapshot.recipes, original);
});

test('removing and readding a dish does not resurrect its meal-specific edits or note', () => {
  const context = fixture();
  edit(context, { ...draftOf(context.dish), note: '旧备注' });
  context.actions.submitOrder({ broccoli: 1 }, { date: today, meal: '晚餐' });
  assert.deepEqual(context.order.preparationEdits, []);
  context.actions.submitOrder({ tomato: 1, broccoli: 1 }, { date: today, meal: '晚餐' });
  assert.equal(context.dish.note, '');
});

test('closed or missing preparation cannot be edited', () => {
  for (const mutate of [context => { context.order.status = 'completed'; }, context => { context.order.status = 'cancelled'; }]) {
    const context = fixture();
    const draft = draftOf(context.dish);
    const signature = context.dish.editSignature;
    mutate(context);
    const before = structuredClone(context.snapshot);
    assert.throws(() => edit(context, draft, signature));
    assert.deepEqual(context.snapshot, before);
  }
  const context = fixture();
  assert.throws(() => context.actions.saveDishPreparation('missing', 'tomato', draftOf(context.dish), context.dish.editSignature));
  assert.throws(() => context.actions.saveDishPreparation(context.order.id, 'missing', draftOf(context.dish), context.dish.editSignature));
});

test('editing unfinished preparation remains available for old dates and a disabled fridge', () => {
  const context = fixture();
  context.order.date = '2026-10-21';
  context.snapshot.family.features = { fridge: false, shopping: false };
  const draft = draftOf(context.dish);
  draft.ingredients[0].quantity = 777;
  edit(context, draft);
  assert.equal(context.dish.ingredients[0].quantity, 777);
});

test('snapshot validation rejects malformed, duplicate and orphaned editing records', () => {
  const context = fixture();
  edit(context, { ...draftOf(context.dish), note: '有效' });
  const valid = structuredClone(context.order.preparationEdits[0]);
  for (const records of [null, {}, [valid, valid], [{ ...valid, recipeId: 'missing' }], [{ ...valid, quantity: 0 }], [{ ...valid, quantity: Infinity }], [{ ...valid, note: '字'.repeat(201) }], [{ ...valid, updatedAt: 'invalid' }], [{ ...valid, updatedBy: '' }], [{ ...valid, ingredients: [{ name: '盐', quantity: '2', unit: 'g' }] }]]) {
    const snapshot = structuredClone(context.snapshot);
    snapshot.orders[0].preparationEdits = records;
    assert.throws(() => validateSnapshot(snapshot));
  }
});

test('command normalization ignores client actor, serving factor and ingredient metadata', () => {
  const context = fixture();
  const input = { ingredients: [{ name: ' 盐 ', quantity: '2', unit: 'g', image: 'spoof', prepared: true }], note: ' 少放 ', quantity: 40, updatedBy: 'other', prepared: true };
  const args = normalizeCommand('saveDishPreparation', [context.order.id, 'tomato', input, context.dish.editSignature], today);
  assert.deepEqual(args[2], { ingredients: [{ name: '盐', quantity: 2, unit: 'g' }], note: '少放' });
  context.actions.saveDishPreparation(...args);
  assert.equal(context.order.preparationEdits[0].updatedBy, 'me');
  assert.equal(context.order.preparationEdits[0].quantity, 1);
  assert.notEqual(context.dish.editSignature, preparationEditSignature(context.order.items[0]));
  assert.notEqual(context.dish.signature, dishPreparationSignature(context.order.items[0]));
});

test('kitchen preparation totals read the same saved overrides, not the original recipe amounts', () => {
  const context = fixture();
  const draft = draftOf(context.dish);
  draft.ingredients[0].quantity = 720;
  edit(context, draft);
  const totals = mealPreparationRequirements(context.order);
  assert.equal(totals.find(ingredient => ingredient.name === draft.ingredients[0].name).quantity, 720);
  assert.deepEqual(mealPreparationRequirements(null), []);
});
