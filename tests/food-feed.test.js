import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CATEGORIES } from '../src/domain/kitchen.js';
import { FOOD_CATEGORIES, foodFeedFilter, buildFoodWaterfall } from '../src/domain/food-feed.js';
import { filterPosts } from '../src/domain/presentation.js';

test('one food category strip maps dishes and final meal-set filter to the existing API', () => {
  assert.deepEqual(FOOD_CATEGORIES, [...CATEGORIES, '套餐']);
  assert.equal(FOOD_CATEGORIES.length, 8);
  assert.equal(FOOD_CATEGORIES.includes('全部'), false);
  assert.deepEqual(foodFeedFilter('全部'), { type: '全部', category: '全部' });
  assert.deepEqual(foodFeedFilter('套餐'), { type: '套餐', category: '全部' });
  assert.deepEqual(foodFeedFilter('不存在'), { type: '全部', category: '全部' });
  for (const category of CATEGORIES) assert.deepEqual(foodFeedFilter(category), { type: '菜品', category });
  const posts = [
    { id: 'dish', kind: 'dish', title: '冬瓜汤', recipes: [{ category: '汤羹', title: '冬瓜汤', ingredients: [] }] },
    { id: 'menu', kind: 'menu', title: '晚餐套餐', recipes: [{ category: '汤羹', title: '冬瓜汤', ingredients: [] }] },
  ];
  for (const [selected, ids] of [['全部', ['dish', 'menu']], ['汤羹', ['dish']], ['套餐', ['menu']]]) {
    const filters = foodFeedFilter(selected);
    assert.deepEqual(filterPosts(posts, filters.type, filters.category).map(post => post.id), ids);
  }
});

test('waterfall reserves different cover shapes and keeps independent, non-row-aligned lanes', () => {
  const posts = Array.from({ length: 18 }, (_, index) => ({ id: `post-${index}`, title: '家常菜' }));
  const lanes = buildFoodWaterfall(posts);
  assert.equal(lanes.length, 2);
  assert.equal(lanes.flat().length, posts.length);
  assert.equal(new Set(lanes.flat().map(entry => entry.post.id)).size, posts.length);
  assert.notEqual(lanes[0][0].coverPadding, lanes[1][0].coverPadding);
  assert.ok(new Set(lanes.flat().map(entry => entry.coverRatio)).size >= 4);
  for (const entry of lanes.flat()) {
    assert.equal(entry.post, posts.find(post => post.id === entry.post.id));
    assert.ok(parseFloat(entry.coverPadding) >= 108 && parseFloat(entry.coverPadding) < 117);
    assert.ok(!('coverRatio' in entry.post));
  }
});

test('single-line title lengths do not change waterfall column estimates or cover shapes', () => {
  const shortPosts = Array.from({ length: 30 }, (_, index) => ({ id: `post-${index}`, title: '家常菜' }));
  const longPosts = shortPosts.map((post, index) => ({ ...post, title: index % 2 ? '香菇鸡腿焖饭（少盐少油家常版）' : '今晚全家都爱吃的三菜一汤套餐' }));
  const layout = posts => buildFoodWaterfall(posts).map(lane => lane.map(entry => ({ id: entry.post.id, coverRatio: entry.coverRatio, coverPadding: entry.coverPadding })));
  assert.deepEqual(layout(longPosts), layout(shortPosts));
});

test('appending another feed page cannot move, reorder, or resize already displayed cards', () => {
  const posts = Array.from({ length: 60 }, (_, index) => ({ id: `post-${index}`, title: index % 3 ? '一道菜' : '可以包进许多蔬菜的家常鸡蛋卷' }));
  const firstPage = buildFoodWaterfall(posts.slice(0, 20));
  const nextPage = buildFoodWaterfall(posts.slice(0, 40));
  const thirdPage = buildFoodWaterfall(posts);
  firstPage.forEach((lane, index) => assert.deepEqual(nextPage[index].slice(0, lane.length), lane));
  nextPage.forEach((lane, index) => assert.deepEqual(thirdPage[index].slice(0, lane.length), lane));
  assert.deepEqual(buildFoodWaterfall([]), [[], []]);
  assert.deepEqual(buildFoodWaterfall([posts[0]])[0][0].post, posts[0]);
});

test('food is the visible name while persistent community identifiers are unchanged', () => {
  const home = readFileSync(new URL('../src/domain/navigation.js', import.meta.url), 'utf8');
  assert.match(home, /id: 'community', label: '美食'/);
  for (const path of ['CommunityView', 'ShareSheet', 'FriendShareSheet', 'FamilyView']) {
    const source = readFileSync(new URL(`../src/components/${path}.vue`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /广场/);
  }
});
