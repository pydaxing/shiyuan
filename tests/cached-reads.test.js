import test from 'node:test';
import assert from 'node:assert/strict';
import { createCachedReads } from '../src/services/cached-reads.js';
import { createPersistentCache } from '../src/services/persistent-cache.js';

test('concurrent detail reads share one request and warm reopen is immediate', async () => {
  let calls = 0;
  let finish;
  const reads = createCachedReads({ cache: new Map() });
  const request = () => { calls += 1; return new Promise(resolve => { finish = resolve; }); };
  const first = reads.read('me:family', 'post', request);
  const second = reads.read('me:family', 'post', request);
  assert.equal(first, second);
  await Promise.resolve();
  finish({ post: { id: 'post' } });
  await first;
  assert.equal((await reads.read('me:family', 'post', request)).post.id, 'post');
  assert.equal(calls, 1);
  assert.equal(reads.peek('other:family', 'post'), undefined);
});

test('stale detail is visible during refresh and retained on network failure, but purged on denial', async () => {
  let clock = 0;
  const reads = createCachedReads({ cache: new Map(), now: () => clock });
  await reads.read('me:family', 'post', async () => ({ title: '旧做法' }));
  clock = 30001;
  const failure = reads.read('me:family', 'post', async () => { throw new Error('offline'); });
  assert.equal(reads.peek('me:family', 'post').title, '旧做法');
  await assert.rejects(failure, /offline/);
  assert.ok(reads.peek('me:family', 'post'));
  await assert.rejects(reads.read('me:family', 'post', async () => { throw Object.assign(new Error('deleted'), { code: 'INVALID' }); }), /deleted/);
  assert.equal(reads.peek('me:family', 'post'), undefined);
});

test('mutation invalidation fences old responses and does not remove newer in-flight requests', async () => {
  const reads = createCachedReads({ cache: new Map() });
  let finishOld;
  let finishNew;
  const first = reads.read('scope', 'post', () => new Promise(resolve => { finishOld = resolve; }));
  await Promise.resolve();
  reads.clear();
  const second = reads.read('scope', 'post', () => new Promise(resolve => { finishNew = resolve; }));
  await Promise.resolve();
  finishOld({ title: 'old' });
  await assert.rejects(first, error => error.code === 'CACHE_SUPERSEDED');
  assert.equal(reads.read('scope', 'post', () => assert.fail('duplicate request')), second);
  finishNew({ title: 'new' });
  await second;
  assert.equal(reads.peek('scope', 'post').title, 'new');
});

test('details persist across module restarts and expired cache refreshes rather than remaining permanently stale', async () => {
  const disk = new Map();
  let clock = 0;
  const create = () => createCachedReads({ now: () => clock, cache: createPersistentCache('details', { now: () => clock, platform: () => ({ getStorageSync: key => disk.get(key), setStorageSync: (key, value) => disk.set(key, value) }) }) });
  await create().read('scope', 'post', async () => ({ title: '番茄炒蛋' }));
  const reopened = create();
  assert.equal((await reopened.read('scope', 'post', () => assert.fail('unnecessary request'))).title, '番茄炒蛋');
  clock = 30001;
  await reopened.read('scope', 'post', async () => ({ title: '新版做法' }));
  assert.equal(create().peek('scope', 'post').title, '新版做法');
});

test('superseded request failures cannot dismiss or purge a newer detail', async () => {
  const reads = createCachedReads({ cache: new Map() });
  let rejectOld;
  const old = reads.read('scope', 'post', () => new Promise((resolve, reject) => { rejectOld = reject; }));
  await Promise.resolve();
  reads.clear();
  await reads.read('scope', 'post', async () => ({ title: 'new' }));
  rejectOld(Object.assign(new Error('old denial'), { code: 'FORBIDDEN' }));
  await assert.rejects(old, error => error.code === 'CACHE_SUPERSEDED');
  assert.equal(reads.peek('scope', 'post').title, 'new');
});
