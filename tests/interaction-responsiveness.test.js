import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ref, nextTick } from 'vue';
import { createCommunityFeed, invalidateCommunityFeed } from '../src/services/community-feed.js';
import { createPreferenceUpdates } from '../src/services/preference-updates.js';
import { build } from 'esbuild';
import { emptySnapshot } from '../src/domain/empty.js';
import { createPersistentCache } from '../src/services/persistent-cache.js';

const all = { type: '全部', category: '全部', search: '' };
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

test('feed caches isolate latest, recommendation rounds and category results while appending stable pages', async () => {
  const calls = [];
  const feed = createCommunityFeed({ cache: new Map(), request: async query => {
    calls.push(query);
    const id = `${query.sort || query.category}:${query.seed || ''}:${query.cursor || 'first'}`;
    return { posts: [{ id }], cursor: query.cursor ? '' : 'next' };
  } });
  const latest = { ...all, sort: 'latest' };
  const recommended = { ...all, sort: 'recommended', seed: 'one' };
  await feed.select(latest, 'family');
  await feed.select(recommended, 'family');
  const first = feed.state.value.posts[0];
  await feed.refresh(true);
  assert.equal(feed.state.value.posts[0], first);
  assert.deepEqual(feed.state.value.posts.map(post => post.id), ['recommended:one:first', 'recommended:one:next']);
  await feed.select(latest, 'family');
  assert.equal(calls.length, 3);
  assert.equal(feed.state.value.posts[0].id, 'latest::first');
  await feed.select({ ...recommended, seed: 'two' }, 'family');
  assert.equal(feed.state.value.posts[0].id, 'recommended:two:first');
  await feed.select({ ...all, type: '菜品', category: '荤菜' }, 'family');
  assert.equal(feed.state.value.posts[0].id, '荤菜::first');
  assert.equal(calls.length, 5);
  feed.dispose();
});

test('first feed visit starts immediately and never presents an unloaded list as empty', async () => {
  const response = deferred();
  const calls = [];
  const feed = createCommunityFeed({ cache: new Map(), request: query => { calls.push(query); return response.promise; } });
  const loading = feed.select(all, 'family');
  assert.equal(calls.length, 1);
  assert.equal(feed.state.value.loading, true);
  assert.equal(feed.state.value.ready, false);
  response.resolve({ posts: [], cursor: '' });
  await loading;
  assert.equal(feed.state.value.ready, true);
  assert.equal(feed.state.value.loading, false);
});

test('a feed request survives leaving the tab and returning shares the in-flight request', async () => {
  const response = deferred();
  const cache = new Map();
  let calls = 0;
  const request = () => { calls += 1; return response.promise; };
  const first = createCommunityFeed({ cache, request });
  const loading = first.select(all, 'family');
  first.dispose();
  const second = createCommunityFeed({ cache, request });
  const returning = second.select(all, 'family');
  response.resolve({ posts: [], cursor: '' });
  await Promise.all([loading, returning]);
  await second.select({ ...all, type: '菜品', category: '饮品' }, 'family');
  await second.select({ ...all, type: '套餐' }, 'family');
  assert.equal(calls, 1);
  assert.equal(second.state.value.ready, true);
  assert.equal(second.state.value.loading, false);
});

test('rapid preference changes batch the latest intent without delaying visible values', async () => {
  const requests = [];
  const updates = createPreferenceUpdates({ getScope: () => 'family:me', isBusy: () => false, debounceMs: 1, sendBatch: async values => requests.push(values) });
  const waiting = [updates.update('fridge', true), updates.update('chef', true), updates.update('fridge', false), updates.update('shopping', false)];
  assert.equal(updates.value('chef', false), true);
  assert.equal(updates.value('fridge', true), false);
  await Promise.all(waiting);
  assert.deepEqual(requests, [{ fridge: false, chef: true, shopping: false }]);
  assert.deepEqual(updates.pending.value, {});
});

test('switching back uses cached cards immediately, without another network wait', async () => {
  const cache = new Map();
  let calls = 0;
  const request = async () => { calls += 1; return { posts: [{ id: 'dish' }], cursor: 'page-2' }; };
  const first = createCommunityFeed({ cache, request });
  await first.select(all, 'family');
  first.dispose();
  const second = createCommunityFeed({ cache, request });
  second.select(all, 'family');
  assert.equal(second.state.value.posts[0].id, 'dish');
  assert.equal(second.state.value.loading, false);
  assert.equal(calls, 1);
});

test('stale cache stays visible while refreshing and errors are not reported as empty results', async () => {
  let clock = 0;
  const response = deferred();
  let calls = 0;
  const feed = createCommunityFeed({ cache: new Map(), now: () => clock, request: () => ++calls === 1 ? Promise.resolve({ posts: [{ id: 'dish' }] }) : response.promise });
  await feed.select(all, 'family');
  clock = 121000;
  const refreshing = feed.select(all, 'family');
  assert.equal(feed.state.value.posts[0].id, 'dish');
  assert.equal(feed.state.value.loading, true);
  response.reject(new Error('网络暂不可用'));
  await refreshing;
  assert.equal(feed.state.value.posts.length, 1);
  assert.equal(feed.state.value.error, '网络暂不可用');
});

test('typing marks the feed loading immediately and superseded responses cannot flash into new filters', async () => {
  const response = deferred();
  const feed = createCommunityFeed({ cache: new Map(), request: () => response.promise });
  const first = feed.select(all, 'family');
  feed.select({ ...all, search: '汤' }, 'family', { delay: 220 });
  assert.equal(feed.state.value.loading, true);
  response.resolve({ posts: [{ id: 'unrelated' }] });
  await first;
  assert.deepEqual(feed.state.value.posts, []);
  assert.equal(feed.state.value.ready, false);
  feed.dispose();
});

test('feed failures can retry, pagination deduplicates, and families do not share cache entries', async () => {
  let failed = true;
  const calls = [];
  const feed = createCommunityFeed({ cache: new Map(), request: async query => {
    calls.push(query);
    if (failed) throw new Error('请重试');
    return { posts: query.cursor ? [{ id: 'one' }, { id: 'two' }] : [{ id: 'one' }], cursor: query.cursor ? '' : 'next' };
  } });
  await feed.select(all, 'family-1');
  assert.equal(feed.state.value.ready, false);
  assert.equal(feed.state.value.loading, false);
  failed = false;
  await feed.refresh();
  await feed.refresh(true);
  assert.deepEqual(feed.state.value.posts.map(post => post.id), ['one', 'two']);
  assert.equal(calls.at(-1).cursor, 'next');
  const next = feed.select(all, 'family-2');
  assert.deepEqual(feed.state.value.posts, []);
  await next;
  assert.equal(calls.length, 4);
});

test('identity reset invalidates feed cache, including requests started before invalidation', async () => {
  invalidateCommunityFeed();
  const response = deferred();
  const feed = createCommunityFeed({ request: () => response.promise });
  const first = feed.select(all, 'family');
  invalidateCommunityFeed();
  response.resolve({ posts: [{ id: 'removed' }] });
  await first;
  let requested = false;
  const next = createCommunityFeed({ request: async () => { requested = true; return { posts: [] }; } });
  await next.select(all, 'family');
  assert.equal(requested, true);
  assert.deepEqual(next.state.value.posts, []);
  invalidateCommunityFeed();
});

test('feed pages survive restart and bounded cached pagination keeps the matching continuation cursor', async () => {
  const disk = new Map();
  const createCache = () => createPersistentCache('feed', { platform: () => ({ getStorageSync: key => disk.get(key), setStorageSync: (key, value) => disk.set(key, value) }) });
  const calls = [];
  const request = async query => {
    const start = Number(query.cursor || 0);
    calls.push(start);
    return { posts: Array.from({ length: 24 }, (_, index) => ({ id: `post-${start + index}` })), cursor: String(start + 24) };
  };
  const first = createCommunityFeed({ cache: createCache(), request });
  await first.select(all, 'me:family');
  await first.refresh(true);
  await first.refresh(true);
  assert.equal(first.state.value.posts.length, 72);
  first.dispose();
  const restarted = createCommunityFeed({ cache: createCache(), request });
  await restarted.select(all, 'me:family');
  assert.equal(restarted.state.value.posts.length, 48);
  assert.equal(restarted.state.value.cursor, '48');
  assert.deepEqual(calls, [0, 24, 48]);
  await restarted.refresh(true);
  assert.equal(restarted.state.value.posts.length, 72);
  assert.equal(restarted.state.value.posts.at(-1).id, 'post-71');
  assert.deepEqual(calls, [0, 24, 48, 48]);
});

function preferenceHarness(initialBusy = false) {
  const busy = ref(initialBusy);
  const scope = ref('family:me');
  const saved = { chef: false, fridge: false, shopping: true };
  const requests = [];
  const updates = createPreferenceUpdates({ getScope: () => scope.value, isBusy: () => busy.value, send: (key, value) => {
    busy.value = true;
    const result = deferred();
    requests.push({ key, value, ...result });
    return result.promise.then(() => { saved[key] = value; }).finally(() => { busy.value = false; });
  } });
  return { updates, busy, scope, saved, requests };
}

test('switches update in the same turn before the cloud responds and retain confirmed state separately', async () => {
  const app = preferenceHarness();
  const saving = app.updates.update('fridge', true);
  assert.equal(app.updates.value('fridge', app.saved.fridge), true);
  assert.equal(app.saved.fridge, false);
  assert.equal(app.requests.length, 1);
  app.requests[0].resolve();
  await saving;
  assert.equal(app.saved.fridge, true);
  assert.deepEqual(app.updates.pending.value, {});
});

test('quick changes are serialized and only the latest queued intent is sent', async () => {
  const app = preferenceHarness();
  const first = app.updates.update('fridge', true);
  const second = app.updates.update('fridge', false);
  const superseded = app.updates.update('fridge', true);
  const last = app.updates.update('fridge', false);
  const chef = app.updates.update('chef', true);
  assert.equal(await second, false);
  assert.equal(await superseded, false);
  assert.equal(app.updates.value('fridge', false), false);
  assert.equal(app.updates.value('chef', false), true);
  assert.equal(app.requests.length, 1);
  app.requests[0].resolve();
  await first;
  assert.equal(app.updates.value('fridge', app.saved.fridge), false);
  assert.deepEqual(app.requests.map(({ key, value }) => [key, value]), [['fridge', true], ['fridge', false]]);
  app.requests[1].resolve();
  await last;
  app.requests[2].resolve();
  await chef;
  assert.deepEqual(app.saved, { chef: true, fridge: false, shopping: true });
});

test('failed switch saves roll back and other queued switches still save', async () => {
  const app = preferenceHarness();
  const failed = app.updates.update('fridge', true);
  const rejection = assert.rejects(failed, /网络/);
  const next = app.updates.update('chef', true);
  app.requests[0].reject(new Error('网络不可用'));
  await rejection;
  assert.equal(app.updates.value('fridge', app.saved.fridge), false);
  assert.equal(app.updates.value('chef', app.saved.chef), true);
  app.requests[1].resolve();
  await next;
});

test('switches wait behind another save without losing taps, and pending values are scoped to the family', async () => {
  const app = preferenceHarness(true);
  const saving = app.updates.update('chef', true);
  assert.equal(app.requests.length, 0);
  assert.equal(app.updates.value('chef', false), true);
  app.scope.value = 'another-family:me';
  assert.equal(app.updates.value('chef', false), false);
  app.busy.value = false;
  await nextTick();
  await saving;
  assert.equal(app.requests.length, 0);
  assert.deepEqual(app.updates.pending.value, {});
});

test('a revision conflict retries a boolean preference once after the cloud refresh', async () => {
  const app = preferenceHarness();
  const saving = app.updates.update('chef', true);
  app.requests[0].reject(Object.assign(new Error('家人更新'), { code: 'CONFLICT' }));
  await flush();
  assert.equal(app.requests.length, 2);
  assert.equal(app.updates.value('chef', false), true);
  app.requests[1].resolve();
  await saving;
});

test('real cloud store keeps navigation optimistic while commands use confirmed revisions', async () => {
  const built = await build({ entryPoints: ['src/store.js'], bundle: true, platform: 'node', format: 'esm', write: false, define: { 'import.meta.env': JSON.stringify({ VITE_DATA_MODE: 'cloud', VITE_CLOUD_ENV: 'test-only' }) } });
  const requests = [];
  const storage = new Map();
  globalThis.wx = { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), cloud: { init() {}, callFunction({ data }) { const result = deferred(); requests.push({ ...result, data }); return result.promise; } } };
  const store = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
  store.cloudStatus.value = { phase: 'ready', familyId: 'family', revision: 1, busy: false };
  const saving = store.setFeature('fridge', true);
  const chef = store.setChef(true);
  assert.equal(store.familyFeatures.value.fridge, true);
  assert.equal(store.state.value.family.features.fridge, true);
  assert.equal(saving.accepted, true);
  assert.equal(chef.accepted, true);
  assert.equal(store.cloudStatus.value.busy, false);
  assert.equal(store.preferencePending.value, true);
  await new Promise(resolve => setTimeout(resolve, 140));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].data.name, 'setFeature');
  assert.deepEqual(requests[0].data.args, ['fridge', true]);
  const snapshot = emptySnapshot();
  snapshot.family.features.fridge = true;
  requests[0].resolve({ result: { ok: true, data: { snapshot, familyId: 'family', revision: 2 } } });
  await saving;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[1].data.name, 'setChef');
  assert.equal(requests[1].data.revision, 2);
  snapshot.family.members[0].isChef = true;
  requests[1].resolve({ result: { ok: true, data: { snapshot, familyId: 'family', revision: 3 } } });
  await chef;
  const failed = store.setChef(false);
  await new Promise(resolve => setTimeout(resolve, 140));
  assert.equal(requests[2].data.revision, 3);
  requests[2].resolve({ result: { ok: false, code: 'FORBIDDEN', message: '不允许修改' } });
  await assert.rejects(failed, /不允许/);
  assert.equal(store.preferencePending.value, false);
  assert.equal(store.familyFeatures.value.fridge, true);
});

test('tabs and editor entries retain their shared feedback hook and synchronous click handlers', () => {
  for (const [file, model] of [['src/components/ShareSheet.vue', 'type']]) {
    const source = readFileSync(file, 'utf8');
    assert.ok(source.includes(`@click="$feedback(); ${model} = entry"`), file);
  }
  const home = readFileSync('src/pages/index/index.vue', 'utf8');
  const menu = readFileSync('src/components/HomeMenu.vue', 'utf8');
  assert.match(menu, /@click="railGesture\.tap"/);
  assert.match(menu, /owner\.callMethod\('selectCategory', event\.currentTarget\.dataset\.category\)/);
  assert.match(menu, /emit\('update:category', category\);[\s\S]*?moveTo\(category\)/);
  assert.match(home, /@create="openCreate"/);
  assert.match(home, /function createDish\(recipe = null\) \{ tapFeedback\(\)/);
  assert.match(home, /function createSet\(mealSet = null\) \{ tapFeedback\(\)/);
  const community = readFileSync('src/components/CommunityView.vue', 'utf8');
  assert.match(community, /@click="\$feedback\(\); mode = 'latest'"/);
  assert.match(community, /@click="\$feedback\(\); mode = 'recommended'"/);
  assert.match(community, /@update:model-value="selectCategory"/);
  assert.match(readFileSync('src/components/SelectField.vue', 'utf8'), /@click="\$feedback\(\); choose\(option\)"/);
  assert.match(community, /feed.ready && !feed.error/);
  assert.match(community, /class="feed-skeleton(?: [^"]*)?"/);
});
