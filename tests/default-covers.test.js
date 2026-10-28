import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { DEFAULT_DISH_COVER, DEFAULT_SET_COVER, foodCover, validateImage } from '../src/domain/presentation.js';
import { DEFAULT_FAMILY_COVER } from '../src/domain/family.js';
import { COVER_RATIOS } from '../src/domain/image-crop.js';
import { createSeed } from '../src/data/seed.js';
import { makeOrder } from '../src/domain/kitchen.js';
import { makeShare, parseShare } from '../src/domain/sharing.js';
import { dishShareCard } from '../src/services/native-share.js';
import { createApplication } from '../server/application.mjs';
import { memoryRepository } from './helpers/memory-repository.js';

test('dish D1 and set T1 defaults are distinct and never replace a chosen image', () => {
  assert.notEqual(DEFAULT_DISH_COVER, DEFAULT_SET_COVER);
  for (const image of ['', undefined, null]) {
    assert.equal(foodCover(image), DEFAULT_DISH_COVER);
    assert.equal(foodCover(image, 'dish'), DEFAULT_DISH_COVER);
    assert.equal(foodCover(image, 'set'), DEFAULT_SET_COVER);
    assert.equal(foodCover(image, 'menu'), DEFAULT_SET_COVER);
  }
  for (const image of ['/static/tofu.png', 'cloud://env/custom.bin', 'wxfile://usr/photo.jpg', 'data:image/jpeg;base64,YWJj']) {
    for (const kind of ['dish', 'set', 'menu']) assert.equal(foodCover(image, kind), image);
  }
  assert.doesNotThrow(() => validateImage(''));
});

test('all three selected defaults are separate golden-ratio JPEGs bundled below 80 KiB each', async () => {
  const contents = [];
  for (const path of [DEFAULT_FAMILY_COVER, DEFAULT_DISH_COVER, DEFAULT_SET_COVER]) {
    const buffer = readFileSync(new URL(`../src${path}`, import.meta.url));
    const metadata = await sharp(buffer).metadata();
    assert.equal(metadata.format, 'jpeg');
    assert.equal(metadata.width, 960);
    assert.ok(Math.abs(metadata.width / metadata.height - COVER_RATIOS.recipe) < .002);
    assert.ok(buffer.byteLength < 80 * 1024, path);
    assert.equal(contents.some(previous => previous.equals(buffer)), false);
    contents.push(buffer);
  }
});

test('portable shares and order snapshots keep absent covers empty instead of borrowing a member dish', () => {
  const recipes = createSeed().recipes.slice(0, 2);
  const mealSet = { id: 'default-set', title: '默认封面套餐', image: '', recipeIds: recipes.map(recipe => recipe.id) };
  const payload = parseShare(makeShare(mealSet, recipes, '我们的小家', 'set'));
  assert.equal(payload.image, '');
  assert.equal(payload.recipes[0].image, recipes[0].image);
  assert.equal(foodCover(payload.image, payload.kind), DEFAULT_SET_COVER);
  const order = makeOrder({ id: 'cover-order', recipes, mealSets: [mealSet], cart: { 'set:default-set': 1 }, member: { id: 'member', name: '家人' }, date: '2026-10-20', meal: '晚餐' });
  assert.equal(order.entries[0].image, '');
  assert.equal(order.items[0].recipe.image, recipes[0].image);
});

test('native share cards choose the same dish or set default and retain resolved custom photos', () => {
  for (const kind of ['dish', 'set', 'menu']) {
    const share = { id: 'food', title: '分享美食', kind };
    assert.equal(dishShareCard(share).imageUrl, foodCover('', kind));
    assert.equal(dishShareCard({ ...share, imageUrl: 'https://example.com/custom.jpg' }).imageUrl, 'https://example.com/custom.jpg');
  }
});

test('cloud save, publish, friend sharing and import accept default covers without storing packaged artwork', async () => {
  const repository = memoryRepository();
  const app = createApplication({ repository, now: () => Date.parse('2026-10-20T03:00:00Z'), signFiles: async () => ({}) });
  let sequence = 0;
  const call = async (action, payload = {}, user = 'author') => {
    const result = await app({ action, ...payload }, { OPENID: user });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  };
  let current = await call('createFamily', { familyName: '封面测试', name: '家人', requestId: 'cover-family-author' });
  const mutate = async (name, args) => {
    current = await call('command', { name, args, revision: current.revision, requestId: `cover-command-${++sequence}`, includeFeed: false });
  };
  const recipes = createSeed().recipes;
  await mutate('saveRecipe', [{ ...recipes[0], image: '' }]);
  await mutate('saveRecipe', [recipes[1]]);
  const blankDish = current.snapshot.recipes.find(recipe => recipe.image === '');
  const customDish = current.snapshot.recipes.find(recipe => recipe.image !== '');
  await mutate('saveMealSet', [{ title: '使用默认套餐图', image: '', recipeIds: [customDish.id, blankDish.id] }]);
  const mealSet = current.snapshot.mealSets[0];
  await call('createFamily', { familyName: '接收家庭', name: '朋友', requestId: 'cover-family-recipient' }, 'recipient');

  for (const [kind, item] of [['dish', blankDish], ['set', mealSet]]) {
    assert.equal(item.image, '');
    const share = await call('createDishShare', { familyId: current.familyId, itemId: item.id, kind });
    assert.equal(share.image, '');
    assert.equal(dishShareCard(share).imageUrl, foodCover('', kind));
    const detail = await call('readShare', { token: share.token }, 'visitor');
    assert.equal(detail.post.image, '');
    assert.equal(foodCover(detail.post.image, detail.post.kind), foodCover('', kind));
    const imported = await call('importShare', { token: share.token }, 'recipient');
    const collection = kind === 'dish' ? imported.snapshot.recipes : imported.snapshot.mealSets;
    assert.equal(collection.find(entry => entry.title === item.title).image, '');
    await mutate('publishToCommunity', [item.id, kind]);
    const published = await call('readPost', { postId: current.value, includeComments: false });
    assert.equal(published.post.image, '');
    if (kind === 'set') assert.equal(published.post.recipes[0].image, customDish.image);
  }
  const customShare = await call('createDishShare', { familyId: current.familyId, itemId: customDish.id, kind: 'dish' });
  assert.equal(customShare.image, customDish.image);
  const restored = await call('bootstrap', { includeFeed: false });
  assert.equal(restored.snapshot.recipes.find(recipe => recipe.id === customDish.id).image, customDish.image);
  assert.equal(restored.snapshot.recipes.find(recipe => recipe.id === blankDish.id).image, '');
  assert.equal(restored.snapshot.mealSets.find(entry => entry.id === mealSet.id).image, '');
});
