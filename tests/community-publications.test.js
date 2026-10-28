import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { computed, ref, reactive, watch, effectScope, nextTick } from 'vue';
import { createSeed } from '../src/data/seed.js';
import { normalizeSnapshot } from '../src/domain/kitchen.js';
import { createKitchenActions } from '../src/domain/actions.js';
import { familyPublications, publishedFamilyKeys, publicationKey } from '../src/domain/community-publications.js';
import { publicationStatusMatches, readLegacyPublicationStatus } from '../src/services/legacy-publication-status.js';

function localFixture() {
  let state = normalizeSnapshot(createSeed());
  state.family.id = 'home';
  let sequence = 0;
  const actions = createKitchenActions({ getState: () => state, commit: value => { state = value; }, newId: prefix => `${prefix}-${++sequence}` });
  return { get state() { return state; }, actions };
}

test('family sharing blocks duplicate dishes and sets across members, not across similarly named items', () => {
  const context = localFixture();
  const dish = context.state.recipes[0];
  const set = { id: dish.id, title: dish.title, recipeIds: context.state.recipes.slice(0, 2).map(item => item.id) };
  context.state.mealSets.push(set);
  const postId = context.actions.publishToCommunity(dish.id);
  const before = structuredClone(context.state);
  assert.throws(() => context.actions.publishToCommunity(dish.id), error => error.code === 'ALREADY_SHARED');
  assert.deepEqual(context.state, before);
  context.state.activeMemberId = context.state.family.members[1].id;
  assert.throws(() => context.actions.publishToCommunity(dish.id), /已分享/);
  context.actions.publishToCommunity(set.id, 'set');
  assert.throws(() => context.actions.publishToCommunity(set.id, 'set'), /已分享/);
  context.state.recipes.push({ ...dish, id: 'another-dish' });
  context.actions.publishToCommunity('another-dish');
  assert.equal(context.state.posts.filter(post => post.familyItemId === dish.id).length, 2);
  assert.ok(familyPublications(context.state).some(item => item.postId === postId));
});

test('deleting a permitted share frees only that source item for publishing again', () => {
  const context = localFixture();
  const [first, second] = context.state.recipes;
  const post = context.actions.publishToCommunity(first.id);
  context.actions.publishToCommunity(second.id);
  context.actions.deleteCommunityPost(post);
  assert.equal(publishedFamilyKeys(context.state).has(publicationKey('dish', first.id)), false);
  assert.equal(publishedFamilyKeys(context.state).has(publicationKey('dish', second.id)), true);
  context.actions.publishToCommunity(first.id);
  assert.equal(context.state.posts.length, 2);
});

test('legacy local publications ignore other households and deleted posts, and authoritative summaries win', () => {
  const snapshot = { family: { id: 'home', members: [{ id: 'me' }] }, posts: [
    { id: 'mine', familyId: 'home', familyItemId: 'rice', familyKind: 'dish', publisherId: 'me' },
    { id: 'unscoped', familyItemId: 'soup', familyKind: 'dish', publisherId: 'me', author: '我家' },
    { id: 'old', familyItemId: 'soup', familyKind: 'dish', publisherId: 'me', status: 'deleted' },
    { id: 'foreign', familyId: 'elsewhere', familyItemId: 'rice', familyKind: 'set', publisherId: 'me' },
  ] };
  assert.deepEqual([...publishedFamilyKeys(snapshot)], ['dish:rice']);
  snapshot.sharedItems = [];
  assert.deepEqual([...publishedFamilyKeys(snapshot)], []);
});

const componentSource = readFileSync(new URL('../src/components/ShareSheet.vue', import.meta.url), 'utf8');
const componentScript = componentSource.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;$/gm, '');
function sheetFixture({ cloud = false, itemId, kind = 'dish', publish, refresh, request } = {}) {
  const scope = effectScope();
  const seed = normalizeSnapshot(createSeed());
  seed.mealSets = [{ id: 'menu', title: '双人套餐', recipeIds: seed.recipes.slice(0, 2).map(item => item.id) }];
  const state = ref({ ...seed, family: { ...seed.family, id: 'home', revision: 1 }, sharedItems: [] });
  const events = [];
  const calls = [];
  let unmount;
  const sheet = scope.run(() => runInNewContext(`${componentScript}\n;({ entries, filtered, selectedKey, selected, confirming, canPublish, busy, error, ready, syncing, syncShares, select, next, publish });`, {
    computed, ref, watch, state, cloudMode: cloud, publishedFamilyKeys, publicationStatusMatches, readLegacyPublicationStatus,
    defineProps: () => ({ itemId, kind }), defineEmits: () => (...args) => events.push(args),
    onMounted: () => {}, onUnmounted: callback => { unmount = callback; },
    notify: () => {}, refreshCloud: async () => { if (refresh) await refresh(state); },
    invokeCloud: async (...args) => { assert.ok(request, 'unexpected publication lookup'); return request(...args); },
    publishToCommunity: async (...args) => { calls.push(args); if (publish) return publish(); },
  }));
  return { ...sheet, state, calls, events, stop: () => { unmount(); scope.stop(); } };
}

test('share picker marks and disables published dishes and packages without hiding them', () => {
  const sheet = sheetFixture();
  const dish = sheet.entries.value.find(entry => entry.kind === 'dish');
  const set = sheet.entries.value.find(entry => entry.kind === 'set');
  assert.ok(set);
  sheet.state.value.sharedItems = [dish, set].map(item => ({ itemId: item.id, kind: item.kind, postId: `post-${item.kind}` }));
  for (const key of [dish.key, set.key]) {
    const entry = sheet.entries.value.find(item => item.key === key);
    assert.equal(entry.shared, true);
    sheet.select(entry);
    assert.equal(sheet.selectedKey.value, '');
  }
  assert.equal(sheet.filtered.value.length, sheet.entries.value.length);
  assert.match(componentSource, /:disabled="busy \|\| syncing \|\| !ready \|\| entry.shared"/);
  assert.match(componentSource, /v-if="entry.shared" class="share-published-label">已分享/);
  sheet.stop();
});

test('live publication blocks an already selected item in the confirmation step', async () => {
  const sheet = sheetFixture();
  const selected = sheet.entries.value[0];
  sheet.select(selected); sheet.next();
  assert.equal(sheet.confirming.value, true);
  sheet.state.value.sharedItems.push({ kind: selected.kind, itemId: selected.id, postId: 'published-elsewhere' });
  assert.equal(Boolean(sheet.canPublish.value), false);
  await sheet.publish(); assert.equal(sheet.calls.length, 0);
  sheet.stop();
});

test('direct dish and package confirmation respects the same already-shared guard', async () => {
  for (const [kind, itemId] of [['dish', 'tomato'], ['set', 'menu']]) {
    const sheet = sheetFixture({ kind, itemId });
    assert.equal(sheet.confirming.value, true);
    assert.equal(Boolean(sheet.canPublish.value), true);
    sheet.state.value.sharedItems = [{ kind, itemId, postId: 'existing-share' }];
    assert.equal(sheet.selected.value.shared, true);
    assert.equal(sheet.canPublish.value, false);
    await sheet.publish();
    assert.equal(sheet.calls.length, 0);
    sheet.stop();
  }
});

test('unknown publication status stays disabled on sync failure and can be retried', async () => {
  let unavailable = true;
  const sheet = sheetFixture({ cloud: true, refresh: async state => {
    if (unavailable) throw new Error('连接失败，请重试');
    state.value.sharedItems = [];
  } });
  delete sheet.state.value.sharedItems;
  await sheet.syncShares();
  assert.equal(sheet.error.value, '连接失败，请重试');
  assert.equal(sheet.ready.value, false);
  assert.equal(sheet.syncing.value, false);
  sheet.select(sheet.entries.value[0]);
  assert.equal(sheet.selectedKey.value, '');
  unavailable = false;
  await sheet.syncShares();
  assert.equal(sheet.ready.value, true);
  assert.equal(sheet.error.value, '');
  sheet.select(sheet.entries.value[0]);
  assert.equal(Boolean(sheet.canPublish.value), true);
  sheet.stop();
});

test('a legacy cloud response without sharedItems recovers from verified publication records', async () => {
  const requests = [];
  const sheet = sheetFixture({ cloud: true, request: async (action, payload) => {
    requests.push({ action, payload });
    const dish = sheet.state.value.recipes[0];
    if (action === 'feed') return { posts: [{ id: 'shared-dish', kind: 'dish', familyItemId: dish.id }], cursor: '' };
    if (action === 'readPost') return { post: { id: 'shared-dish', kind: 'dish', familyItemId: dish.id, familyId: 'home', status: 'published' } };
    assert.equal(action, 'bootstrap');
    return { unchanged: true, familyId: 'home', userId: sheet.state.value.activeMemberId, revision: 1 };
  } });
  delete sheet.state.value.sharedItems;
  await sheet.syncShares();
  assert.equal(sheet.error.value, '');
  assert.equal(sheet.ready.value, true);
  const shared = sheet.entries.value.find(entry => entry.id === sheet.state.value.recipes[0].id);
  assert.equal(shared.shared, true);
  sheet.select(shared);
  assert.equal(sheet.selectedKey.value, '');
  sheet.select(sheet.entries.value.find(entry => !entry.shared));
  assert.equal(Boolean(sheet.canPublish.value), true);
  assert.equal(sheet.calls.length, 0);
  assert.equal(sheet.state.value.sharedItems, undefined);
  assert.deepEqual(requests.map(entry => entry.action), ['feed', 'readPost', 'bootstrap']);
  sheet.stop();
});

test('modern cloud summaries stay authoritative without a legacy feed lookup', async () => {
  const sheet = sheetFixture({ cloud: true, refresh: async state => {
    state.value.sharedItems = [{ kind: 'dish', itemId: state.value.recipes[0].id, postId: 'shared' }];
  } });
  delete sheet.state.value.sharedItems;
  await sheet.syncShares();
  assert.equal(sheet.ready.value, true);
  assert.equal(sheet.error.value, '');
  assert.equal(sheet.entries.value.find(entry => entry.kind === 'dish').shared, true);
  sheet.stop();
});

test('legacy lookup failure keeps selection disabled and a successful retry recovers', async () => {
  let unavailable = true;
  const sheet = sheetFixture({ cloud: true, request: async action => {
    if (action === 'feed') {
      if (unavailable) throw new Error('分享清单读取失败');
      return { posts: [], cursor: '' };
    }
    assert.equal(action, 'bootstrap');
    return { familyId: 'home', userId: sheet.state.value.activeMemberId, revision: 1 };
  } });
  delete sheet.state.value.sharedItems;
  await sheet.syncShares();
  assert.equal(sheet.ready.value, false);
  assert.equal(sheet.syncing.value, false);
  assert.equal(sheet.error.value, '分享清单读取失败');
  sheet.select(sheet.entries.value[0]);
  assert.equal(sheet.selectedKey.value, '');
  unavailable = false;
  await sheet.syncShares();
  assert.equal(sheet.ready.value, true);
  assert.equal(sheet.error.value, '');
  sheet.select(sheet.entries.value[0]);
  assert.equal(Boolean(sheet.canPublish.value), true);
  assert.equal(sheet.state.value.sharedItems, undefined);
  assert.equal(sheet.calls.length, 0);
  sheet.stop();
});

test('family revision changes invalidate local compatibility status until resynced', async () => {
  const sheet = sheetFixture({ cloud: true, request: async action => action === 'feed'
    ? { posts: [], cursor: '' }
    : { familyId: 'home', userId: sheet.state.value.activeMemberId, revision: sheet.state.value.family.revision } });
  delete sheet.state.value.sharedItems;
  await sheet.syncShares();
  sheet.select(sheet.entries.value[0]);
  assert.equal(Boolean(sheet.canPublish.value), true);
  sheet.state.value.family.revision += 1;
  assert.equal(sheet.ready.value, false);
  assert.equal(Boolean(sheet.canPublish.value), false);
  await sheet.publish();
  assert.equal(sheet.calls.length, 0);
  await sheet.syncShares();
  assert.equal(sheet.ready.value, true);
  assert.equal(Boolean(sheet.canPublish.value), true);
  sheet.stop();
});

test('syncing blocks selection and repeated retries even when old summary data exists', async () => {
  let release;
  let refreshes = 0;
  const sheet = sheetFixture({ cloud: true, refresh: () => {
    refreshes += 1;
    return new Promise(resolve => { release = resolve; });
  } });
  sheet.select(sheet.entries.value[0]);
  const selected = sheet.selectedKey.value;
  const pending = sheet.syncShares();
  assert.equal(sheet.syncing.value, true);
  sheet.select(sheet.entries.value[1]);
  assert.equal(sheet.selectedKey.value, selected);
  assert.equal(Boolean(sheet.canPublish.value), false);
  await sheet.syncShares();
  await sheet.publish();
  assert.equal(refreshes, 1);
  assert.equal(sheet.calls.length, 0);
  release();
  await pending;
  assert.equal(sheet.syncing.value, false);
  assert.equal(Boolean(sheet.canPublish.value), true);
  sheet.stop();
});

test('closing or switching members during refresh cannot start a stale compatibility lookup', async () => {
  for (const close of [true, false]) {
    let release;
    const sheet = sheetFixture({ cloud: true, refresh: () => new Promise(resolve => { release = resolve; }) });
    delete sheet.state.value.sharedItems;
    const pending = sheet.syncShares();
    if (close) sheet.stop();
    else { sheet.state.value.activeMemberId = 'other-member'; await nextTick(); }
    release();
    await pending;
    assert.equal(sheet.ready.value, false);
    assert.equal(sheet.error.value, '');
    assert.equal(sheet.syncing.value, false);
    if (!close) {
      assert.equal(sheet.events.at(-1)[0], 'close');
      sheet.stop();
    }
  }
});

test('old cloud caches cannot publish until full status is known; family changes clear selection', async () => {
  const sheet = sheetFixture({ cloud: true });
  delete sheet.state.value.sharedItems;
  sheet.select(sheet.entries.value[0]);
  await sheet.publish();
  assert.equal(sheet.ready.value, false); assert.equal(sheet.calls.length, 0);
  sheet.state.value.sharedItems = [];
  sheet.select(sheet.entries.value[0]);
  sheet.state.value.family.id = 'another-family'; await nextTick();
  assert.equal(sheet.selectedKey.value, '');
  assert.equal(sheet.events.at(-1)[0], 'close');
  sheet.stop();
});

test('a failed publish retains the selection and blocks duplicate taps while saving', async () => {
  let reject;
  const sheet = sheetFixture({ publish: () => new Promise((resolve, failure) => { reject = failure; }) });
  sheet.select(sheet.entries.value[0]);
  const key = sheet.selectedKey.value;
  const saving = sheet.publish();
  await sheet.publish();
  sheet.select(sheet.entries.value[1]);
  assert.equal(sheet.calls.length, 1); assert.equal(sheet.selectedKey.value, key);
  reject(new Error('网络不稳定')); await saving;
  assert.equal(sheet.error.value, '网络不稳定'); assert.equal(sheet.selectedKey.value, key);
  sheet.stop();
});
