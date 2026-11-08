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

test('colliding legacy IDs from distinct families retain separate local rows and exact source membership', () => {
  const context = fixture();
  for (const familyId of ['source-a', 'source-b']) context.actions.addCollection(context.collection(familyId));
  assert.equal(context.state.recipes.length, 4);
  assert.equal(new Set(context.state.recipes.map(recipe => recipe.id)).size, 4);
  assert.equal(new Set(context.state.recipes.map(recipe => `${recipe.sourceFamilyId}:${recipe.communityRecipeId}`)).size, 4);
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

test('unchanged public imports keep their ID and only an edited private fork can be shared again', () => {
  const context = fixture();
  const original = context.collection('source-a');
  context.actions.addCollection(original);
  const copied = context.state.recipes[0];
  assert.equal(copied.id, original.recipes[0].id);
  assert.throws(() => context.actions.publishToCommunity(copied.id), error => error.code === 'ALREADY_SHARED' && /美食已有，此菜品来自美食/.test(error.message));
  const editedId = context.actions.saveRecipe({ ...copied, title: '本家调整' }, copied.id);
  assert.notEqual(editedId, copied.id);
  context.actions.publishToCommunity(editedId);
  const post = context.state.posts[0];
  assert.equal(post.familyId, 'target-family');
  assert.equal(post.familyItemId, editedId);
  assert.equal(post.recipes[0].id, editedId);
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
