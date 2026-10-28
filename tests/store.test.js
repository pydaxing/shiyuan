import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeed } from '../src/data/seed.js';
import { validateSnapshot, localDate, dateOffset, getShoppingRequirements } from '../src/domain/kitchen.js';

let saved = '';
let storageFull = false;
globalThis.uni = {
  getStorageSync: () => saved,
  setStorageSync: (key, value) => { if (storageFull) throw new Error('Quota exceeded'); saved = value; },
};
const store = await import('../src/store.js');
function resetFamilyFixture() {
  store.resetDemo();
  store.state.value.family.id = 'test-family';
}


test('purchase expiry persists with fridge off and cannot cover meals after expiry', () => {
  resetFamilyFixture();
  store.setFeature('fridge', false);
  store.submitOrder({ tomato: 1 }, { date: dateOffset(1), meal: '晚餐' });
  store.recordPurchase({ name: '番茄', quantity: 500, unit: 'g', expiresOn: localDate() });
  assert.equal(store.state.value.purchases[0].expiresOn, localDate());
  const required = getShoppingRequirements(store.state.value).find((item) => item.name === '番茄');
  assert.equal(required.available, 0);
  const before = saved;
  assert.throws(() => store.recordPurchase({ name: '番茄', quantity: 500, unit: 'g', expiresOn: '2026-02-30' }), /到期日期/);
  assert.equal(saved, before);
  const snapshot = JSON.parse(saved);
  assert.doesNotThrow(() => validateSnapshot(snapshot));
  snapshot.purchases[0].expiresOn = '2026-02-30';
  assert.throws(() => validateSnapshot(snapshot), /损坏/);
});

test('store refuses out-of-window reservations without writing or losing existing orders', () => {
  resetFamilyFixture();
  const before = saved;
  for (const date of [dateOffset(-1), dateOffset(3)]) assert.throws(() => store.submitOrder({ tomato: 1 }, { date, meal: '宵夜' }), /只能预订/);
  assert.equal(saved, before);
  store.submitOrder({ tomato: 1 }, { date: dateOffset(2), meal: '宵夜' });
  assert.equal(store.state.value.orders[0].meal, '宵夜');
});

test('multi-photo recipe survives editing, publication, deletion and family reimport', () => {
  resetFamilyFixture();
  const steps = [{ title: '洗净', text: '', images: ['/static/tomato.png', '/static/chicken.png'] }];
  store.saveRecipe({ ...createSeed().recipes[0], title: '多图菜品', steps });
  const id = store.state.value.recipes[0].id;
  const postId = store.publishToCommunity(id);
  const post = structuredClone(JSON.parse(JSON.stringify(store.state.value.posts.find((entry) => entry.id === postId))));
  store.removeFamilyEntry(id);
  store.addCollection(post);
  assert.deepEqual(store.state.value.recipes.find((entry) => entry.sourceId === post.recipes[0].id).steps, steps);
});

test('startup restores self after old member switching without rewriting storage or history', async () => {
  resetFamilyFixture();
  store.switchMember('partner');
  store.submitOrder({ tomato: 1 }, { date: dateOffset(1), meal: '晚餐' });
  const before = saved;
  const oldOrders = JSON.parse(JSON.stringify(store.state.value.orders));
  const reloaded = await import('../src/store.js?identity-startup');
  assert.equal(reloaded.activeMember.value.id, 'me');
  assert.deepEqual(JSON.parse(JSON.stringify(reloaded.state.value.orders)), oldOrders);
  assert.equal(saved, before);
});

test('other category persists across editing, publication and import', () => {
  resetFamilyFixture();
  store.saveRecipe({ ...createSeed().recipes[0], title: '柠檬水', category: '其他' });
  const drink = store.state.value.recipes[0];
  const postId = store.publishToCommunity(drink.id);
  const post = JSON.parse(JSON.stringify(store.state.value.posts.find((entry) => entry.id === postId)));
  assert.deepEqual(post.categories, ['其他']);
  store.removeFamilyEntry(drink.id);
  store.addCollection(post);
  assert.equal(store.state.value.recipes.find((entry) => entry.sourceId === post.recipes[0].id).category, '其他');
  assert.doesNotThrow(() => validateSnapshot(JSON.parse(saved)));
});

test('family images, recipe steps, stock images and comments persist together', () => {
  resetFamilyFixture();
  store.customizeFamily({ name: '定制家庭', cover: 'data:image/jpeg;base64,YWJj', coverTitle: '一起吃饭', coverSubtitle: ' 一起做拿手菜 ' });
  store.saveRecipe({ ...createSeed().recipes[0], title: '图片菜谱', image: 'data:image/jpeg;base64,YWJj', steps: [{ title: '准备', text: '', image: '' }, { title: '装盘', image: 'data:image/jpeg;base64,YWJj' }, { title: '', text: '', image: '' }] });
  store.changeStockImage('stock-tomato', 'data:image/jpeg;base64,YWJj');
  store.addComment('dish-tofu', '  很喜欢  ');
  const snapshot = JSON.parse(saved);
  assert.doesNotThrow(() => validateSnapshot(snapshot));
  assert.equal(snapshot.family.name, '定制家庭');
  assert.equal(snapshot.family.coverTitle, '一起吃饭');
  assert.equal(snapshot.family.coverSubtitle, '一起做拿手菜');
  assert.equal(snapshot.recipes[0].steps.length, 2);
  assert.equal(snapshot.recipes[0].steps[1].image, snapshot.family.cover);
  assert.equal(snapshot.inventory[0].image, snapshot.family.cover);
  assert.equal(snapshot.comments[0].text, '很喜欢');
});
test('storage full errors preserve both persisted and visible data atomically', () => {
  const previous = saved;
  const visible = JSON.stringify(store.state.value);
  storageFull = true;
  assert.throws(() => store.customizeFamily({ name: '未保存', cover: '', coverTitle: '' }), /保存失败/);
  assert.equal(saved, previous);
  assert.equal(JSON.stringify(store.state.value), visible);
  storageFull = false;
});
test('family subtitle survives legacy updates and invalid copy cannot overwrite saved data', () => {
  const family = { name: '定制家庭', cover: '', coverTitle: '都是爱吃的菜', coverSubtitle: '三餐好好吃饭' };
  store.customizeFamily(family);
  const { coverSubtitle, ...legacy } = family;
  store.customizeFamily({ ...legacy, name: '改了名称的小家' });
  assert.equal(store.state.value.family.coverSubtitle, coverSubtitle);
  const before = saved;
  for (const invalid of [null, 3, {}, '字'.repeat(51)]) {
    assert.throws(() => store.customizeFamily({ ...family, coverSubtitle: invalid }), /菜单副标题/);
    assert.equal(saved, before);
    assert.equal(store.state.value.family.coverSubtitle, coverSubtitle);
    const snapshot = JSON.parse(before);
    snapshot.family.coverSubtitle = invalid;
    assert.throws(() => validateSnapshot(snapshot), /损坏/);
  }
  const snapshot = JSON.parse(before);
  delete snapshot.family.coverSubtitle;
  assert.doesNotThrow(() => validateSnapshot(snapshot));
});
test('removing a custom photo restores the default without removing stock', () => {
  store.changeStockImage('stock-tomato', '');
  assert.equal(store.state.value.inventory[0].image, '');
  assert.equal(store.state.value.inventory[0].quantity, 260);
  assert.throws(() => store.changeStockImage('missing', ''), /不在冰箱/);
});
test('empty comments and invalid family names are not persisted', () => {
  const previous = saved;
  assert.throws(() => store.addComment('dish-tofu', ' '), /评论/);
  assert.throws(() => store.customizeFamily({ name: '', cover: '', coverTitle: '' }), /家庭名称/);
  assert.equal(saved, previous);
});

test('imported sets persist and repeated imports do not flatten or duplicate them', async () => {
  const { communityPosts } = await import('../src/data/seed.js');
  resetFamilyFixture();
  const post = communityPosts.find((entry) => entry.kind === 'menu');
  store.addCollection(post);
  const previous = JSON.parse(saved);
  store.addCollection(post);
  assert.equal(store.state.value.mealSets.length, 1);
  assert.equal(store.state.value.mealSets[0].recipeIds.length, 3);
  assert.equal(store.state.value.recipes.length, previous.recipes.length);
  assert.doesNotThrow(() => validateSnapshot(JSON.parse(saved)));
});
test('editing imported dishes keeps set references and old orders unchanged', () => {
  const mealSet = store.state.value.mealSets[0];
  const dish = store.state.value.recipes.find((entry) => entry.id === mealSet.recipeIds[0]);
  store.submitOrder({ [`set:${mealSet.id}`]: 1 }, { date: localDate(), meal: '晚餐' }, '', 4);
  const oldTitle = dish.title;
  store.saveRecipe({ ...dish, title: '修改后的豆腐' }, dish.id);
  assert.equal(store.state.value.orders[0].items[0].recipe.title, oldTitle);
  assert.equal(store.state.value.mealSets[0].recipeIds[0], dish.id);
  assert.equal(store.state.value.recipes.find((entry) => entry.id === dish.id).title, '修改后的豆腐');
});
test('feature choices persist independently, disabled fridge purchases do not add stock', () => {
  const before = JSON.stringify(store.state.value.inventory);
  store.setFeature('fridge', false);
  store.recordPurchase({ name: '番茄', quantity: 500, unit: 'g' });
  assert.equal(JSON.stringify(store.state.value.inventory), before);
  assert.equal(store.state.value.purchases.length, 1);
  store.setFeature('shopping', false);
  assert.deepEqual(JSON.parse(saved).family.features, { fridge: false, shopping: false });
  assert.doesNotThrow(() => validateSnapshot(JSON.parse(saved)));
});
test('creating and editing a set preserves exactly the selected dish IDs', () => {
  store.saveMealSet({ title: '自选双拼', image: '', recipeIds: ['tomato', 'broccoli'] });
  const mealSet = store.state.value.mealSets[0];
  assert.deepEqual([...mealSet.recipeIds], ['tomato', 'broccoli']);
  store.saveMealSet({ title: '自选三拼', image: '', recipeIds: ['tomato', 'broccoli', 'chicken'] }, mealSet.id);
  assert.equal(store.state.value.mealSets.filter((entry) => entry.id === mealSet.id).length, 1);
  assert.deepEqual([...store.state.value.mealSets[0].recipeIds], ['tomato', 'broccoli', 'chicken']);
  assert.doesNotThrow(() => validateSnapshot(JSON.parse(saved)));
});
test('failed set imports roll back dish additions and failed settings preserve toggles', async () => {
  const { communityPosts } = await import('../src/data/seed.js');
  const previous = saved;
  storageFull = true;
  assert.throws(() => store.addCollection(communityPosts.find((entry) => entry.id === 'weekend')), /保存失败/);
  assert.equal(saved, previous);
  assert.equal(JSON.stringify(store.state.value), previous);
  assert.throws(() => store.setFeature('fridge', true), /保存失败/);
  assert.equal(store.state.value.family.features.fridge, false);
  storageFull = false;
});

test('member submissions upsert one kitchen order and preserve individual choices', () => {
  resetFamilyFixture();
  const slot = { date: localDate(), meal: '晚餐' };
  store.submitOrder({ tomato: 1, chicken: 1 }, slot, '少辣');
  store.switchMember('partner');
  store.submitOrder({ tomato: 1 }, slot);
  store.submitOrder({ tomato: 1, soup: 1 }, slot);
  const order = store.state.value.orders[0];
  assert.equal(store.state.value.orders.length, 1);
  assert.equal(order.items.length, 3);
  assert.equal(order.items.find((item) => item.recipe.id === 'tomato').chosenBy.length, 2);
  assert.equal(order.selections.length, 2);
  assert.equal(order.note, '我：少辣');
  assert.doesNotThrow(() => validateSnapshot(JSON.parse(saved)));
});
test('withdrawing selections retains the other member and cancels only an empty meal', () => {
  const slot = { date: localDate(), meal: '晚餐' };
  store.submitOrder({}, slot);
  assert.equal(store.state.value.orders[0].items.length, 2);
  assert.equal(store.state.value.orders[0].selections.length, 1);
  store.switchMember('me');
  store.submitOrder({}, slot);
  assert.equal(store.state.value.orders[0].status, 'cancelled');
  assert.doesNotThrow(() => validateSnapshot(JSON.parse(saved)));
  store.submitOrder({ soup: 1 }, slot);
  assert.equal(store.state.value.orders.filter((order) => order.status === 'accepted').length, 1);
});
test('meal slots stay separate and completed meals reject new selection', () => {
  resetFamilyFixture();
  const slot = { date: localDate(), meal: '晚餐' };
  store.submitOrder({ tomato: 1 }, slot);
  store.submitOrder({ tomato: 1 }, { ...slot, meal: '午餐' });
  store.submitOrder({ tomato: 1 }, { ...slot, date: dateOffset(1) });
  assert.equal(store.state.value.orders.length, 3);
  const order = store.state.value.orders.find((entry) => entry.date === slot.date && entry.meal === slot.meal);
  store.setFeature('fridge', false);
  store.updateOrder(order.id, 'accepted');
  store.updateOrder(order.id, 'completed');
  assert.throws(() => store.submitOrder({ soup: 1 }, slot), /已经做好/);
});
test('deleting dishes repairs sets while retaining submitted recipe snapshots', () => {
  resetFamilyFixture();
  store.saveMealSet({ title: '三菜', recipeIds: ['tomato', 'chicken', 'broccoli'] });
  const setId = store.state.value.mealSets[0].id;
  store.submitOrder({ [`set:${setId}`]: 1 }, { date: localDate(), meal: '晚餐' });
  store.removeFamilyEntry('tomato');
  assert.deepEqual([...store.state.value.mealSets[0].recipeIds], ['chicken', 'broccoli']);
  assert.equal(store.state.value.orders[0].items[0].recipe.id, 'tomato');
  store.removeFamilyEntry('chicken');
  assert.equal(store.state.value.mealSets.length, 0);
  assert.equal(store.state.value.orders[0].items.length, 3);
  assert.doesNotThrow(() => validateSnapshot(JSON.parse(saved)));
});
test('deleting a set leaves its dishes, deleting stock leaves order snapshots', () => {
  resetFamilyFixture();
  store.saveMealSet({ title: '两菜', recipeIds: ['tomato', 'chicken'] });
  store.removeFamilyEntry(store.state.value.mealSets[0].id, 'set');
  assert.equal(store.state.value.mealSets.length, 0);
  assert.equal(store.state.value.recipes.length, 6);
  store.removeStock('stock-tomato');
  assert.equal(store.state.value.inventory.some((stock) => stock.id === 'stock-tomato'), false);
});
test('chef toggle persists only for the active member and does not change features', () => {
  resetFamilyFixture();
  store.setChef(true);
  store.switchMember('partner');
  assert.equal(store.activeMember.value.isChef, false);
  assert.equal(store.state.value.family.members[0].isChef, true);
  assert.deepEqual(JSON.parse(saved).family.features, { fridge: false, shopping: false });
});
test('sharing publishes selected snapshots in the feed, not family private data or fake metrics', () => {
  resetFamilyFixture();
  const id = store.publishToCommunity('tomato');
  const post = JSON.parse(saved).posts[0];
  assert.equal(post.id, id);
  assert.equal(post.kind, 'dish');
  assert.equal(post.recipes.length, 1);
  assert.equal(post.recipes[0].steps.length, 3);
  for (const privateKey of ['family', 'members', 'orders', 'inventory', 'metrics']) assert.equal(post[privateKey], undefined);
  store.saveRecipe({ ...store.state.value.recipes[0], title: '番茄炒蛋改版' }, 'tomato');
  assert.equal(store.state.value.posts[0].title, '番茄炒蛋');
  const before = saved;
  assert.throws(() => store.publishToCommunity('tomato'), error => error.code === 'ALREADY_SHARED');
  assert.equal(saved, before);
  assert.equal(store.state.value.posts.length, 1);
  assert.equal(store.state.value.posts[0].title, '番茄炒蛋');
  store.deleteCommunityPost(id);
  const republished = store.publishToCommunity('tomato');
  assert.notEqual(republished, id);
  assert.equal(store.state.value.posts[0].title, '番茄炒蛋改版');
  assert.doesNotThrow(() => validateSnapshot(JSON.parse(saved)));
});
test('published sets survive removal and can be imported back for editing', () => {
  resetFamilyFixture();
  store.saveMealSet({ title: '私房套餐', recipeIds: ['tomato', 'chicken'] });
  const setId = store.state.value.mealSets[0].id;
  store.publishToCommunity(setId, 'set');
  store.removeFamilyEntry(setId, 'set');
  const post = store.state.value.posts[0];
  assert.equal(post.kind, 'menu');
  assert.equal(post.recipes.length, 2);
  store.addCollection(post);
  store.addCollection(post);
  assert.equal(store.state.value.mealSets.length, 1);
  assert.equal(store.state.value.mealSets[0].sourceId, post.id);
  assert.equal(store.state.value.recipes.length, 6);
  assert.throws(() => store.publishToCommunity('missing'), /家庭菜单/);
});
test('fractional purchases are rejected for count units, but fractional cooking stock is allowed', () => {
  resetFamilyFixture();
  store.setFeature('fridge', true);
  store.submitOrder({ tomato: 1 }, { date: localDate(), meal: '晚餐' });
  assert.throws(() => store.recordPurchase({ name: '玉米', quantity: 0.5, unit: '根', location: '冷藏' }), /完整/);
  store.recordPurchase({ name: '玉米', quantity: 1, unit: '根', location: '冷藏' });
  store.addStock({ name: '玉米', quantity: 0.5, unit: '根', location: '冷藏' });
  assert.equal(store.state.value.inventory.at(-1).quantity, 0.5);
});
test('publication, deletion and merged submissions remain atomic on storage failure', () => {
  resetFamilyFixture();
  const slot = { date: localDate(), meal: '晚餐' };
  store.submitOrder({ tomato: 1 }, slot);
  const previous = saved;
  storageFull = true;
  try {
    for (const action of [() => store.publishToCommunity('tomato'), () => store.removeFamilyEntry('tomato'), () => store.setChef(true), () => store.submitOrder({ soup: 1 }, slot)]) {
      assert.throws(action, /保存失败/);
      assert.equal(saved, previous);
      assert.equal(JSON.stringify(store.state.value), previous);
    }
  } finally { storageFull = false; }
});

test('comments support replies to other members, nested replies and per-member likes', () => {
  resetFamilyFixture();
  store.addComment('dish-tofu', '今天做了');
  const root = store.state.value.comments[0];
  store.switchMember('partner');
  store.addComment('dish-tofu', '味道怎么样？', root.id);
  const reply = store.state.value.comments[1];
  assert.equal(reply.parentId, root.id);
  assert.equal(reply.replyToAuthor, '我');
  store.toggleCommentLike(root.id);
  store.switchMember('me');
  store.addComment('dish-tofu', '很好吃', reply.id);
  assert.equal(store.state.value.comments[2].parentId, root.id);
  assert.equal(store.state.value.comments[2].replyToId, reply.id);
  store.toggleCommentLike(root.id);
  assert.deepEqual([...store.state.value.comments[0].likes], ['partner', 'me']);
  store.toggleCommentLike(root.id);
  assert.deepEqual([...store.state.value.comments[0].likes], ['partner']);
  assert.doesNotThrow(() => validateSnapshot(JSON.parse(saved)));
});
test('comments reject missing posts and cross-post replies', () => {
  const previous = saved;
  const root = store.state.value.comments[0];
  assert.throws(() => store.addComment('missing', 'hello'), /不存在/);
  assert.throws(() => store.addComment('dish-tomato', 'hello', root.id), /不存在/);
  assert.throws(() => store.toggleCommentLike('missing'), /不存在/);
  assert.equal(saved, previous);
});
test('deleting a published set does not delete imported copies, original recipes or orders', () => {
  resetFamilyFixture();
  store.saveMealSet({ title: '营养双拼', recipeIds: ['tomato', 'broccoli'] });
  const originalId = store.state.value.mealSets[0].id;
  const postId = store.publishToCommunity(originalId, 'set');
  store.addCollection(store.state.value.posts[0]);
  store.submitOrder({ [`set:${originalId}`]: 1 }, { date: dateOffset(1), meal: '晚餐' });
  store.addComment(postId, '开饭了');
  const recipesBefore = JSON.stringify(store.state.value.recipes);
  const setsBefore = JSON.stringify(store.state.value.mealSets);
  const ordersBefore = JSON.stringify(store.state.value.orders);
  store.switchMember('partner');
  assert.throws(() => store.deleteCommunityPost(postId), /只能删除/);
  assert.throws(() => store.deleteCommunityPost('dish-tofu'), /只能删除/);
  store.switchMember('me');
  store.deleteCommunityPost(postId);
  assert.equal(store.state.value.posts.length, 0);
  assert.equal(store.state.value.comments.length, 0);
  assert.equal(JSON.stringify(store.state.value.recipes), recipesBefore);
  assert.equal(JSON.stringify(store.state.value.mealSets), setsBefore);
  assert.equal(JSON.stringify(store.state.value.orders), ordersBefore);
  assert.throws(() => store.addComment(postId, '已删除'), /不存在/);
});
test('nutrition saves, edits and publishes without leaking unshared private fields', () => {
  resetFamilyFixture();
  store.saveRecipe({ ...store.state.value.recipes[0], nutrition: '  含蛋白质  ' }, 'tomato');
  const postId = store.publishToCommunity('tomato');
  assert.equal(store.state.value.posts[0].recipes[0].nutrition, '含蛋白质');
  store.saveRecipe({ ...store.state.value.recipes[0], nutrition: '' }, 'tomato');
  assert.equal(store.state.value.posts[0].recipes[0].nutrition, '含蛋白质');
  assert.throws(() => store.publishToCommunity('tomato'), error => error.code === 'ALREADY_SHARED');
  store.deleteCommunityPost(postId);
  store.publishToCommunity('tomato');
  assert.equal(store.state.value.posts[0].recipes[0].nutrition, '');
});
test('likes, replies and post deletion roll back on storage failure', () => {
  resetFamilyFixture();
  const postId = store.publishToCommunity('tomato');
  store.addComment(postId, '原评论');
  const commentId = store.state.value.comments[0].id;
  const before = saved;
  storageFull = true;
  try {
    for (const action of [() => store.toggleCommentLike(commentId), () => store.addComment(postId, '回复', commentId), () => store.deleteCommunityPost(postId)]) {
      assert.throws(action, /保存失败/);
      assert.equal(saved, before);
      assert.equal(JSON.stringify(store.state.value), before);
    }
  } finally { storageFull = false; }
});
