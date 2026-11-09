import { DEFAULT_FAMILY_COVER } from '../src/domain/family.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import { useCommunityFeedViewport } from '../src/composables/useCommunityFeedViewport.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const replaceImports = code => code.replace(/import (\{[^}]+\}|\w+) from '[^']+';/g, (_, binding) => `const ${binding} = ${binding.startsWith('{') ? 'modules' : '{}'};`);
async function settle() { await Vue.nextTick(); await Promise.resolve(); await Vue.nextTick(); }
function fixture(context) {
  const scope = Vue.effectScope(), calls = [], notices = [], stopped = [];
  const props = Vue.reactive({ active: true });
  const modules = { ...Vue, DEFAULT_FAMILY_COVER, currentIdentity: Vue.ref(null), cloudMode: true, cloudStatus: Vue.ref({ phase: 'ready', userId: 'alice', familyId: 'family-a' }), sheetOpen: Vue.ref(false), useNavigationAppearance() {}, provide() {}, useCommunityFeedViewport,
    onUnmounted: fn => stopped.push(fn), notify: message => notices.push(message),
    invokeCloud(action, args) { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); calls.push({ action, args, resolve, reject }); return promise; },
  };
  const factory = new Function('modules', `${replaceImports(read('../src/composables/useMealPosts.js')).replace('export function', 'function')}\nreturn useMealPosts;`)(modules);
  const feed = scope.run(() => factory('public', Vue.computed(() => props.active)));
  modules.inject = () => feed;
  const script = compileScript(parse(read('../src/components/MealSquare.vue')).descriptor, { id: 'square-refresh' }).content;
  const component = new Function('modules', replaceImports(script).replace('export default', 'return'))(modules);
  const view = scope.run(() => component.setup(props, { expose() {}, emit() {} }));
  context.after(() => { stopped.forEach(fn => fn()); scope.stop(); });
  return { feed, view, calls, modules, props, notices };
}

test('everyone pull refresh replaces page one, retains visible cards and ignores duplicate pulls', async context => {
  const f = fixture(context);
  f.calls[0].resolve({ posts: [{ id: 'before', visibility: 'public' }], cursor: 'next-old' }); await settle();
  const refresh = f.view.feedViewport.onRefresh();
  assert.equal(f.view.refreshing.value, true);
  assert.deepEqual(f.feed.posts.value, [{ id: 'before', visibility: 'public' }]);
  await settle();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].args, { mealLikesVersion: 1, spaceId: 'family-a' });
  await f.view.feedViewport.onRefresh();
  assert.equal(f.calls.length, 2);
  f.calls[1].resolve({ posts: [{ id: 'after', visibility: 'public' }], cursor: 'next-new' }); await refresh;
  assert.equal(f.view.refreshing.value, false);
  assert.deepEqual(f.feed.posts.value, [{ id: 'after', visibility: 'public' }]);
  assert.equal(f.feed.cursor.value, 'next-new');
});

test('everyone failed pull keeps content and releases the spinner; open composer blocks pulls', async context => {
  const f = fixture(context);
  f.calls[0].resolve({ posts: [{ id: 'before', visibility: 'public' }], cursor: 'next' }); await settle();
  const refresh = f.view.feedViewport.onRefresh(); await settle();
  f.calls[1].reject(new Error('网络暂不可用')); await refresh;
  assert.deepEqual(f.feed.posts.value, [{ id: 'before', visibility: 'public' }]);
  assert.equal(f.feed.cursor.value, 'next');
  assert.equal(f.view.refreshing.value, false);
  assert.deepEqual(f.notices, ['网络暂不可用']);
  f.modules.sheetOpen.value = true;
  await f.view.feedViewport.onRefresh();
  assert.equal(f.calls.length, 2);
  assert.equal(f.view.refreshing.value, false);
});

test('retrying a failed pull requests page one and replaces the cards instead of following the old cursor', async context => {
  const f = fixture(context);
  f.calls[0].resolve({ posts: [{ id: 'before', visibility: 'public' }], cursor: { id: 'old-next', createdAt: 12 } }); await settle();
  const refresh = f.view.feedViewport.onRefresh(); await settle();
  f.calls[1].reject(new Error('刷新失败')); await refresh;
  const retry = f.view.retry();
  assert.deepEqual(f.calls[2].args, { mealLikesVersion: 1, spaceId: 'family-a' });
  assert.deepEqual(f.feed.posts.value, [{ id: 'before', visibility: 'public' }]);
  await f.view.retry();
  assert.equal(f.calls.length, 3, 'duplicate retry taps must not start another request');
  f.calls[2].resolve({ posts: [{ id: 'after', visibility: 'public' }], cursor: { id: 'new-next', createdAt: 20 } }); await retry;
  assert.deepEqual(f.feed.posts.value, [{ id: 'after', visibility: 'public' }]);
  assert.equal(f.feed.error.value, '');
  assert.deepEqual(f.feed.cursor.value, { id: 'new-next', createdAt: 20 });
});

test('retrying failed pagination reuses its cursor and appends without replacing earlier cards', async context => {
  const f = fixture(context);
  const cursor = { id: 'next', createdAt: 12 };
  f.calls[0].resolve({ posts: [{ id: 'first', visibility: 'public' }], cursor }); await settle();
  const more = f.view.loadMore();
  f.calls[1].reject(new Error('下一页暂未加载')); await more;
  const retry = f.view.retry();
  assert.deepEqual(f.calls[2].args, { mealLikesVersion: 1, spaceId: 'family-a', cursor });
  assert.deepEqual(f.calls[2].args, f.calls[1].args);
  f.calls[2].resolve({ posts: [{ id: 'second', visibility: 'public' }], cursor: null }); await retry;
  assert.deepEqual(f.feed.posts.value, [{ id: 'first', visibility: 'public' }, { id: 'second', visibility: 'public' }]);
  assert.equal(f.feed.error.value, '');
  assert.equal(f.feed.cursor.value, null);
});

test('a stale failed page cannot overwrite the new workspace retry request', async context => {
  const f = fixture(context);
  f.calls[0].resolve({ posts: [{ id: 'old', visibility: 'public' }], cursor: { id: 'old-next' } }); await settle();
  const oldMore = f.view.loadMore();
  f.modules.cloudStatus.value = { ...f.modules.cloudStatus.value, familyId: 'family-b' }; await settle();
  f.calls[2].reject(new Error('新空间暂未加载')); await settle();
  f.calls[1].reject(new Error('旧空间下一页失败')); await oldMore;
  assert.equal(f.feed.error.value, '新空间暂未加载');
  const retry = f.view.retry();
  assert.deepEqual(f.calls[3].args, { mealLikesVersion: 1, spaceId: 'family-b' });
  f.calls[3].resolve({ posts: [{ id: 'new', visibility: 'public' }], cursor: null }); await retry;
  assert.deepEqual(f.feed.posts.value, [{ id: 'new', visibility: 'public' }]);
});

test('a previous workspace refresh cannot populate the new workspace or stop its next refresh', async context => {
  const f = fixture(context);
  f.calls[0].resolve({ posts: [{ id: 'old', visibility: 'public' }], cursor: null }); await settle();
  const oldRefresh = f.view.feedViewport.onRefresh(); await settle();
  f.modules.cloudStatus.value = { ...f.modules.cloudStatus.value, familyId: 'family-b' }; await settle();
  assert.equal(f.view.refreshing.value, false);
  assert.deepEqual(f.feed.posts.value, []);
  f.calls[2].resolve({ posts: [{ id: 'new', visibility: 'public' }], cursor: null }); await settle();
  const newRefresh = f.view.feedViewport.onRefresh(); await settle();
  f.calls[1].resolve({ posts: [{ id: 'stale', visibility: 'public' }], cursor: null }); await oldRefresh;
  assert.equal(f.view.refreshing.value, true);
  assert.deepEqual(f.feed.posts.value, [{ id: 'new', visibility: 'public' }]);
  f.calls[3].resolve({ posts: [{ id: 'newer', visibility: 'public' }], cursor: null }); await newRefresh;
  assert.equal(f.view.refreshing.value, false);
  assert.deepEqual(f.feed.posts.value, [{ id: 'newer', visibility: 'public' }]);
});

test('a workspace change while everyone is hidden resets the feed when it returns', async context => {
  const f = fixture(context);
  f.calls[0].resolve({ posts: [{ id: 'before', visibility: 'public' }], cursor: null }); await settle();
  f.view.feedViewport.onScroll({ detail: { scrollTop: 700 } });
  f.props.active = false;
  assert.equal(f.view.feedScrollTop.value, 700);
  f.modules.cloudStatus.value = { ...f.modules.cloudStatus.value, familyId: 'family-b' }; await settle();
  assert.equal(f.view.feedScrollTop.value, 700, 'a hidden scroll-view defers its reset until it can scroll');
  f.props.active = true; await settle();
  assert.equal(f.view.feedScrollTop.value, 0);
  assert.deepEqual(f.calls[1].args, { mealLikesVersion: 1, spaceId: 'family-b' });
  f.calls[1].resolve({ posts: [{ id: 'after', visibility: 'public' }], cursor: null }); await settle();

  f.view.feedViewport.onScroll({ detail: { scrollTop: 420 } });
  f.modules.sheetOpen.value = true; await settle();
  f.modules.sheetOpen.value = false; await settle();
  assert.equal(f.view.feedScrollTop.value, 420, 'closing a composer in the same workspace preserves the reading position');
  f.props.active = false; await settle();
  f.props.active = true; await settle();
  assert.equal(f.view.feedScrollTop.value, 420, 'returning from another tab in the same workspace also preserves position');
});

test('a composer opened during the workspace reset defers scrolling until the sheet closes', async context => {
  const f = fixture(context);
  f.calls[0].resolve({ posts: [{ id: 'before', visibility: 'public' }], cursor: null }); await settle();
  f.view.feedViewport.onScroll({ detail: { scrollTop: 500 } });
  f.modules.cloudStatus.value = { ...f.modules.cloudStatus.value, familyId: 'family-b' };
  f.modules.sheetOpen.value = true; await settle();
  assert.equal(f.view.feedScrollTop.value, 500);
  f.modules.sheetOpen.value = false; await settle();
  assert.equal(f.view.feedScrollTop.value, 0);
  f.calls[1].resolve({ posts: [{ id: 'after', visibility: 'public' }], cursor: null }); await settle();
});


test('current identity changes immediately project linked cards and rollback without changing unrelated snapshots', async context => {
  const f = fixture(context);
  const linked = { id: 'linked', visibility: 'public', author: { mode: 'family', currentSpace: true, name: '旧名', avatar: 'old' } };
  const legacy = { id: 'legacy', visibility: 'public', author: { mode: 'family', name: '旧名', avatar: 'old' } };
  const other = { id: 'other', visibility: 'public', author: { mode: 'family', currentSpace: false, name: '别人', avatar: 'other' } };
  f.calls[0].resolve({ posts: [linked, legacy, other], cursor: null }); await settle();
  f.modules.currentIdentity.value = { family: { id: 'family-a', name: '新名', cover: 'new' } };
  assert.equal(f.feed.posts.value[0].author.name, '新名');
  assert.equal(f.feed.posts.value[0].author.avatar, 'new');
  assert.deepEqual(f.feed.posts.value[1], legacy);
  assert.deepEqual(f.feed.posts.value[2], other);
  f.modules.currentIdentity.value.family = { id: 'family-a', name: '旧名', cover: 'old' };
  assert.equal(f.feed.posts.value[0].author.name, '旧名');
  assert.equal(f.calls.length, 1);
  assert.equal(linked.author.name, '旧名');
});

test('discover scroll pagination appends once and stops at the last page', async context => {
  const f = fixture(context);
  f.calls[0].resolve({ posts: [{ id: 'first', visibility: 'public' }], cursor: 'next' }); await settle();
  const more = f.view.loadMore();
  await f.view.loadMore();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.feed.posts.value.map(post => post.id), ['first']);
  assert.equal(f.feed.loading.value, true);
  f.calls[1].resolve({ posts: [{ id: 'second', visibility: 'public' }], cursor: null }); await more;
  await f.view.loadMore();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.feed.posts.value.map(post => post.id), ['first', 'second']);
});

test('slow discovery refresh keeps feedback until completion and deduplicates pulls', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(context);
  f.calls[0].resolve({ posts: [{ id: 'before', visibility: 'public' }], cursor: 'next' }); await settle();
  const refresh = f.view.feedViewport.onRefresh(); await settle();
  context.mock.timers.tick(900);
  assert.equal(f.view.refreshing.value, true);
  assert.equal(f.feed.loading.value, true);
  assert.equal(f.view.refresherEnabled.value, true, 'native refresher must stay enabled while triggered=false restores the pull offset');
  assert.equal(f.feed.posts.value[0].id, 'before');
  await f.view.feedViewport.onRefresh();
  assert.equal(f.calls.length, 2);
  f.calls[1].resolve({ posts: [{ id: 'fresh', visibility: 'public' }], cursor: null }); await refresh;
  assert.equal(f.feed.loading.value, false);
  assert.equal(f.feed.posts.value[0].id, 'fresh');
});

test('slow discovery refresh reports failure and restores the pull area', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(context);
  f.calls[0].resolve({ posts: [{ id: 'before', visibility: 'public' }], cursor: null }); await settle();
  const refresh = f.view.feedViewport.onRefresh(); await settle();
  context.mock.timers.tick(900);
  f.calls[1].reject(new Error('网络暂不可用')); await refresh;
  assert.deepEqual(f.notices, ['网络暂不可用']);
  assert.equal(f.feed.posts.value[0].id, 'before');
  assert.equal(f.feed.loading.value, false);
});


test('pull supersedes background loading without waiting and late background data cannot replace fresh data', async context => {
  const f = fixture(context);
  const pull = f.view.feedViewport.onRefresh();
  await settle();
  assert.equal(f.view.refreshing.value, true);
  assert.equal(f.calls.length, 2, 'fresh request starts before background request finishes');
  await f.view.feedViewport.onRefresh();
  assert.equal(f.calls.length, 2, 'duplicate pull does not start another request');
  f.calls[1].resolve({ posts: [{ id: 'fresh', visibility: 'public' }], cursor: null }); await pull;
  assert.equal(f.view.refreshing.value, false);
  f.calls[0].resolve({ posts: [{ id: 'background', visibility: 'public' }], cursor: 'stale' }); await settle();
  assert.equal(f.feed.posts.value[0].id, 'fresh');
  assert.equal(f.feed.cursor.value, null);
  assert.equal(f.feed.loading.value, false);
});
