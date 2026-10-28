import test from 'node:test';
import { DEFAULT_DISH_COVER } from '../src/domain/presentation.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createPreparedShares, familyShareContext } from '../src/services/prepared-shares.js';
import { dishShareCard } from '../src/services/native-share.js';

const moment = Date.parse('2026-09-11T08:00:00Z');
const result = (token = 'a') => ({ token: token.repeat(48), expiresAt: moment + 30 * 86400000, kind: 'dish', title: '番茄炒蛋', image: 'cloud://food' });
const context = (extra = {}) => ({ scope: 'alice:family', familyId: 'family', itemId: 'recipe', kind: 'dish', fingerprint: 'v1', ...extra });
const deferred = () => { let resolve; let reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };

test('share preparation deduplicates simultaneous opens and returns a valid cached card immediately', async () => {
  const pending = deferred();
  let requests = 0;
  const cache = createPreparedShares({ now: () => moment, request: payload => { requests += 1; assert.equal(payload.itemId, 'recipe'); return pending.promise; } });
  const first = cache.prepare(context());
  assert.equal(cache.prepare(context()), first);
  assert.equal(cache.peek(context()), null);
  pending.resolve(result());
  await first;
  assert.equal(cache.peek(context()).token, result().token);
  assert.equal(cache.prepare(context()), first);
  assert.equal(requests, 1);
});

test('changed recipe content, account, household and share type never reuse another link', async () => {
  for (const next of [{ fingerprint: 'v2' }, { scope: 'bob:family' }, { scope: 'alice:parents', familyId: 'parents' }, { kind: 'set' }]) {
    let requests = 0;
    const cache = createPreparedShares({ now: () => moment, request: async () => result(++requests === 1 ? 'a' : 'b') });
    await cache.prepare(context());
    assert.equal(cache.peek(context(next)), null);
    assert.equal((await cache.prepare(context(next))).token, result('b').token);
  }
});

test('late preparation cannot repopulate a cleared or replaced share cache', async () => {
  for (const change of [cache => cache.clear(), cache => cache.peek(context({ scope: 'other:family' })), cache => cache.peek(context({ fingerprint: 'edited' }))]) {
    const pending = deferred();
    const cache = createPreparedShares({ now: () => moment, request: () => pending.promise });
    const promise = cache.prepare(context());
    change(cache);
    pending.resolve(result());
    await assert.rejects(promise, /变更/);
    assert.equal(cache.peek(context()), null);
  }
});

test('failed and malformed preparations are retryable and never become share buttons', async () => {
  for (const invalid of [null, { ...result(), token: '' }, { ...result(), expiresAt: moment + 5000 }]) {
    let requests = 0;
    const cache = createPreparedShares({ now: () => moment, request: async () => ++requests === 1 ? invalid : result() });
    await assert.rejects(cache.prepare(context()));
    assert.equal(cache.peek(context()), null);
    assert.equal((await cache.prepare(context())).token, result().token);
  }
  let requests = 0;
  const cache = createPreparedShares({ now: () => moment, request: async () => { if (++requests === 1) throw new Error('离线'); return result(); } });
  await assert.rejects(cache.prepare(context()), /离线/);
  await cache.prepare(context());
  assert.equal(requests, 2);
});

test('share cache expires early, stays bounded and does not reuse expiring links', async () => {
  let clock = moment;
  const cache = createPreparedShares({ now: () => clock, maxEntries: 2, request: async () => ({ ...result(), expiresAt: moment + 120000 }) });
  await cache.prepare(context());
  clock += 60001;
  assert.equal(cache.peek(context()), null);
  clock = moment;
  for (const itemId of ['first', 'second', 'third']) await cache.prepare(context({ itemId }));
  assert.equal(cache.peek(context({ itemId: 'first' })), null);
  assert.ok(cache.peek(context({ itemId: 'third' })));
});

function fixture() {
  return {
    snapshot: { family: { name: '小家' }, recipes: [{ id: 'recipe', title: '番茄炒蛋', ingredients: [{ name: '番茄', unit: '个', quantity: 2 }], steps: [{ text: '翻炒' }] }, { id: 'other', title: '青菜' }], mealSets: [{ id: 'set', title: '两菜套餐', recipeIds: ['recipe', 'other'] }], orders: [] },
    session: { phase: 'ready', userId: 'alice', familyId: 'family' },
  };
}

test('set fingerprints include every dish; unrelated orders do not invalidate cached shares', () => {
  const { snapshot, session } = fixture();
  const selection = { itemId: 'set', kind: 'set' };
  const original = familyShareContext(snapshot, session, selection);
  snapshot.orders.push({ id: 'dinner' });
  assert.deepEqual(familyShareContext(snapshot, session, selection), original);
  snapshot.recipes[0].steps[0].text = '小火慢炒';
  assert.notEqual(familyShareContext(snapshot, session, selection).fingerprint, original.fingerprint);
  snapshot.recipes.pop();
  assert.equal(familyShareContext(snapshot, session, selection), null);
  assert.equal(familyShareContext(snapshot, { ...session, phase: 'onboarding' }, selection), null);
  assert.equal(familyShareContext(snapshot, session, null), null);
});

function controller(request, cloudMode = true) {
  const source = readFileSync(new URL('../src/composables/useFriendShare.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export function', 'function');
  const data = fixture();
  const state = Vue.ref(data.snapshot);
  const cloudStatus = Vue.ref(data.session);
  const opened = [];
  const notices = [];
  const disposals = [];
  const scope = Vue.effectScope();
  let actions;
  scope.run(() => {
    const factory = new Function('computed', 'ref', 'watch', 'onUnmounted', 'state', 'cloudMode', 'cloudStatus', 'notify', 'invokeCloud', 'resolveImage', 'createPreparedShares', 'familyShareContext', 'dishShareCard', `${source}; return useFriendShare;`)(Vue.computed, Vue.ref, Vue.watch, callback => disposals.push(callback), state, cloudMode, cloudStatus, message => notices.push(message), request, () => '', options => createPreparedShares({ ...options, now: () => moment }), familyShareContext, dishShareCard);
    actions = factory(Vue.ref({ itemId: 'recipe', kind: 'dish' }), card => opened.push(card));
  });
  return { ...actions, state, cloudStatus, opened, notices, dispose() { disposals.forEach(callback => callback()); scope.stop(); } };
}

test('detail prewarms the card; cached sharing is synchronous and never waits for a cover image', async () => {
  let requests = 0;
  const app = controller(async () => { requests += 1; return result(); });
  try {
    await new Promise(resolve => setImmediate(resolve));
    const delivery = app.share();
    assert.equal(app.opened.length, 1);
    assert.match(app.opened[0].path, /token=/);
    assert.equal(app.opened[0].imageUrl, DEFAULT_DISH_COVER);
    await delivery;
    assert.equal(requests, 1);
    assert.equal(app.busy.value, false);
  } finally { app.dispose(); }
});

test('cold share tap waits safely once, unrelated refreshes do not cancel it, and no null card opens', async () => {
  const pending = deferred();
  const app = controller(() => pending.promise);
  try {
    const sharing = app.share();
    await app.share();
    assert.equal(app.busy.value, true);
    assert.equal(app.opened.length, 0);
    app.state.value = { ...app.state.value, orders: [{ id: 'new-order' }] };
    await Vue.nextTick();
    pending.resolve(result());
    await sharing;
    assert.equal(app.opened.length, 1);
    assert.equal(app.busy.value, false);
  } finally { app.dispose(); }
});

test('closing details or switching households while preparing cannot open a stale share panel', async () => {
  for (const cancel of [app => app.dispose(), app => { app.cloudStatus.value = { ...app.cloudStatus.value, familyId: 'other' }; }]) {
    const pending = deferred();
    const app = controller(() => pending.promise);
    const sharing = app.share();
    cancel(app);
    await Vue.nextTick();
    pending.resolve(result());
    await sharing;
    assert.equal(app.opened.length, 0);
    app.dispose();
  }
});

test('failed prewarm stays quiet and an explicit retry succeeds; local preview needs no cloud card', async () => {
  let requests = 0;
  const app = controller(async () => { if (++requests <= 2) throw new Error('网络不可用'); return result(); });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(app.notices, []);
    await app.share();
    assert.deepEqual(app.notices, ['网络不可用']);
    assert.equal(app.busy.value, false);
    await app.share();
    assert.equal(app.opened.length, 1);
  } finally { app.dispose(); }
  const local = controller(() => assert.fail('local preview must not call cloud'), false);
  await local.share();
  assert.deepEqual(local.opened, [null]);
  local.dispose();
});

test('sharing lives in the detail toolbar and ordering lives beside the title', () => {
  const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  for (const path of ['src/pages/shared/index.vue']) {
    const source = read(path);
    assert.equal((source.match(/class="friend-action-cell"/g) || []).length, 2);
    assert.match(source, /<FriendForwardButton :card=/);
  }
  for (const path of ['src/components/RecipeSheet.vue', 'src/components/SetSheet.vue']) {
    assert.match(read(path), /MenuDetailActions :selected="selected" :busy="props.busy"/);
    assert.match(read(path), /#action/);
    assert.match(read(path), /@share="share"/);
    assert.doesNotMatch(read(path), /\bDetailAction\b|label="编辑"|移出我家菜单/);
  }
  const footer = read('src/components/MenuDetailActions.vue');
  assert.equal((footer.match(/<button\b/g) || []).length, 1);
  assert.equal((footer.match(/class="recipe-detail-button menu-detail-/g) || []).length, 1);
  assert.match(read('src/styles.css'), /\.food-detail-primary \.menu-detail-order \{[^}]*min-height: 44px/);
  assert.match(footer, /selected \? '已选中' : '选择'/);
  assert.match(footer, /selected \? 'check' : 'plus-inverse'/);
  assert.doesNotMatch(footer, /吃这个套餐|吃这道菜/);
  assert.doesNotMatch(footer, /想吃|share/);
  const detail = read('src/components/FoodDetailSheet.vue');
  assert.match(detail, /<NativeShareButton v-if="shareCard"/);
  assert.match(detail, /v-else-if="canShare"/);
  assert.match(detail, /name="detail-share"/);
  const sheet = read('src/components/FriendShareSheet.vue');
  assert.doesNotMatch(sheet, /正在准备卡片|正在获取卡片|invokeCloud|loadImage/);
  assert.match(sheet, /分享给微信好友/);
  assert.match(read('src/styles.css'), /\.friend-action-cell \{ flex: 1 1 0; min-width: 0;/);
});
