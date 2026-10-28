import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersistentCache, flushPersistentCaches } from '../src/services/persistent-cache.js';

test('deferred caches update memory immediately, coalesce disk writes and flush on app hide', () => {
  const { disk, create } = fixture({ writeDelay: 150 });
  const cache = create();
  cache.set('family', { name: '第一次' });
  cache.set('family', { name: '最后一次' });
  assert.equal(cache.get('family').name, '最后一次');
  assert.equal(disk.has('cache'), false);
  flushPersistentCaches();
  assert.equal(create().get('family').name, '最后一次');
  cache.set('family', { name: '不能恢复的旧家庭' });
  cache.clear();
  flushPersistentCaches();
  assert.equal(disk.has('cache'), false);
});

function fixture(options = {}) {
  const disk = new Map();
  const platform = () => ({ getStorageSync: key => disk.get(key), setStorageSync: (key, value) => disk.set(key, value), removeStorageSync: key => disk.delete(key) });
  return { disk, create: (key = 'cache') => createPersistentCache(key, { platform, now: () => 1000, ...options }) };
}

test('durable cache survives restart, isolates namespaces and does not expose mutable references', () => {
  const { create } = fixture();
  const source = { recipes: [{ title: '番茄炒蛋' }] };
  create().set('family', source);
  source.recipes[0].title = 'changed';
  const cache = create();
  assert.equal(cache.get('family').recipes[0].title, '番茄炒蛋');
  cache.get('family').recipes.push({ title: 'local edit' });
  assert.equal(cache.get('family').recipes.length, 1);
  assert.equal(create('other').get('family'), undefined);
  cache.clear();
  assert.equal(create().get('family'), undefined);
});

test('bounded storage evicts oldest writes and refuses to retain oversized payloads', () => {
  const { create, disk } = fixture({ maxEntries: 2, maxChars: 250 });
  const cache = create();
  cache.set('first', 1); cache.set('second', 2); cache.set('first', 3); cache.set('third', 4);
  assert.deepEqual([...cache.keys()], ['first', 'third']);
  assert.equal(create().size, 2);
  assert.ok(disk.get('cache').length <= 250);
  cache.set('huge', 'x'.repeat(300));
  assert.equal(cache.get('huge'), undefined);
  assert.equal(disk.has('cache'), false);
});

test('malformed storage, invalid records, expired and future timestamps safely fall back to cache misses', () => {
  const { disk, create } = fixture({ maxAge: 100 });
  for (const raw of ['broken', 'null', '{}', JSON.stringify({ version: 1, entries: [null] }), JSON.stringify({ version: 1, entries: [['no-value', { savedAt: 1000 }], ['expired', { savedAt: 899, value: 1 }], ['future', { savedAt: 1001, value: 2 }]] })]) {
    disk.set('cache', raw);
    assert.equal(create().size, 0);
    assert.equal(create().get('no-value'), undefined);
  }
});

test('expiry also applies within a session and schema validators reject corrupt valid JSON', () => {
  let clock = 1;
  const { create, disk } = fixture({ now: () => clock, maxAge: 100, validate: value => Array.isArray(value?.posts) });
  const cache = create();
  cache.set('valid', { posts: [] });
  cache.set('bad', { posts: null });
  assert.equal(cache.size, 1);
  clock = 102;
  assert.equal(cache.get('valid'), undefined);
  disk.set('cache', JSON.stringify({ version: 1, entries: [['bad', { savedAt: 102, value: { posts: 1 } }]] }));
  assert.equal(create().size, 0);
});

test('unavailable native storage never blocks reading or saving application state', () => {
  const cache = createPersistentCache('cache', { platform: () => { throw new Error('storage full'); } });
  cache.set('family', { name: '我家' });
  assert.equal(cache.get('family').name, '我家');
  cache.delete('family');
  assert.equal(cache.size, 0);
  assert.doesNotThrow(() => cache.clear());
});
