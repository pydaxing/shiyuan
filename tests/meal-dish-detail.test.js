import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApplication } from '../server/application.mjs';
import { memoryRepository } from './helpers/memory-repository.js';

const hash = text => createHash('sha256').update(text).digest('hex');
const postId = `meal-${hash('dish-post')}`;
const spaceId = 'family-source';
const orderId = 'dinner-order';
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
async function fixture(patch = {}) {
  const repository = memoryRepository();
  for (const who of ['alice', 'bob', 'stranger']) {
    const familyId = who === 'stranger' ? 'family-stranger' : spaceId;
    await repository.set('users', hash(who), { familyId, familyIds: [familyId], name: who });
  }
  await repository.set('families', spaceId, { id: spaceId, name: 'Source family', members: ['alice', 'bob'].map(name => ({ id: hash(name), name })) });
  await repository.set('families', 'family-stranger', { id: 'family-stranger', name: 'Other family', members: [{ id: hash('stranger'), name: 'Stranger' }] });
  const recipe = { id: 'dish-one', title: '番茄炒蛋', category: '素菜', image: '/static/tomato.png', minutes: 12, servings: 2, nutrition: '家常一餐',
    ingredients: [{ name: '番茄', quantity: 2, unit: '个', internalPrice: 'hidden' }],
    steps: [{ title: '下锅', text: '炒熟即可', images: ['/static/step-cook.png', 'cloud://env/private-step'], note: 'hidden' }],
    privateNotes: 'secret-recipe-notes', memberId: 'secret-member', shareId: 'secret-share' };
  const order = { id: orderId, date: '2026-11-05', meal: '晚餐', status: 'completed', memberId: hash('alice'), memberName: 'Alice', notes: 'secret-order-notes', items: [{ recipe, quantity: 1 }] };
  await repository.set('orders', hash(`${spaceId}:${orderId}`), { familyId: spaceId, value: order });
  const post = { id: postId, spaceId, orderId, authorId: hash('alice'), kind: 'plan', title: '晚餐这样搭配', date: order.date, meal: order.meal,
    createdAt: 1793870000000, status: 'published', visibility: 'public', author: { mode: 'family', name: 'Source family', avatar: '' },
    images: [], dishes: [{ title: recipe.title, image: '' }], assetIds: [], ...patch };
  await repository.set('meal_posts', postId, post);
  const imageReads = [];
  const errors = [];
  const app = createApplication({ repository, now: () => 1793870000000, onError: error => errors.push(error.message), readImage: async (fileId, media, variant) => {
    imageReads.push({ fileId, variant });
    return { base64: 'cGhvdG8=', contentType: 'image/jpeg' };
  } });
  const call = (action, payload = {}, who = 'stranger') => app({ action, ...payload }, { OPENID: who });
  const detail = (who = 'stranger', payload = {}) => call('mealDishDetail', { postId, dishIndex: 0, ...payload }, who);
  return { repository, recipe, order, post, call, detail, imageReads, errors };
}

async function setRecipe(f, patch) {
  const order = { ...f.order, items: [{ ...f.order.items[0], recipe: { ...f.recipe, ...patch } }] };
  await f.repository.set('orders', hash(`${spaceId}:${orderId}`), { familyId: spaceId, value: order });
}

async function addMedia(f, fileId, patch = {}) {
  await f.repository.set('media', hash(fileId), { fileId, confirmed: true, familyId: spaceId, userId: hash('alice'), ...patch });
}

async function publicAssets(f, assetIds, id = 'published-recipe') {
  await f.repository.set('posts', id, { id, status: 'published', assetIds });
}

async function assertDelivered(f, fileId, who = 'stranger') {
  const content = await f.call('mediaContent', { fileId, variant: 'original' }, who);
  assert.equal(content.ok, true, JSON.stringify({ content, errors: f.errors }));
  assert.equal(content.data.contentType, 'image/jpeg');
  const batch = ok(await f.call('mediaBatch', { images: [{ fileId, variant: 'detail' }] }, who));
  assert.equal(batch.images[0].ok, true, JSON.stringify(batch));
  assert.equal(batch.images[0].data.contentType, 'image/jpeg');
}

async function assertDenied(f, fileId, who = 'stranger') {
  assert.equal((await f.call('mediaContent', { fileId, knownVersion: fileId }, who)).code, 'FORBIDDEN');
  const batch = ok(await f.call('mediaBatch', { images: [{ fileId, variant: 'detail', knownVersion: `${fileId}#display-detail-v1` }] }, who));
  assert.equal(batch.images[0].code, 'FORBIDDEN');
}

test('legacy plan recovers ID and existing static art from its exact order without rewriting records', async () => {
  const f = await fixture();
  const before = await f.repository.get('meal_posts', postId);
  const result = ok(await f.call('mealFeed', { spaceId: 'family-stranger' })).posts[0];
  assert.equal(result.dishes[0].recipeId, 'dish-one');
  assert.equal(result.dishes[0].image, '/static/tomato.png');
  assert.equal(result.dishes[0].sourceKind, 'custom');
  assert.deepEqual(result.images, ['/static/tomato.png']);
  assert.deepEqual(await f.repository.get('meal_posts', postId), before);
  assert.equal('ingredients' in result.dishes[0], false);
});

test('new canonical imports keep their community badge without exposing provenance fields or changing image authorization', async () => {
  const f = await fixture();
  await setRecipe(f, { identityVersion: 2, recipeOrigin: 'community', communityRecipeId: f.recipe.id, sourceFamilyId: 'secret-source-family', sourcePostId: 'secret-source-post' });
  const before = await f.repository.get('meal_posts', postId);
  const result = ok(await f.call('mealFeed', { spaceId: 'family-stranger' })).posts[0];
  assert.equal(result.dishes[0].sourceKind, 'community');
  assert.equal(result.dishes[0].recipeId, f.recipe.id);
  assert.deepEqual(Object.keys(result.dishes[0]).sort(), ['recipeId', 'title', 'image', 'sourceKind', 'communityPostId'].sort());
  assert.equal(JSON.stringify(result).includes('secret-source'), false);
  assert.equal('sourceLabel' in ok(await f.detail()).recipe, false);
  assert.deepEqual(await f.repository.get('meal_posts', postId), before);
});

test('an edited fork remains custom despite its attribution to a public original, then follows its own publication and withdrawal', async () => {
  const f = await fixture();
  const patch = { identityVersion: 2, recipeOrigin: 'custom', forkedFromRecipeId: 'public-original', sourceId: 'public-original', sourceFamilyId: 'another-family', sourcePostId: 'original-post' };
  await setRecipe(f, patch);
  await f.repository.set('posts', 'original-post', { status: 'published', familyId: 'another-family', familyItemId: 'public-original', recipes: [{ id: 'public-original' }] });
  const badge = async () => ok(await f.call('mealFeed', { spaceId: 'family-stranger' })).posts[0].dishes[0].sourceKind;
  assert.equal(await badge(), 'custom');
  assert.equal(ok(await f.detail()).recipe.sourceLabel, '家庭创建菜品 · 暂未发布到美食');
  const published = { status: 'published', familyId: spaceId, familyItemId: f.recipe.id, familyKind: 'dish', recipes: [{ id: f.recipe.id, canonicalRecipeId: f.recipe.id }] };
  await f.repository.set('posts', 'published-fork', published);
  assert.equal(await badge(), 'community');
  assert.equal('sourceLabel' in ok(await f.detail()).recipe, false);
  await f.repository.set('posts', 'published-fork', { ...published, status: 'deleted' });
  assert.equal(await badge(), 'custom', 'provenance lookup cache must not outlive a response');
  assert.equal(ok(await f.detail()).recipe.sourceLabel, '家庭创建菜品 · 暂未发布到美食');
});

test('explicit origin belongs to the recorded snapshot even when a current recipe with the same ID has the opposite origin', async () => {
  for (const origin of ['community', 'custom']) {
    const f = await fixture();
    await setRecipe(f, { identityVersion: 2, recipeOrigin: origin, ...(origin === 'community' ? { communityRecipeId: f.recipe.id } : { forkedFromRecipeId: 'original' }) });
    await f.repository.set('recipes', hash(`${spaceId}:${f.recipe.id}`), { familyId: spaceId, value: {
      ...f.recipe, title: '之后编辑的新标题', identityVersion: 2, recipeOrigin: origin === 'community' ? 'custom' : 'community',
      ...(origin === 'community' ? { forkedFromRecipeId: 'original' } : { communityRecipeId: f.recipe.id }),
    } });
    assert.equal(ok(await f.call('mealFeed', { spaceId: 'family-stranger' })).posts[0].dishes[0].sourceKind, origin, origin);
  }
});

test('legacy imported provenance needs the exact published recipe ID and source family, never a private friend share or just a name', async () => {
  for (const scenario of ['matched', 'wrong-id', 'wrong-family', 'friend', 'withdrawn']) {
    const f = await fixture();
    await setRecipe(f, { sourceId: 'source-recipe', sourceFamilyId: 'source-family', sourcePostId: 'source-post' });
    const published = { status: scenario === 'withdrawn' ? 'deleted' : 'published', familyId: scenario === 'wrong-family' ? 'another-family' : 'source-family',
      title: f.recipe.title, image: f.recipe.image, recipes: [{ ...f.recipe, id: scenario === 'wrong-id' ? 'different-recipe' : 'source-recipe' }] };
    await f.repository.set(scenario === 'friend' ? 'shares' : 'posts', 'source-post', scenario === 'friend' ? { post: published } : published);
    assert.equal(ok(await f.call('mealFeed', { spaceId: 'family-stranger' })).posts[0].dishes[0].sourceKind, scenario === 'matched' ? 'community' : 'custom', scenario);
  }
});

test('legacy imports edited in place are custom even if their original source ID, family and post links remain', async () => {
  for (const change of [
    { title: '改良番茄炒蛋' },
    { ingredients: [{ name: '鸡蛋', quantity: 4, unit: '个' }] },
    { steps: [{ title: '换个做法', text: '改用蒸的' }] },
    { image: '/static/new-cover.png' },
  ]) {
    const f = await fixture({ dishes: [{ recipeId: 'dish-one', title: change.title || '番茄炒蛋', image: '' }] });
    await setRecipe(f, { ...change, sourceId: 'source-recipe', sourceFamilyId: 'source-family', sourcePostId: 'source-post' });
    await f.repository.set('posts', 'source-post', { status: 'published', familyId: 'source-family', recipes: [{ ...f.recipe, id: 'source-recipe' }] });
    assert.equal(ok(await f.call('mealFeed', { spaceId: 'family-stranger' })).posts[0].dishes[0].sourceKind, 'custom', JSON.stringify(change));
  }
});

test('legacy provenance compares the meal snapshot rather than a later in-place edit in the family menu', async () => {
  const f = await fixture();
  const source = { sourceId: 'source-recipe', sourceFamilyId: 'source-family', sourcePostId: 'source-post' };
  await setRecipe(f, source);
  await f.repository.set('posts', 'source-post', { status: 'published', familyId: 'source-family', recipes: [{ ...f.recipe, id: 'source-recipe' }] });
  await f.repository.set('recipes', hash(`${spaceId}:${f.recipe.id}`), { familyId: spaceId, value: {
    ...f.recipe, ...source, title: '之后修改的菜名', identityVersion: 2, recipeOrigin: 'custom', forkedFromRecipeId: 'source-recipe',
  } });
  assert.equal(ok(await f.call('mealFeed', { spaceId: 'family-stranger' })).posts[0].dishes[0].sourceKind, 'community');
});

test('legacy source-family fallback also requires matching content and cannot replace a known private friend share', async () => {
  for (const scenario of ['unchanged', 'edited', 'friend', 'missing-content']) {
    const f = await fixture();
    await setRecipe(f, { sourceId: 'source-recipe', sourceFamilyId: 'source-family', ...(scenario === 'friend' ? { sourcePostId: 'friend-copy' } : {}),
      ...(scenario === 'edited' ? { ingredients: [] } : {}) });
    await f.repository.set('posts', 'another-public-post', { status: 'published', familyId: 'source-family',
      recipes: [{ ...(scenario === 'missing-content' ? {} : f.recipe), id: 'source-recipe' }] });
    assert.equal(ok(await f.call('mealFeed', { spaceId: 'family-stranger' })).posts[0].dishes[0].sourceKind,
      scenario === 'unchanged' ? 'community' : 'custom', scenario);
  }
});

test('a source label on a name-only dish uses the same classification without adding a default or current private cover', async () => {
  const f = await fixture();
  await setRecipe(f, { image: '', identityVersion: 2, recipeOrigin: 'community' });
  await f.repository.set('recipes', hash(`${spaceId}:${f.recipe.id}`), { familyId: spaceId, value: { ...f.recipe, image: 'cloud://private-current-cover' } });
  const post = ok(await f.call('mealFeed', { spaceId: 'family-stranger' })).posts[0];
  assert.equal(post.dishes[0].sourceKind, 'community');
  assert.equal(post.dishes[0].image, '');
  assert.deepEqual(post.images, []);
  assert.deepEqual((await f.repository.get('meal_posts', postId)).assetIds, []);
});

test('an unresolved meal snapshot cannot inherit a detail link from stored labels or a current same-ID menu recipe', async () => {
  const f = await fixture({ dishes: [{ recipeId: 'dish-one', title: '番茄炒蛋', image: '/static/tomato.png', sourceKind: 'community' }] });
  await f.repository.remove('orders', hash(`${spaceId}:${orderId}`));
  await f.repository.set('recipes', hash(`${spaceId}:${f.recipe.id}`), { familyId: spaceId, value: { ...f.recipe, identityVersion: 2, recipeOrigin: 'community' } });
  const dish = ok(await f.call('mealFeed', { spaceId: 'family-stranger' })).posts[0].dishes[0];
  assert.equal(Object.hasOwn(dish, 'sourceKind'), false);
  assert.equal(dish.image, '/static/tomato.png');
  assert.equal((await f.detail()).code, 'NOT_FOUND');
});

test('repeated meals reuse provenance reads for the same scoped recipe within one feed response', async () => {
  const f = await fixture();
  await f.repository.set('meal_posts', `meal-${hash('second-post')}`, { ...f.post, id: `meal-${hash('second-post')}` });
  const reads = [];
  const get = f.repository.get, list = f.repository.list;
  f.repository.get = (...args) => { if (args[0] === 'recipes') reads.push(`get:${args[1]}`); return get(...args); };
  f.repository.list = (...args) => { if (args[0] === 'posts') reads.push(`list:${JSON.stringify(args[1])}`); return list(...args); };
  const result = ok(await f.call('mealFeed', { spaceId: 'family-stranger' }));
  assert.equal(result.posts.length, 2);
  assert.equal(reads.filter(item => item.startsWith('get:')).length, 1);
  assert.equal(new Set(reads).size, reads.length, 'identical publication lookups should be shared, including concurrent posts');
});

test('meal detail exposes the recipe snapshot allowlist, excluding order and private media fields', async () => {
  const f = await fixture();
  const { recipe } = ok(await f.detail());
  assert.equal(recipe.id, 'dish-one');
  assert.equal(recipe.title, '番茄炒蛋');
  assert.equal(recipe.ingredients[0].name, '番茄');
  assert.deepEqual(recipe.steps[0].images, ['/static/step-cook.png']);
  assert.deepEqual(Object.keys(recipe).sort(), ['id', 'title', 'image', 'category', 'minutes', 'servings', 'nutrition', 'ingredients', 'steps', 'sourceLabel'].sort());
  assert.equal(JSON.stringify(recipe).includes('secret'), false);
  assert.equal(JSON.stringify(recipe).includes('private-step'), false);
  assert.equal('internalPrice' in recipe.ingredients[0], false);
  assert.equal('note' in recipe.steps[0], false);
});

test('unpublished legacy household recipes get a neutral source label while their existing cover stays visible', async () => {
  const f = await fixture();
  await f.repository.set('recipes', hash(`${spaceId}:${f.recipe.id}`), { familyId: spaceId, value: { ...f.recipe, tag: '家庭私房菜' } });
  const beforeOrder = await f.repository.get('orders', hash(`${spaceId}:${orderId}`));
  const beforeRecipe = await f.repository.get('recipes', hash(`${spaceId}:${f.recipe.id}`));
  const result = ok(await f.detail()).recipe;
  assert.equal(result.sourceLabel, '家庭菜品 · 暂未发布到美食');
  assert.equal(result.image, '/static/tomato.png');
  assert.deepEqual(await f.repository.get('orders', hash(`${spaceId}:${orderId}`)), beforeOrder);
  assert.deepEqual(await f.repository.get('recipes', hash(`${spaceId}:${f.recipe.id}`)), beforeRecipe);
});

test('only creation audit fields from the exact recipe or its order snapshot justify the creation label', async () => {
  for (const location of ['current', 'snapshot', 'foreign-scope', 'wrong-id', 'updated-only']) {
    const f = await fixture();
    const audit = { createdBy: hash('alice'), createdAt: 1793860000000 };
    if (location === 'snapshot') await setRecipe(f, audit);
    else await f.repository.set('recipes', hash(`${spaceId}:${f.recipe.id}`), {
      familyId: location === 'foreign-scope' ? 'another-family' : spaceId,
      value: { ...f.recipe, ...(location === 'updated-only' ? { updatedBy: hash('alice'), updatedAt: 1793860000000, tag: '家庭私房菜' } : audit), ...(location === 'wrong-id' ? { id: 'different-recipe' } : {}) },
    });
    assert.equal(ok(await f.detail()).recipe.sourceLabel,
      ['current', 'snapshot'].includes(location) ? '家庭创建菜品 · 暂未发布到美食' : '家庭菜品 · 暂未发布到美食', location);
  }
});

test('personal meal sources use personal wording and do not relabel the same family meal for an outside reader', async () => {
  const f = await fixture({ mealContext: 'personal', author: { mode: 'family', name: 'Legacy snapshot', avatar: '' } });
  assert.equal(ok(await f.detail()).recipe.sourceLabel, '个人菜品 · 暂未发布到美食');
  await setRecipe(f, { createdBy: hash('alice'), createdAt: 1793860000000 });
  assert.equal(ok(await f.detail()).recipe.sourceLabel, '个人创建菜品 · 暂未发布到美食');
  const familyMeal = await fixture({ mealContext: 'family', author: { mode: 'personal', name: 'Legacy snapshot', avatar: '' } });
  assert.equal(ok(await familyMeal.detail()).recipe.sourceLabel, '家庭菜品 · 暂未发布到美食');
});

test('a current published dish suppresses the unpublished label by stable household recipe ID after edits', async () => {
  const f = await fixture();
  await f.repository.set('recipes', hash(`${spaceId}:${f.recipe.id}`), { familyId: spaceId, value: { ...f.recipe, shareId: 'new-shared-version' } });
  const published = { id: 'public-same-dish', status: 'published', familyId: spaceId, familyItemId: f.recipe.id, familyKind: 'dish', recipes: [{ id: 'old-shared-version' }] };
  await f.repository.set('posts', published.id, published);
  assert.equal('sourceLabel' in ok(await f.detail()).recipe, false);
  for (const status of ['hidden', 'deleted']) {
    await f.repository.set('posts', published.id, { ...published, status });
    assert.equal(ok(await f.detail()).recipe.sourceLabel, '家庭菜品 · 暂未发布到美食', status);
  }
});

test('published sets and legacy dishes match only exact current or snapshotted shared recipe IDs in the same household', async () => {
  for (const version of ['snapshot', 'current', 'legacy-id']) {
    const f = await fixture();
    if (version === 'legacy-id') await setRecipe(f, { shareId: '' });
    await f.repository.set('recipes', hash(`${spaceId}:${f.recipe.id}`), { familyId: spaceId, value: { ...f.recipe, shareId: version === 'legacy-id' ? '' : 'new-shared-version' } });
    const sharedId = version === 'snapshot' ? f.recipe.shareId : version === 'current' ? 'new-shared-version' : f.recipe.id;
    await f.repository.set('posts', 'published-set', { id: 'published-set', status: 'published', familyId: spaceId, familyItemId: 'set-123', familyKind: 'set', kind: 'menu', recipes: [{ id: 'another-dish' }, { id: sharedId }] });
    assert.equal('sourceLabel' in ok(await f.detail()).recipe, false, version);
  }
});

test('same names, covers, other households, set IDs, and friend shares do not pretend a household dish is published', async () => {
  const f = await fixture();
  await f.repository.set('posts', 'same-name-cover', { status: 'published', familyId: spaceId, familyItemId: 'another-dish', familyKind: 'dish', title: f.recipe.title, image: f.recipe.image, recipes: [{ id: 'unrelated-shared-id' }] });
  await f.repository.set('posts', 'foreign-shared-id', { status: 'published', familyId: 'another-family', familyItemId: f.recipe.id, familyKind: 'dish', recipes: [{ id: f.recipe.shareId }] });
  await f.repository.set('posts', 'same-set-id', { status: 'published', familyId: spaceId, familyItemId: f.recipe.id, familyKind: 'set', kind: 'menu', recipes: [{ id: 'unrelated-set-dish' }] });
  await f.repository.set('shares', 'private-friend-share', { familyId: spaceId, post: { familyId: spaceId, familyItemId: f.recipe.id, recipes: [{ id: f.recipe.shareId }] } });
  assert.equal(ok(await f.detail()).recipe.sourceLabel, '家庭菜品 · 暂未发布到美食');
});

test('imported recipes and incomplete source links never become household creations even after local editing or source deletion', async () => {
  for (const field of ['sourceId', 'sourcePostId', 'sourceFamilyId']) {
    for (const location of ['snapshot', 'current']) {
      const f = await fixture();
      const imported = { ...f.recipe, [field]: 'imported-source', createdBy: hash('alice'), createdAt: 1793860000000, tag: '家庭私房菜' };
      if (location === 'snapshot') await setRecipe(f, imported);
      else await f.repository.set('recipes', hash(`${spaceId}:${f.recipe.id}`), { familyId: spaceId, value: imported });
      await f.repository.set('posts', 'imported-source', { status: 'deleted', familyId: 'source-family', recipes: [{ id: 'imported-source' }] });
      assert.equal('sourceLabel' in ok(await f.detail()).recipe, false, `${field}:${location}`);
    }
  }
});

test('source metadata reads do not copy a newly added current private cover into an old meal snapshot', async () => {
  const f = await fixture();
  await setRecipe(f, { image: '' });
  const fileId = 'cloud://env/current-only-private-cover';
  await addMedia(f, fileId);
  await f.repository.set('recipes', hash(`${spaceId}:${f.recipe.id}`), { familyId: spaceId, value: { ...f.recipe, image: fileId } });
  const result = ok(await f.detail()).recipe;
  assert.equal(result.image, '');
  assert.equal(result.sourceLabel, '家庭菜品 · 暂未发布到美食');
  await assertDenied(f, fileId);
  assert.deepEqual((await f.repository.get('meal_posts', postId)).assetIds, []);
});

test('detail preserves numeric strings and literal legacy amounts without inventing zero quantities', async () => {
  const f = await fixture();
  const ingredients = [
    { name: '番茄', quantity: '200', unit: 'g' },
    { name: '盐', quantity: null, unit: '', amountText: '少许' },
    { name: '蒜', amount: '一小瓣' },
    { name: '姜', quantity: '半', unit: '块' },
    { name: '水', quantity: '', unit: 'ml' },
    { name: '糖', quantity: null, unit: 'g' },
  ];
  await f.repository.set('orders', hash(`${spaceId}:${orderId}`), { familyId: spaceId, value: { ...f.order, items: [{ recipe: { ...f.recipe, ingredients } }] } });
  assert.deepEqual(ok(await f.detail()).recipe.ingredients, [
    { name: '番茄', quantity: 200, unit: 'g' },
    { name: '盐', quantity: null, unit: '', amountText: '少许' },
    { name: '蒜', quantity: null, unit: '', amountText: '一小瓣' },
    { name: '姜', quantity: null, unit: '', amountText: '半 块' },
    { name: '水', quantity: null, unit: 'ml' },
    { name: '糖', quantity: null, unit: 'g' },
  ]);
  assert.deepEqual((await f.repository.get('orders', hash(`${spaceId}:${orderId}`))).value.items[0].recipe.ingredients, ingredients);
});

test('detail uses an independent bounded read rate without changing the meal record', async () => {
  const f = await fixture();
  const before = await f.repository.get('meal_posts', postId);
  const bucket = Math.floor(1793870000000 / 60000);
  await f.repository.set('rate_limits', hash(`${hash('stranger')}:mealDishDetail:${bucket}`), { count: 119 });
  ok(await f.detail());
  assert.equal((await f.detail()).code, 'RATE_LIMIT');
  assert.deepEqual(await f.repository.get('meal_posts', postId), before);
});

test('detail follows current meal visibility for outsiders, household members, author and deletion', async () => {
  const f = await fixture({ mealSharingVersion: 2, mealContext: 'family', participantUserIds: [hash('alice'), hash('bob')], visibility: 'family' });
  assert.equal((await f.detail()).code, 'NOT_FOUND');
  ok(await f.detail('bob'));
  await f.repository.set('meal_posts', postId, { ...f.post, visibility: 'private' });
  assert.equal((await f.detail('bob')).code, 'NOT_FOUND');
  ok(await f.detail('alice'));
  await f.repository.set('meal_posts', postId, { ...f.post, visibility: 'public' });
  ok(await f.detail());
  await f.repository.set('meal_posts', postId, { ...f.post, status: 'deleted' });
  assert.equal((await f.detail('alice')).code, 'NOT_FOUND');
});

test('dish indexes cannot read unlisted recipes, actual photos, or caller-supplied order IDs', async () => {
  const f = await fixture();
  for (const dishIndex of [-1, 50, '0', 0.5]) assert.equal((await f.detail('stranger', { dishIndex })).code, 'INVALID');
  assert.equal((await f.detail('stranger', { dishIndex: 1 })).code, 'NOT_FOUND');
  const another = { ...f.order, id: 'other-order', items: [{ recipe: { ...f.recipe, title: 'SECRET DISH' } }] };
  await f.repository.set('orders', hash(`${spaceId}:other-order`), { familyId: spaceId, value: another });
  assert.equal(ok(await f.detail('stranger', { orderId: 'other-order', spaceId: 'other-family', recipeId: 'other-recipe' })).recipe.id, 'dish-one');
  await f.repository.set('meal_posts', postId, { ...f.post, kind: 'actual', images: ['cloud://env/actual'] });
  assert.equal((await f.detail()).code, 'NOT_FOUND');
  assert.deepEqual(ok(await f.call('mealFeed', { spaceId: 'family-stranger' })).posts[0].images, ['cloud://env/actual']);
});

test('cross-family, changed-date, missing, or ambiguous legacy snapshots fail closed', async () => {
  for (const scenario of ['family', 'date', 'missing', 'title', 'image']) {
    const f = await fixture();
    if (scenario === 'missing') await f.repository.remove('orders', hash(`${spaceId}:${orderId}`));
    else {
      const order = structuredClone(f.order);
      if (scenario === 'date') order.date = '2026-11-04';
      if (scenario === 'title') order.items[0].recipe.title = '另一个菜';
      if (scenario === 'image') await f.repository.set('meal_posts', postId, { ...f.post, dishes: [{ title: f.recipe.title, image: '/static/chicken.png' }] });
      await f.repository.set('orders', hash(`${spaceId}:${orderId}`), { familyId: scenario === 'family' ? 'other-family' : spaceId, value: order });
    }
    assert.equal((await f.detail()).code, 'NOT_FOUND', scenario);
  }
});

test('known recipe IDs resolve only within the linked order and survive same-order reordering', async () => {
  const f = await fixture({ dishes: [{ recipeId: 'dish-one', title: '番茄炒蛋', image: '' }] });
  const order = { ...f.order, items: [{ recipe: { ...f.recipe, id: 'dish-two', title: '另一道菜' } }, { recipe: f.recipe }] };
  await f.repository.set('orders', hash(`${spaceId}:${orderId}`), { familyId: spaceId, value: order });
  assert.equal(ok(await f.detail()).recipe.id, 'dish-one');
  order.items[1].recipe.id = 'no-match';
  await f.repository.set('orders', hash(`${spaceId}:${orderId}`), { familyId: spaceId, value: order });
  assert.equal((await f.detail()).code, 'NOT_FOUND');
});

test('missing source images stay missing and private order photos are never silently authorized', async () => {
  for (const image of ['', 'cloud://env/private-cover', '/static/../private.png', 'https://private.example/photo.jpg']) {
    const f = await fixture();
    await f.repository.set('orders', hash(`${spaceId}:${orderId}`), { familyId: spaceId, value: { ...f.order, items: [{ recipe: { ...f.recipe, image } }] } });
    assert.equal(ok(await f.detail()).recipe.image, '', image);
    assert.deepEqual(ok(await f.call('mealFeed', { spaceId: 'family-stranger' })).posts[0].images, [], image);
  }
});

test('existing meal-authorized cover is retained but other step pictures are not added to its access list', async () => {
  const image = 'cloud://env/allowed-cover';
  const f = await fixture({ images: [image], dishes: [{ recipeId: 'dish-one', title: '番茄炒蛋', image }], assetIds: [image] });
  const order = { ...f.order, items: [{ recipe: { ...f.recipe, image, steps: [{ title: '完成', text: '完成', images: [image, 'cloud://env/private-step'] }] } }] };
  await f.repository.set('orders', hash(`${spaceId}:${orderId}`), { familyId: spaceId, value: order });
  const detail = ok(await f.detail()).recipe;
  assert.equal(detail.image, image);
  assert.deepEqual(detail.steps[0].images, [image]);
  assert.deepEqual((await f.repository.get('meal_posts', postId)).assetIds, [image]);
});

test('published recipe step photos appear in meal detail and pass both existing media delivery actions', async () => {
  const f = await fixture();
  const first = 'cloud://env/public-step-first';
  const second = 'cloud://env/public-step-second';
  const privateImage = 'cloud://env/private-step';
  for (const fileId of [first, second, privateImage]) await addMedia(f, fileId);
  await publicAssets(f, [first, second, 'cloud://env/unrelated-public-image']);
  await setRecipe(f, { steps: [{ title: '备菜', text: '切块', images: [second, first, second, privateImage] }] });
  const beforePost = await f.repository.get('meal_posts', postId);
  const beforeOrder = await f.repository.get('orders', hash(`${spaceId}:${orderId}`));
  const beforePublic = await f.repository.get('posts', 'published-recipe');
  const recipe = ok(await f.detail()).recipe;
  assert.deepEqual(recipe.steps[0].images, [second, first]);
  assert.equal(JSON.stringify(recipe).includes('unrelated-public-image'), false);
  for (const fileId of [first, second]) await assertDelivered(f, fileId);
  await assertDenied(f, privateImage);
  assert.deepEqual(f.imageReads, [
    { fileId: first, variant: 'original' }, { fileId: first, variant: 'detail' },
    { fileId: second, variant: 'original' }, { fileId: second, variant: 'detail' },
  ]);
  assert.deepEqual(await f.repository.get('meal_posts', postId), beforePost);
  assert.deepEqual(await f.repository.get('orders', hash(`${spaceId}:${orderId}`)), beforeOrder);
  assert.deepEqual(await f.repository.get('posts', 'published-recipe'), beforePublic);
});

test('a missing meal cover may use its exact source recipe publicly authorized cover without changing feed assets', async () => {
  const f = await fixture();
  const fileId = 'cloud://env/public-source-cover';
  await addMedia(f, fileId);
  await publicAssets(f, [fileId]);
  await setRecipe(f, { image: fileId });
  assert.equal(ok(await f.detail()).recipe.image, fileId);
  await assertDelivered(f, fileId);
  assert.deepEqual((await f.repository.get('meal_posts', postId)).assetIds, []);
});

test('public step authorization follows current publication and survives only while another published recipe permits it', async () => {
  const f = await fixture();
  const fileId = 'cloud://env/withdrawn-step';
  await addMedia(f, fileId);
  await setRecipe(f, { steps: [{ image: fileId }] });
  await publicAssets(f, [fileId]);
  assert.deepEqual(ok(await f.detail()).recipe.steps[0].images, [fileId]);
  await assertDelivered(f, fileId);
  await f.repository.set('posts', 'published-recipe', { status: 'hidden', assetIds: [fileId] });
  assert.deepEqual(ok(await f.detail()).recipe.steps[0].images, []);
  await assertDenied(f, fileId);
  await publicAssets(f, [fileId], 'second-published-recipe');
  assert.deepEqual(ok(await f.detail()).recipe.steps[0].images, [fileId]);
  await assertDelivered(f, fileId);
  await f.repository.remove('posts', 'second-published-recipe');
  assert.deepEqual(ok(await f.detail()).recipe.steps[0].images, []);
  await assertDenied(f, fileId);
  assert.equal((await f.repository.get('meal_posts', postId)).visibility, 'public');
});

test('an authenticated reader without a workspace can read published steps without a private source grant', async () => {
  const f = await fixture();
  const fileId = 'cloud://env/public-no-workspace';
  const privateImage = 'cloud://env/private-no-workspace';
  for (const image of [fileId, privateImage]) await addMedia(f, image);
  await publicAssets(f, [fileId]);
  await setRecipe(f, { steps: [{ images: [fileId, privateImage] }] });
  assert.deepEqual(ok(await f.detail('guest')).recipe.steps[0].images, [fileId]);
  await assertDelivered(f, fileId, 'guest');
  await assertDenied(f, privateImage, 'guest');
});

test('current source household members retain private and imported step images through the same media gateway', async () => {
  const f = await fixture();
  const privateImage = 'cloud://env/private-source-step';
  const importedImage = 'cloud://env/imported-source-step';
  await addMedia(f, privateImage);
  await addMedia(f, importedImage, { familyId: 'original-import-family' });
  await setRecipe(f, { steps: [{ images: [privateImage, importedImage] }] });
  assert.deepEqual(ok(await f.detail('bob')).recipe.steps[0].images, [privateImage, importedImage]);
  for (const fileId of [privateImage, importedImage]) await assertDelivered(f, fileId, 'bob');
  assert.deepEqual(ok(await f.detail()).recipe.steps[0].images, []);
  for (const fileId of [privateImage, importedImage]) await assertDenied(f, fileId);
});

test('a family diary participant in personal or another workspace does not gain source-only step photos', async () => {
  for (const mode of ['personal', 'other-family']) {
    const f = await fixture({ mealSharingVersion: 2, mealContext: 'family', participantUserIds: [hash('alice'), hash('bob')], visibility: 'family' });
    const fileId = `cloud://env/private-${mode}-step`;
    await addMedia(f, fileId);
    await setRecipe(f, { steps: [{ images: [fileId] }] });
    assert.deepEqual(ok(await f.detail('bob')).recipe.steps[0].images, [fileId]);
    await assertDelivered(f, fileId, 'bob');
    const userId = hash('bob');
    const user = await f.repository.get('users', userId);
    const nextId = mode === 'personal' ? `personal-${userId}` : 'another-family';
    await f.repository.set('families', nextId, { id: nextId, name: 'Other workspace', ...(mode === 'personal' ? { kind: 'personal', ownerId: userId } : {}), members: [{ id: userId, name: 'Bob' }] });
    await f.repository.set('users', userId, { ...user, ...(mode === 'personal' ? { activeMode: 'personal', personalSpaceId: nextId } : { familyId: nextId }) });
    assert.deepEqual(ok(await f.detail('bob')).recipe.steps[0].images, [], mode);
    await assertDenied(f, fileId, 'bob');
  }
});

test('stale membership and a deleted source household cannot grant private steps while public steps still work', async () => {
  for (const state of ['removed-member', 'deleted-family']) {
    const f = await fixture();
    const privateImage = 'cloud://env/revoked-source-step';
    const publicImage = 'cloud://env/retained-public-step';
    for (const fileId of [privateImage, publicImage]) await addMedia(f, fileId);
    await setRecipe(f, { steps: [{ images: [privateImage, publicImage] }] });
    await publicAssets(f, [publicImage]);
    const family = await f.repository.get('families', spaceId);
    await f.repository.set('families', spaceId, { ...family, ...(state === 'removed-member' ? { members: family.members.filter(member => member.id !== hash('bob')) } : { deletedAt: 1793870000001 }) });
    assert.deepEqual(ok(await f.detail('bob')).recipe.steps[0].images, [publicImage], state);
    await assertDelivered(f, publicImage, 'bob');
    await assertDenied(f, privateImage, 'bob');
  }
});

test('a forged published recipe asset cannot bypass a bound private meal photo or an unbound meal upload', async () => {
  for (const bound of [false, true]) {
    const f = await fixture();
    const fileId = `cloud://env/private-meal-photo-${bound}`;
    const privatePostId = `meal-${hash(`private-photo-${bound}`)}`;
    await addMedia(f, fileId, { mealPhoto: true, ...(bound ? { mealPostId: privatePostId } : {}) });
    if (bound) await f.repository.set('meal_posts', privatePostId, { ...f.post, id: privatePostId, visibility: 'private', assetIds: [fileId] });
    await setRecipe(f, { steps: [{ images: [fileId] }] });
    await publicAssets(f, [fileId]);
    for (const who of ['stranger', 'bob']) {
      assert.deepEqual(ok(await f.detail(who)).recipe.steps[0].images, [], `${bound}:${who}`);
      await assertDenied(f, fileId, who);
    }
  }
});

test('missing and unconfirmed media are omitted even when recipe publication or source membership permits the reference', async () => {
  const f = await fixture();
  const missing = 'cloud://env/missing-step';
  const unconfirmed = 'cloud://env/unconfirmed-step';
  await addMedia(f, unconfirmed, { confirmed: false });
  await publicAssets(f, [missing, unconfirmed]);
  await setRecipe(f, { steps: [{ images: [missing, unconfirmed] }] });
  for (const who of ['stranger', 'bob']) {
    assert.deepEqual(ok(await f.detail(who)).recipe.steps[0].images, []);
    for (const fileId of [missing, unconfirmed]) await assertDenied(f, fileId, who);
  }
});

test('step photos use legacy fallback only without an images array, preserving empty arrays, order and limits', async () => {
  const f = await fixture();
  const legacy = 'cloud://env/legacy-step';
  const modern = 'cloud://env/modern-step';
  for (const fileId of [legacy, modern]) await addMedia(f, fileId);
  await publicAssets(f, [legacy, modern]);
  await setRecipe(f, { steps: [
    { image: legacy },
    { images: [modern, legacy, modern], image: '/static/ignored.png' },
    { images: [], image: legacy },
    { images: Array.from({ length: 11 }, (_, index) => `/static/step-${index}.png`) },
  ] });
  const steps = ok(await f.detail()).recipe.steps;
  assert.deepEqual(steps[0].images, [legacy]);
  assert.deepEqual(steps[1].images, [modern, legacy]);
  assert.deepEqual(steps[2].images, []);
  assert.deepEqual(steps[3].images, Array.from({ length: 9 }, (_, index) => `/static/step-${index}.png`));
});

test('forbidden meals do not trigger source image authorization reads', async () => {
  const f = await fixture({ visibility: 'private' });
  const get = f.repository.get;
  const list = f.repository.list;
  const reads = [];
  f.repository.get = async (...args) => { reads.push(args[0]); return get(...args); };
  f.repository.list = async (...args) => { reads.push(args[0]); return list(...args); };
  assert.equal((await f.detail()).code, 'NOT_FOUND');
  assert.equal(reads.includes('orders'), false);
  assert.equal(reads.includes('media'), false);
  assert.equal(reads.includes('posts'), false);
});

test('discover resolves the public post by canonical ID and refuses same-title substitutes or withdrawn posts', async () => {
  const f = await fixture();
  await setRecipe(f, { identityVersion: 2, recipeOrigin: 'community', canonicalRecipeId: f.recipe.id });
  const publicPost = { id: 'public-food', status: 'published', kind: 'dish', familyId: 'publisher', recipes: [f.recipe] };
  await f.repository.set('posts', 'same-title', { ...publicPost, id: 'same-title', recipes: [{ ...f.recipe, id: 'different' }] });
  assert.equal(ok(await f.detail()).communityPostId, '');
  await f.repository.set('posts', publicPost.id, publicPost);
  assert.equal(ok(await f.detail()).communityPostId, publicPost.id);
  assert.equal(ok(await f.call('mealFeed', { spaceId: 'family-stranger' })).posts[0].dishes[0].communityPostId, publicPost.id);
  await f.repository.set('posts', publicPost.id, { ...publicPost, status: 'deleted' });
  assert.equal(ok(await f.detail()).communityPostId, '');
});

test('legacy unedited imports resolve their source post, edited forks never navigate to the original', async () => {
  const f = await fixture();
  const published = { id: 'public-source', status: 'published', familyId: 'publisher', kind: 'dish', recipes: [{ ...f.recipe, id: 'public-recipe' }] };
  await f.repository.set('posts', published.id, published);
  await setRecipe(f, { sourceId: 'public-recipe', sourceFamilyId: 'publisher', sourcePostId: published.id });
  assert.equal(ok(await f.detail()).communityPostId, published.id);
  await setRecipe(f, { sourceId: 'public-recipe', sourceFamilyId: 'publisher', sourcePostId: published.id, recipeOrigin: 'custom', forkedFromRecipeId: 'public-recipe' });
  assert.equal(ok(await f.detail()).communityPostId, '');
});

test('recorded snapshots retain badges and exact steps after hiding a diary and removing its arrangement', async () => {
  const f = await fixture({ dishes: [{ recipeId: 'dish-one', title: '番茄炒蛋', image: '/static/tomato.png' }] });
  const { preserveMealRecipes } = await import('../server/meal-dish-snapshots.mjs');
  await preserveMealRecipes(f.repository, spaceId, f.order);
  await f.repository.set('meal_reactions', hash(`${postId}:${hash('alice')}`), { diaryHiddenAt: 1793870000000 });
  await f.repository.remove('orders', hash(`${spaceId}:${orderId}`));
  await f.repository.set('recipes', hash(`${spaceId}:dish-one`), { familyId: spaceId, value: { ...f.recipe, steps: [{ text: 'later changed' }] } });
  const post = ok(await f.call('mealFeed', { spaceId: 'family-stranger' })).posts[0];
  assert.equal(post.dishes[0].sourceKind, 'custom');
  assert.equal('recipeSnapshots' in post, false);
  assert.equal(ok(await f.detail()).recipe.steps[0].text, '炒熟即可');
});

test('deleted legacy arrangement recovers only an exact unchanged public import; withdrawal and private forks stay inaccessible', async () => {
  const f = await fixture({ dishes: [{ recipeId: 'dish-one', title: '番茄炒蛋', image: '/static/tomato.png' }] });
  await f.repository.remove('orders', hash(`${spaceId}:${orderId}`));
  const recipe = { ...f.recipe, identityVersion: 2, recipeOrigin: 'community', sourceId: 'dish-one', sourceFamilyId: 'public-family', sourcePostId: 'public-source' };
  await f.repository.set('recipes', hash(`${spaceId}:dish-one`), { familyId: spaceId, value: recipe });
  const published = { id: 'public-source', familyId: 'public-family', status: 'published', kind: 'dish', recipes: [f.recipe] };
  await f.repository.set('posts', published.id, published);
  const post = ok(await f.call('mealFeed', { spaceId: 'family-stranger' })).posts[0];
  assert.equal(post.dishes[0].sourceKind, 'community');
  assert.equal(post.dishes[0].communityPostId, published.id);
  assert.equal(ok(await f.detail()).recipe.steps[0].text, '炒熟即可');
  for (const change of [{ recipeOrigin: 'custom' }, { steps: [{ text: 'private edit' }] }, { image: '/static/other.png' }, { id: 'different' }]) {
    await f.repository.set('recipes', hash(`${spaceId}:dish-one`), { familyId: spaceId, value: { ...recipe, ...change } });
    assert.equal((await f.detail()).code, 'NOT_FOUND');
  }
  await f.repository.set('recipes', hash(`${spaceId}:dish-one`), { familyId: spaceId, value: recipe });
  await f.repository.set('posts', published.id, { ...published, status: 'deleted' });
  assert.equal((await f.detail()).code, 'NOT_FOUND');
});
