import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ref } from 'vue';
import { createSeed } from '../src/data/seed.js';
import { createKitchenActions } from '../src/domain/actions.js';
import { importCollection, matchesImportedSource } from '../src/domain/kitchen.js';

function fixture() {
  const seed = createSeed();
  let state = { ...seed, family: { ...seed.family, id: 'target-family' }, recipes: [], mealSets: [], posts: [], sharedItems: [] };
  let sequence = 0;
  const actions = createKitchenActions({ getState: () => state, commit: value => { state = value; }, newId: prefix => `${prefix}-${++sequence}` });
  const collection = familyId => ({ id: `post-${familyId}`, familyId, author: '同名家庭', kind: 'menu', title: '同名套餐', recipes: seed.recipes.slice(0, 2).map((recipe, index) => ({ ...structuredClone(recipe), id: `shared-${index}` })) });
  return { get state() { return state; }, actions, collection };
}

test('same recipe IDs from distinct families create independent copies and preserve exact set membership', () => {
  const context = fixture();
  for (const familyId of ['source-a', 'source-b']) context.actions.addCollection(context.collection(familyId));
  assert.equal(context.state.recipes.length, 4);
  assert.equal(new Set(context.state.recipes.map(recipe => recipe.id)).size, 4);
  assert.equal(new Set(context.state.recipes.map(recipe => recipe.shareId)).size, 4);
  assert.equal(context.state.mealSets.length, 2);
  for (const set of context.state.mealSets) {
    assert.ok(set.shareId);
    const recipes = set.recipeIds.map(id => context.state.recipes.find(recipe => recipe.id === id));
    assert.ok(recipes.every(recipe => recipe.sourceFamilyId === set.sourceFamilyId));
    assert.ok(recipes.every(recipe => recipe.sourcePostId === set.sourcePostId));
  }
  context.actions.addCollection(context.collection('source-a'));
  assert.equal(context.state.recipes.length, 4);
  assert.equal(context.state.mealSets.length, 2);
});

test('resharing a copied recipe uses the target household and its independent share identity', () => {
  const context = fixture();
  const original = context.collection('source-a');
  context.actions.addCollection(original);
  const copied = context.state.recipes[0];
  context.actions.publishToCommunity(copied.id);
  const post = context.state.posts[0];
  assert.equal(post.familyId, 'target-family');
  assert.equal(post.familyItemId, copied.id);
  assert.equal(post.recipes[0].id, copied.shareId);
  assert.notEqual(post.recipes[0].id, original.recipes[0].id);
  assert.equal(post.recipes[0].sourceFamilyId, undefined);
  copied.ingredients[0].name = '本家调整';
  assert.notEqual(original.recipes[0].ingredients[0].name, '本家调整');
});

test('unscoped legacy imports cannot silently stand in for a named source household', () => {
  const context = fixture();
  const post = context.collection('source-a');
  const legacy = { ...post.recipes[0], id: 'import-shared-0', sourceId: 'shared-0', author: post.author };
  assert.equal(matchesImportedSource(legacy, 'shared-0', post), false);
  const copies = importCollection([legacy], post);
  assert.equal(copies.length, 3);
  assert.equal(copies[1].sourceFamilyId, 'source-a');
  assert.notEqual(copies[1].id, legacy.id);
});

test('community joined state never treats another family’s reused local IDs as its own original recipe', () => {
  const source = readFileSync(new URL('../src/components/CommunityView.vue', import.meta.url), 'utf8');
  const declaration = source.slice(source.indexOf('const imported ='), source.indexOf('\nasync function open(post)'));
  const state = ref({ family: { id: 'home-a' }, recipes: [{ id: 'same-local-id' }], mealSets: [{ id: 'same-set-id' }] });
  const imported = new Function('state', 'matchesImportedSource', `${declaration}; return imported;`)(state, matchesImportedSource);
  for (const [kind, familyItemId] of [['dish', 'same-local-id'], ['menu', 'same-set-id']]) {
    const post = { id: 'foreign-post', familyId: 'home-b', kind, familyItemId, recipes: [{ id: 'source-recipe' }] };
    assert.equal(imported(post), false);
    assert.equal(imported({ ...post, familyId: 'home-a' }), true);
  }
});
