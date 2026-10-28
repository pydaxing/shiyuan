import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSteps, filterPosts, ingredientImage, validateImage } from '../src/domain/presentation.js';
import { MAX_RECIPE_STEPS, validateRecipe, validateSnapshot, importCollection } from '../src/domain/kitchen.js';
import { createSeed, communityPosts } from '../src/data/seed.js';

test('optional steps support title only, text only, image only and any combination', () => {
  for (const steps of [[], [{ title: '开火' }], [{ text: '蒸熟' }], [{ image: '/static/tomato.png' }], [{ title: '装盘', text: '出锅', image: '/static/tomato.png' }]]) assert.doesNotThrow(() => validateRecipe({ ...createSeed().recipes[0], steps }));
});
test('blank steps are omitted and content is trimmed without changing ordering', () => {
  assert.deepEqual(cleanSteps([{ id: 1, title: '  ', text: '', image: '' }, { id: 2, title: ' 准备 ', text: ' 洗净 ', image: '' }, { id: 3, image: '/static/tomato.png' }]), [{ title: '准备', text: '洗净', image: '' }, { title: '', text: '', image: '/static/tomato.png' }]);
});
test('step limits and invalid step types fail clearly', () => {
  for (const steps of [[{}], [{ title: 3 }], [{ text: null }], [{ title: '长'.repeat(41) }], [{ text: '长'.repeat(1001) }], Array.from({ length: MAX_RECIPE_STEPS + 1 }, () => ({ text: '开火' }))]) assert.throws(() => validateRecipe({ ...createSeed().recipes[0], steps }), /做法/);
});
test('images accept persistent local content and reject temporary or active schemes', () => {
  for (const image of ['', undefined, '/static/tomato.png', 'data:image/jpeg;base64,YWJj', 'wxfile://usr/photo.jpg', 'http://usr/photo.jpg']) assert.doesNotThrow(() => validateImage(image));
  for (const image of ['blob:example', 'javascript:alert(1)', 'data:image/svg+xml;base64,YWJj', 'https://tracker.example/photo.jpg', 3, 'data:image/jpeg;base64,' + 'A'.repeat(500000)]) assert.throws(() => validateImage(image), /图片/);
});
test('old snapshots remain valid and new customizations survive JSON roundtrip', () => {
  const seed = createSeed();
  assert.doesNotThrow(() => validateSnapshot(seed));
  seed.family.cover = 'data:image/jpeg;base64,YWJj';
  seed.family.coverTitle = '一家人，三餐四季';
  seed.comments = [{ id: 'test', postId: 'dish-tofu', author: '我', text: '试做成功' }];
  seed.inventory[0].image = '/static/ingredient-tomato.png';
  assert.doesNotThrow(() => validateSnapshot(JSON.parse(JSON.stringify(seed))));
  seed.comments[0].text = 42;
  assert.throws(() => validateSnapshot(seed), /损坏/);
});
test('corrupt custom images do not silently replace saved data', () => {
  const seed = createSeed();
  seed.family.cover = 'blob:expired';
  assert.throws(() => validateSnapshot(seed), /图片/);
});
test('feed categories follow dish categories, while sets ignore category filtering', () => {
  assert.equal(filterPosts(communityPosts, '全部', '全部').length, communityPosts.length);
  const vegetarian = filterPosts(communityPosts, '菜品', '素菜');
  assert.ok(vegetarian.length > 0);
  assert.ok(vegetarian.every((post) => post.kind === 'dish' && post.recipes[0].category === '素菜'));
  assert.ok(filterPosts(communityPosts, '菜单', '全部').every((post) => post.kind === 'menu' && post.recipes.length > 1));
  assert.deepEqual(filterPosts(communityPosts, '套餐', '荤菜'), filterPosts(communityPosts, '套餐', '全部'));
});

test('community search matches post titles, contained dishes and ingredients with all query terms', () => {
  const recipe = { title: '香煎三文鱼', category: '荤菜', ingredients: [{ name: '柠檬' }] };
  const posts = [{ id: 'dish', kind: 'dish', title: '香煎三文鱼', recipes: [recipe] }, { id: 'set', kind: 'menu', title: '周末 Brunch', recipes: [recipe] }];
  const snapshot = JSON.stringify(posts);
  assert.deepEqual(filterPosts(posts, '全部', '全部', '  '), posts);
  for (const query of ['三文鱼', ' 柠檬 ', '三文鱼 柠檬']) assert.deepEqual(filterPosts(posts, '全部', '全部', query), posts);
  assert.deepEqual(filterPosts(posts, '全部', '全部', 'brunch'), [posts[1]]);
  assert.deepEqual(filterPosts(posts, '菜品', '荤菜', '柠檬'), [posts[0]]);
  assert.deepEqual(filterPosts(posts, '菜品', '素菜', '柠檬'), []);
  assert.deepEqual(filterPosts(posts, '套餐', '素菜', '柠檬'), [posts[1]]);
  for (const query of ['不存在', '柠檬 豆腐', '[.*]']) assert.deepEqual(filterPosts(posts, '全部', '全部', query), []);
  assert.equal(JSON.stringify(posts), snapshot);
});
test('individual dishes and sets share the same import deduplication', () => {
  const dish = communityPosts.find((post) => post.id === 'dish-tofu');
  const menu = communityPosts.find((post) => post.id === 'weekday');
  const imported = importCollection(createSeed().recipes, dish);
  assert.equal(imported.length, 7);
  assert.equal(importCollection(imported, menu).length, 7);
});
test('every community recipe validates and all ingredient names get a default picture', () => {
  communityPosts.forEach((post) => post.recipes.forEach(validateRecipe));
  for (const name of ['番茄', '西红柿', '鸡蛋', '鸡腿肉', '食用油', '盐', '未知食材']) assert.match(ingredientImage(name), /^\/static\/ingredient-\w+\.png$/);
  assert.equal(ingredientImage('西红柿'), ingredientImage('番茄'));
});
