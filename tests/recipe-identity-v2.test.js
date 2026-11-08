import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeed } from '../src/data/seed.js';
import { createKitchenActions } from '../src/domain/actions.js';
import { importCollection, matchesImportedSource } from '../src/domain/kitchen.js';
import { makeShare, parseShare } from '../src/domain/sharing.js';
import { canonicalRecipeId, isUnchangedCommunityRecipe, sameRecipeContent } from '../src/domain/recipe-identity.js';
import { prepareCommand, projectCommand } from '../src/services/command-projection.js';

const copy = value => structuredClone(value);
const clock = Date.parse('2026-11-08T04:00:00Z');
function publicCollection(id = 'public-post', count = 2) {
  const recipes = createSeed().recipes.slice(0, count).map((recipe, index) => ({
    ...copy(recipe), id: `public-dish-${index}`, identityVersion: 2,
    canonicalRecipeId: `public-dish-${index}`, recipeOrigin: 'community',
  }));
  return { id, sourceKind: 'community', status: 'published', familyId: 'source-family',
    kind: count > 1 ? 'menu' : 'dish', author: '原作者', title: '原始菜谱', recipes };
}
function fixture(familyId = 'destination-family') {
  const seed = createSeed();
  let state = { ...seed, family: { ...seed.family, id: familyId }, recipes: [], mealSets: [], orders: [], posts: [], comments: [], sharedItems: [] };
  let sequence = 0;
  let commits = 0;
  let failCommit = false;
  const actions = createKitchenActions({ getState: () => state, commit: next => {
    if (failCommit) throw new Error('storage full');
    commits += 1;
    state = next;
  }, newId: prefix => `${familyId}-${prefix}-${++sequence}`, today: () => '2026-11-08', now: () => clock });
  return { actions, get state() { return state; }, get commits() { return commits; },
    set failCommit(value) { failCommit = value; } };
}

test('public imports retain one canonical ID across households and different sets', () => {
  const first = publicCollection();
  const second = { ...copy(first), id: 'second-public-set', familyId: 'another-publisher', title: '另一个套餐' };
  for (const familyId of ['family-a', 'family-b', 'family-c']) {
    const context = fixture(familyId);
    context.actions.addCollection(first);
    context.actions.addCollection(second);
    context.actions.addCollection(first);
    assert.deepEqual(context.state.recipes.map(recipe => recipe.id), first.recipes.map(recipe => recipe.id));
    assert.equal(context.state.mealSets.length, 2);
    for (const set of context.state.mealSets) assert.deepEqual(set.recipeIds, first.recipes.map(recipe => recipe.id));
    for (const recipe of context.state.recipes) {
      assert.equal(canonicalRecipeId(recipe), recipe.id);
      assert.equal(recipe.recipeOrigin, 'community');
      assert.equal(recipe.identityVersion, 2);
    }
  }
});

test('opening and saving without a meaningful change preserves imported ID, audit fields and storage', () => {
  const context = fixture();
  context.actions.addCollection(publicCollection('public-post', 1));
  const before = copy(context.state);
  const original = before.recipes[0];
  const draft = { ...copy(original), title: ` ${original.title} `, servings: String(original.servings), minutes: String(original.minutes),
    id: 'forged-id', recipeOrigin: 'custom', author: 'forged author', updatedAt: clock + 5000,
    ingredients: original.ingredients.map(item => ({ ...item, name: ` ${item.name} `, quantity: String(item.quantity) })),
    steps: [...original.steps.map(step => ({ ...step, images: step.image ? [step.image] : [], image: undefined })), { title: ' ', text: ' ', images: [] }],
  };
  const commits = context.commits;
  assert.equal(context.actions.saveRecipe(draft, original.id), original.id);
  assert.equal(context.commits, commits);
  assert.deepEqual(context.state, before);
});

test('optimistic recipe editing preserves legacy portions and does not manufacture a no-op fork', () => {
  const context = fixture();
  const source = publicCollection('legacy-portions-post', 1);
  source.recipes[0].servings = 3;
  context.actions.addCollection(source);
  const original = context.state.recipes[0];
  const operation = prepareCommand(context.state, 'saveRecipe', [copy(original), original.id], { id: 'portions-operation', createdAt: clock });
  assert.deepEqual(projectCommand(context.state, operation), context.state);
  const edited = prepareCommand(context.state, 'saveRecipe', [{ ...original, title: '调整做法', servings: 99 }, original.id], { id: 'portions-edited-operation', createdAt: clock });
  const projection = projectCommand(context.state, edited);
  assert.notEqual(projection.recipes[0].id, original.id);
  assert.equal(projection.recipes[0].servings, 3);
  const creating = prepareCommand(context.state, 'saveRecipe', [{ ...copy(createSeed().recipes[0]), servings: 99 }], { id: 'portions-create-operation', createdAt: clock });
  assert.equal(projectCommand(context.state, creating).recipes[0].servings, 2);
});

test('exact generic-spoon text and numeric editor values are the same content without rewriting stored recipes', () => {
  for (const amountText of ['1匙', ' 1 匙 ', '1.0匙', '0.5匙']) {
    const context = fixture();
    const source = publicCollection('legacy-spoon-post', 1);
    source.recipes[0].ingredients = [{ name: '盐', quantity: null, unit: '', amountText }];
    context.actions.addCollection(source);
    const original = context.state.recipes[0];
    const before = copy(context.state);
    const draft = { ...original, ingredients: [{ name: '盐', quantity: parseFloat(amountText), unit: '匙' }] };
    assert.equal(sameRecipeContent(original, draft), true);
    const operation = prepareCommand(context.state, 'saveRecipe', [draft, original.id], { id: 'spoon-no-op', createdAt: clock });
    assert.deepEqual(projectCommand(context.state, operation), before);
    assert.equal(context.actions.saveRecipe(draft, original.id), original.id);
    assert.deepEqual(context.state, before);
  }
  const base = { ingredients: [{ name: '盐', quantity: 1, unit: '匙' }] };
  for (const amountText of ['1茶匙', '1汤匙', '1/2匙', '约1匙', '1匙盐', '适量', '2匙']) {
    assert.equal(sameRecipeContent(base, { ingredients: [{ name: '盐', quantity: null, unit: '', amountText }] }), false, amountText);
  }
});

const edits = {
  title: recipe => { recipe.title = '改良番茄炒蛋'; },
  category: recipe => { recipe.category = '其他'; },
  servings: recipe => { recipe.servings = 3; },
  minutes: recipe => { recipe.minutes = 18; },
  cover: recipe => { recipe.image = '/static/new-cover.png'; },
  guide: recipe => { recipe.guideImage = '/static/new-guide.png'; },
  nutrition: recipe => { recipe.nutrition = '每份约 200 千卡'; },
  ingredientName: recipe => { recipe.ingredients[0].name = '小番茄'; },
  ingredientAmount: recipe => { recipe.ingredients[0].quantity += 100; },
  textAmount: recipe => { recipe.ingredients[0] = { name: '番茄', quantity: null, unit: '', amountText: '适量' }; },
  stepTitle: recipe => { recipe.steps[0].title = '提前准备'; },
  stepText: recipe => { recipe.steps[0].text = '切成更小的块。'; },
  stepImage: recipe => { recipe.steps[0].image = '/static/new-step.png'; },
  provenance: recipe => { recipe.provenance = { source: '家人改良', url: 'https://example.com/recipe', note: '按家人口味调整' }; },
};
for (const [field, edit] of Object.entries(edits)) {
  test(`editing ${field} forks a public recipe once and later private edits retain the new ID`, () => {
    const context = fixture();
    const source = publicCollection();
    context.actions.addCollection(source);
    const original = copy(context.state.recipes[0]);
    context.actions.submitOrder({ [original.id]: 1 }, { date: '2026-11-08', meal: '晚餐' });
    const historical = copy(context.state.orders);
    const draft = copy(original);
    edit(draft);
    const id = context.actions.saveRecipe(draft, original.id);
    const saved = context.state.recipes.find(recipe => recipe.id === id);
    assert.notEqual(id, original.id);
    assert.equal(saved.recipeOrigin, 'custom');
    assert.equal(saved.communityRecipeId, undefined);
    assert.equal(saved.canonicalRecipeId, undefined);
    assert.equal(saved.publishedPostId, undefined);
    assert.equal(saved.forkedFromRecipeId, original.id);
    assert.equal(context.state.recipes.some(recipe => recipe.id === original.id), false);
    assert.ok(context.state.mealSets.every(set => set.recipeIds.includes(id) && !set.recipeIds.includes(original.id)));
    assert.deepEqual(context.state.orders, historical);
    assert.deepEqual(source.recipes[0], publicCollection().recipes[0]);
    assert.equal(context.actions.saveRecipe({ ...saved, title: `${saved.title}再调整` }, id), id);
    context.actions.addCollection(source);
    assert.ok(context.state.recipes.some(recipe => recipe.id === original.id));
    assert.ok(context.state.recipes.some(recipe => recipe.id === id));
    assert.equal(context.state.recipes.length, 3);
    assert.equal(context.state.mealSets.length, 1);
  });
}

test('an edited fork publishes under its own ID and imports elsewhere with that same ID', () => {
  const source = publicCollection('source-post', 1);
  const context = fixture();
  context.actions.addCollection(source);
  assert.throws(() => context.actions.publishToCommunity(source.recipes[0].id), error => error.code === 'ALREADY_SHARED' && error.message === '美食已有，此菜品来自美食');
  const id = context.actions.saveRecipe({ ...context.state.recipes[0], title: '我的改良做法' }, source.recipes[0].id);
  const postId = context.actions.publishToCommunity(id);
  const published = copy(context.state.posts.find(post => post.id === postId));
  assert.equal(published.recipes[0].id, id);
  assert.equal(published.recipes[0].canonicalRecipeId, id);
  assert.equal(context.state.recipes[0].recipeOrigin, 'custom');
  assert.equal(context.state.recipes[0].publishedPostId, postId);
  const other = fixture('other-family');
  other.actions.addCollection(published);
  assert.equal(other.state.recipes[0].id, id);
  assert.equal(other.state.recipes[0].recipeOrigin, 'community');
  assert.throws(() => other.actions.publishToCommunity(id), error => error.code === 'ALREADY_SHARED');
  const secondId = context.actions.saveRecipe({ ...context.state.recipes[0], title: '发布之后的另一版' }, id);
  assert.notEqual(secondId, id);
  assert.deepEqual(context.state.posts[0], published);
});

test('authors can withdraw and republish the same unchanged original without changing its ID', () => {
  const context = fixture();
  const id = context.actions.saveRecipe(createSeed().recipes[0]);
  const first = context.actions.publishToCommunity(id);
  context.actions.deleteCommunityPost(first);
  const second = context.actions.publishToCommunity(id);
  assert.notEqual(second, first);
  assert.equal(context.state.posts[0].recipes[0].id, id);
  assert.equal(context.state.recipes[0].id, id);
  assert.equal(context.state.recipes[0].recipeOrigin, 'custom');
});

test('authors importing a published set containing their own unchanged dish reuse that exact local identity', () => {
  const context = fixture();
  context.actions.addCollection(publicCollection('source-post', 1));
  const originalId = context.state.recipes[0].id;
  const id = context.actions.saveRecipe({ ...context.state.recipes[0], title: '我的改良菜' }, originalId);
  const postId = context.actions.publishToCommunity(id);
  const shared = context.state.posts.find(post => post.id === postId);
  const anotherSet = publicCollection('another-familys-set');
  anotherSet.recipes[0] = copy(shared.recipes[0]);
  anotherSet.familyId = 'other-family';
  context.actions.addCollection(anotherSet);
  assert.equal(context.state.recipes.filter(recipe => recipe.id === id).length, 1);
  assert.equal(context.state.recipes.length, 2);
  assert.equal(context.state.mealSets[0].recipeIds[0], id);
  assert.equal(context.state.recipes.find(recipe => recipe.id === id).recipeOrigin, 'custom');
});

test('private friend copies do not share catalogue identity or disappear when the public original exists', () => {
  const context = fixture();
  const source = publicCollection('public-post', 1);
  context.actions.addCollection(source);
  const portable = parseShare(makeShare(source.recipes[0], source.recipes, '朋友'));
  const friend = { ...portable, id: 'friend-12345', familyId: 'friend-family' };
  context.actions.addCollection(friend);
  const privateRecipe = context.state.recipes.find(recipe => recipe.recipeOrigin === 'custom');
  assert.ok(privateRecipe);
  assert.notEqual(privateRecipe.id, source.recipes[0].id);
  assert.equal(privateRecipe.communityRecipeId, undefined);
  assert.equal(matchesImportedSource(privateRecipe, source.recipes[0].id, source), false);
  context.actions.addCollection(friend);
  assert.equal(context.state.recipes.length, 2);
  const id = context.actions.saveRecipe({ ...privateRecipe, title: '私密副本调整' }, privateRecipe.id);
  assert.equal(id, privateRecipe.id);
});

test('legacy origins require scoped exact source content and do not trust reused bare IDs', () => {
  const source = publicCollection('legacy-post', 1);
  delete source.recipes[0].identityVersion;
  delete source.recipes[0].canonicalRecipeId;
  delete source.recipes[0].recipeOrigin;
  const original = source.recipes[0];
  const legacy = { ...copy(original), id: 'old-local-copy', sourceId: original.id };
  assert.equal(isUnchangedCommunityRecipe(legacy, [source]), false);
  assert.equal(isUnchangedCommunityRecipe({ ...legacy, sourceFamilyId: source.familyId }, [source]), true);
  assert.equal(isUnchangedCommunityRecipe({ ...legacy, sourcePostId: source.id }, [source]), true);
  assert.equal(isUnchangedCommunityRecipe({ ...legacy, sourceFamilyId: 'unrelated-family' }, [source]), false);
  assert.equal(isUnchangedCommunityRecipe({ ...legacy, sourceFamilyId: source.familyId, title: '修改过的副本' }, [source]), false);
  assert.equal(sameRecipeContent(original, { ...original, author: '新昵称', updatedAt: clock, description: '展示文案' }), true);
});

test('forged recipe identity and provenance IDs are excluded from new saves and private edits', () => {
  const context = fixture();
  const draft = { ...copy(createSeed().recipes[0]), id: 'forged-public', shareId: 'forged-public', sourceId: 'forged-source',
    sourceFamilyId: 'other-family', sourcePostId: 'other-post', publishedPostId: 'other-post',
    communityRecipeId: 'forged-public', canonicalRecipeId: 'forged-public', recipeOrigin: 'community', identityVersion: 2 };
  const id = context.actions.saveRecipe(draft);
  const saved = context.state.recipes[0];
  assert.notEqual(id, draft.id);
  assert.equal(saved.shareId, id);
  assert.equal(saved.recipeOrigin, 'custom');
  for (const field of ['sourceId', 'sourceFamilyId', 'sourcePostId', 'publishedPostId', 'communityRecipeId', 'canonicalRecipeId']) assert.equal(saved[field], undefined);
  assert.equal(context.actions.saveRecipe({ ...draft, title: '再次调整' }, id), id);
  assert.equal(context.state.recipes[0].recipeOrigin, 'custom');
});

test('a failed fork commit preserves the original recipe, current sets and old orders together', () => {
  const context = fixture();
  context.actions.addCollection(publicCollection());
  const before = copy(context.state);
  context.failCommit = true;
  assert.throws(() => context.actions.saveRecipe({ ...before.recipes[0], title: '无法保存的调整' }, before.recipes[0].id), /storage full/);
  assert.deepEqual(context.state, before);
});

test('modern duplicate canonical IDs with inconsistent source identity fail without overwriting a local recipe', () => {
  const source = publicCollection('public-post', 1);
  const local = { ...copy(source.recipes[0]), recipeOrigin: 'custom', title: '不可覆盖的私房菜' };
  assert.throws(() => importCollection([local], source), /菜品标识冲突/);
  assert.equal(local.title, '不可覆盖的私房菜');
});
