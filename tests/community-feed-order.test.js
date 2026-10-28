import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryRepository } from './helpers/memory-repository.js';
import { createApplication as createSourceApplication } from '../server/application.mjs';
import { loadCloudApplication } from './helpers/cloud-bundle.js';
import { readCommunityFeedPage } from '../server/community-feed.mjs';
import { foodFeedQuery, orderFoodPosts, shuffleFoodPosts } from '../src/domain/food-feed.js';

const createApplication = process.env.KITCHEN_TEST_BUNDLE ? await loadCloudApplication(process.env.KITCHEN_TEST_BUNDLE) : createSourceApplication;

async function fixture(count = 53, pivot = 28) {
  const repository = memoryRepository();
  const posts = Array.from({ length: count }, (_, index) => ({
    _id: `post-${String(index).padStart(3, '0')}`, id: `post-${String(index).padStart(3, '0')}`,
    kind: index % 5 ? 'dish' : 'menu', status: 'published', title: `家常菜${index}`, search: `家常菜${index}`,
    categories: [index % 2 ? '荤菜' : '素菜'], createdAt: 1000 + Math.floor((count - index) / 3),
    recipes: [{ id: `recipe-${index}`, title: '家常菜', category: '荤菜', ingredients: [{ name: '食材' }], steps: [] }],
  }));
  for (const post of posts) await repository.set('posts', post.id, post);
  repository.sample = async (name, where) => {
    const candidates = await repository.list(name, where, { limit: 100 });
    return candidates.find(post => post.id === posts[pivot]?.id) || candidates[0] || null;
  };
  const query = { where: { status: 'published' }, limit: 16, fields: ['card'], sort: 'latest' };
  const page = overrides => readCommunityFeedPage(repository, { ...query, ...overrides });
  return { repository, posts, page };
}

test('latest and recommended use all foods while category mode preserves existing filters', () => {
  assert.deepEqual(foodFeedQuery('latest', '荤菜', 'session'), { type: '全部', category: '全部', sort: 'latest' });
  assert.deepEqual(foodFeedQuery('recommended', '套餐', 'session'), { type: '全部', category: '全部', sort: 'recommended', seed: 'session' });
  assert.deepEqual(foodFeedQuery('category', '荤菜', 'session'), { type: '菜品', category: '荤菜' });
  assert.deepEqual(foodFeedQuery('category', '套餐', 'session'), { type: '套餐', category: '全部' });
  assert.deepEqual(foodFeedQuery('category', '全部', 'session'), { type: '全部', category: '全部' });
});

test('local latest uses publication timestamps and seeded recommendations are stable without mutating cards', () => {
  const posts = [{ id: 'old', publishedAt: '2026-10-20T01:00:00Z' }, { id: 'unknown' }, { id: 'new', createdAt: Date.parse('2026-10-22T01:00:00Z') }];
  assert.deepEqual(orderFoodPosts(posts, 'latest').map(post => post.id), ['new', 'old', 'unknown']);
  const many = Array.from({ length: 30 }, (_, index) => ({ id: `post-${index}` }));
  assert.deepEqual(orderFoodPosts(many, 'recommended', 'one'), orderFoodPosts(many, 'recommended', 'one'));
  assert.notDeepEqual(shuffleFoodPosts(many, 'one'), shuffleFoodPosts(many, 'two'));
  assert.equal(new Set(shuffleFoodPosts(many, 'one')).size, many.length);
  assert.equal(orderFoodPosts(posts, 'category'), posts);
  assert.deepEqual(posts.map(post => post.id), ['old', 'unknown', 'new']);
});

test('latest is globally chronological across pages, including ties and undated legacy records', async () => {
  const current = await fixture();
  await current.repository.set('posts', 'legacy', { status: 'published' });
  await current.repository.set('posts', 'null-time', { status: 'published', createdAt: null });
  await current.repository.set('posts', 'removed', { status: 'deleted', createdAt: 999999 });
  const received = [];
  let cursor = '';
  do {
    const result = await current.page({ cursor });
    assert.ok(result.rows.length <= 16);
    received.push(...result.rows.map(row => row._id));
    cursor = result.cursor;
  } while (cursor);
  const expected = [...current.posts].sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id)).map(post => post.id);
  assert.deepEqual(received, [...expected, 'null-time', 'legacy']);
});

test('latest cursor survives boundary deletion and newer inserts without repeating existing cards', async () => {
  const current = await fixture();
  const first = await current.page();
  await current.repository.remove('posts', first.rows.at(-1)._id);
  await current.repository.set('posts', 'new-arrival', { status: 'published', createdAt: 999999 });
  const second = await current.page({ cursor: first.cursor });
  assert.ok(second.rows.every(row => !first.rows.some(previous => previous._id === row._id)));
  assert.equal(second.rows.some(row => row._id === 'new-arrival'), false);
  assert.equal((await current.page()).rows[0]._id, 'new-arrival');
});

test('recommendations wrap once around a random starting point and return all published cards without duplicates', async () => {
  for (const pivot of [0, 17, 50]) {
    const current = await fixture(53, pivot);
    const received = [];
    let cursor = '';
    let requests = 0;
    do {
      const query = { sort: 'recommended', seed: 'round-one', cursor };
      const result = await current.page(query);
      assert.deepEqual(result, await current.page(query));
      received.push(...result.rows.map(row => row._id));
      cursor = result.cursor;
      requests += 1;
      assert.ok(requests <= 4);
    } while (cursor);
    assert.equal(new Set(received).size, 53);
    assert.deepEqual([...received].sort(), current.posts.map(post => post.id));
    assert.notDeepEqual(received, current.posts.map(post => post.id));
  }
});

test('recommendation filters apply both before and after wrapping and preserve an empty collection', async () => {
  const current = await fixture(53, 52);
  const where = { status: 'published', kind: 'dish', categories: { contains: '荤菜' }, search: { regex: '家常菜' } };
  const rows = [];
  let cursor = '';
  do {
    const page = await current.page({ where, sort: 'recommended', seed: 'family-feed', cursor });
    rows.push(...page.rows);
    cursor = page.cursor;
  } while (cursor);
  const matching = current.posts.filter(post => post.kind === 'dish' && post.categories.includes('荤菜'));
  assert.deepEqual(rows.map(row => row._id).sort(), matching.map(post => post.id));
  const empty = await fixture(0);
  assert.deepEqual(await empty.page({ sort: 'recommended' }), { rows: [], cursor: '' });
});

test('feed cursors cannot be reused with another mode, category, search or recommendation session', async () => {
  const current = await fixture();
  const { cursor } = await current.page();
  for (const query of [{ cursor: 'invalid' }, { cursor: {} }, { cursor: 'x'.repeat(2049) }, { cursor, sort: 'recommended' }, { cursor, where: { status: 'published', kind: 'menu' } }, { cursor, where: { status: 'published', search: { regex: '菜' } } }, { sort: 'invalid' }, { sort: 'recommended', seed: {} }]) {
    await assert.rejects(current.page(query), error => error.code === 'INVALID');
  }
  const recommended = await current.page({ sort: 'recommended', seed: 'one' });
  await assert.rejects(current.page({ sort: 'recommended', seed: 'two', cursor: recommended.cursor }), error => error.code === 'INVALID');
});

test('cloud application exposes sorted compact cards and preserves category-only legacy cursors', async () => {
  const current = await fixture();
  const app = createApplication({ repository: current.repository });
  const family = await app({ action: 'createFamily', name: '测试用户', familyName: '测试家庭' }, { OPENID: 'read-only-tester' });
  assert.equal(family.ok, true, JSON.stringify(family));
  const result = await app({ action: 'feed', compact: true, sort: 'latest' }, { OPENID: 'read-only-tester' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.feedVersion, 2);
  assert.equal(result.data.posts[0].id, 'post-002');
  assert.equal(result.data.posts.length, 16);
  assert.equal(result.data.posts[0].recipes[0].ingredients, undefined);
  const category = await current.page({ sort: undefined });
  assert.equal(category.cursor, 'post-015');
  assert.equal(category.rows[0]._id, 'post-000');
});
