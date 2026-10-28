import { matchesImportedSource } from '../src/domain/kitchen.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import { createCommunityFeed, communityFeedRevision, invalidateCommunityFeed } from '../src/services/community-feed.js';
import { useCommunityFeedViewport } from '../src/composables/useCommunityFeedViewport.js';
import { useCommunityNavigation } from '../src/composables/useCommunityNavigation.js';
import { useRecipeAccordion } from '../src/composables/useRecipeAccordion.js';
import { FOOD_CATEGORIES, foodFeedQuery, orderFoodPosts, buildFoodWaterfall } from '../src/domain/food-feed.js';
import { filterPosts, commentThreads } from '../src/domain/presentation.js';
import { canDeleteCommunityPost, editableCommunityEntry, communityPublisherName } from '../src/domain/community-policy.js';
import { NATIVE_UI_COLORS } from '../src/domain/ui-theme.js';
import { presentMutation } from '../src/services/mutation-feedback.js';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const query = { type: '全部', category: '全部', search: '', sort: 'recommended', seed: 'same-round' };
const post = id => ({ id, kind: 'dish', title: id, recipes: [{ id: `${id}-recipe`, category: '荤菜' }] });
const tick = async () => { for (let index = 0; index < 8; index += 1) await Vue.nextTick(); };
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

test('returning after mutations or cache expiry retains all loaded pages and the same continuation', async context => {
  invalidateCommunityFeed();
  let clock = 0;
  const calls = [];
  const feed = createCommunityFeed({ now: () => clock, request: async request => {
    calls.push(request);
    const start = Number(request.cursor || 0);
    return { posts: Array.from({ length: 24 }, (_, index) => post(String(start + index))), cursor: String(start + 24) };
  } });
  context.after(() => { feed.dispose(); invalidateCommunityFeed(); });
  await feed.select(query, 'member:family', { retain: true });
  await feed.refresh(true);
  await feed.refresh(true);
  const visible = feed.state.value;
  assert.equal(visible.posts.length, 72);
  const revision = communityFeedRevision.value;
  clock = 600000;
  for (const operation of ['addCollection', 'publishToCommunity', 'deleteCommunityPost']) {
    invalidateCommunityFeed({ reset: false });
    await feed.select(query, 'member:family', { retain: true });
    assert.equal(communityFeedRevision.value, revision, operation);
    assert.equal(feed.state.value, visible, operation);
    assert.equal(calls.length, 3, operation);
  }
  await feed.refresh(true);
  assert.equal(calls.at(-1).cursor, '72');
  assert.equal(feed.state.value.posts.length, 96);
  assert.deepEqual(feed.state.value.posts.slice(0, 72), visible.posts);
  await feed.refresh();
  assert.equal(calls.at(-1).cursor, '');
  assert.equal(calls.at(-1).seed, query.seed);
  assert.equal(feed.state.value.posts.length, 24);
});

test('soft invalidation lets in-flight first and next pages finish without restoring invalidated cache', async context => {
  for (const more of [false, true]) {
    invalidateCommunityFeed();
    const response = deferred();
    const feed = createCommunityFeed({ request: async request => more && !request.cursor ? { posts: [post('first')], cursor: 'next' } : response.promise });
    context.after(() => feed.dispose());
    let loading = feed.select(query, 'member:family', { retain: true });
    if (more) { await loading; loading = feed.refresh(true); }
    invalidateCommunityFeed({ reset: false });
    await feed.select(query, 'member:family', { retain: true });
    response.resolve({ posts: [post('arriving')], cursor: 'following' });
    await loading;
    assert.equal(feed.state.value.loading, false);
    assert.deepEqual(feed.state.value.posts.map(entry => entry.id), more ? ['first', 'arriving'] : ['arriving']);
    let reads = 0;
    const next = createCommunityFeed({ request: async () => { reads += 1; return { posts: [post('fresh')] }; } });
    context.after(() => next.dispose());
    await next.select(query, 'member:family');
    assert.equal(reads, 1);
    assert.equal(next.state.value.posts[0].id, 'fresh');
  }
  invalidateCommunityFeed();
});

test('retained selection does not bypass changed filters, identity or a security reset', async context => {
  invalidateCommunityFeed();
  const response = deferred();
  let calls = 0;
  const feed = createCommunityFeed({ request: async request => {
    calls += 1;
    if (calls === 2) return response.promise;
    return { posts: [post(request.search || 'fresh')], cursor: 'next' };
  } });
  context.after(() => { feed.dispose(); invalidateCommunityFeed(); });
  await feed.select(query, 'member:family', { retain: true });
  const old = feed.refresh(true);
  invalidateCommunityFeed();
  await feed.select(query, 'member:family', { retain: true });
  response.resolve({ posts: [post('old-identity')] });
  await old;
  assert.deepEqual(feed.state.value.posts.map(entry => entry.id), ['fresh']);
  await feed.select({ ...query, search: '汤' }, 'member:family', { retain: true });
  assert.equal(feed.state.value.posts[0].id, '汤');
  await feed.select(query, 'member:another-family', { retain: true });
  assert.equal(calls, 5);
});

test('repeated activation does not cancel a debounced search or duplicate its request', async context => {
  const calls = [];
  const response = deferred();
  const feed = createCommunityFeed({ cache: new Map(), request: request => { calls.push(request); return response.promise; } });
  context.after(() => feed.dispose());
  feed.select({ ...query, search: '汤' }, 'member:family', { delay: 5, retain: true });
  feed.select({ ...query, search: '汤' }, 'member:family', { retain: true });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(calls.length, 1);
  feed.select({ ...query, search: '汤' }, 'member:family', { retain: true });
  response.resolve({ posts: [post('soup')] });
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(feed.state.value.loading, false);
});

test('identity invalidation cancels a delayed request even while the feed is hidden', async context => {
  let calls = 0;
  const feed = createCommunityFeed({ cache: new Map(), request: async () => { calls += 1; return { posts: [] }; } });
  context.after(() => feed.dispose());
  feed.select({ ...query, search: '汤' }, 'old-member:family', { delay: 5, retain: true });
  invalidateCommunityFeed();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(calls, 0);
  await feed.select(query, 'new-member:family', { retain: true });
  assert.equal(calls, 1);
});

function community(context) {
  invalidateCommunityFeed();
  const scope = Vue.effectScope();
  const props = Vue.reactive({ active: true });
  const sheetOpen = Vue.ref(false);
  const state = Vue.ref({ recipes: [], mealSets: [], posts: [], comments: [], activeMemberId: 'member', family: { members: [] } });
  const cloudStatus = Vue.ref({ userId: 'member', familyId: 'family' });
  const calls = [];
  const imported = deferred();
  const modals = [];
  const bindings = {
    computed: Vue.computed, ref: Vue.ref, watch: Vue.watch, nextTick: Vue.nextTick,
    NATIVE_UI_COLORS, state, cloudStatus, cloudMode: true, communityPosts: [], sheetOpen,
    FOOD_CATEGORIES, foodFeedQuery, orderFoodPosts, buildFoodWaterfall, filterPosts, commentThreads,
    createCommunityFeed, communityFeedRevision, useCommunityFeedViewport, useCommunityNavigation, useRecipeAccordion,
    canDeleteCommunityPost, editableCommunityEntry, communityPublisherName, matchesImportedSource, presentMutation,
    COMMUNITY_COMMENTS_ENABLED: false, defineProps: () => props, defineEmits: () => () => {}, defineExpose() {},
    onUnmounted: Vue.onScopeDispose, tapFeedback() {}, notify() {}, dismissFocusedKeyboard() {},
    rememberMedia() {}, peekCommunityPost() {}, mergeCloudCommunity() {}, resolveImage: value => value, dishShareCard: value => value,
    invokeCloud: async (action, request) => { calls.push({ action, request }); return { posts: [post(request.cursor ? 'second' : 'first')], cursor: request.cursor ? 'third-page' : 'next-page', feedVersion: 2 }; },
    readCommunityPost: async id => ({ post: post(id) }),
    addCollection: async entry => { await imported.promise; state.value.recipes.push({ sourceId: entry.recipes[0].id }); invalidateCommunityFeed({ reset: false }); },
    runAction: action => action(), uni: { showModal: options => modals.push(options) },
  };
  const script = parse(source('src/components/CommunityView.vue')).descriptor.scriptSetup.content.replace(/^import .*;\s*$/gm, '');
  const api = scope.run(() => new Function(...Object.keys(bindings), `${script}\nreturn { feed, current, open, add, imported, loadMore, feedViewport, feedLocked, search, mode, category };`)(...Object.values(bindings)));
  context.after(() => { scope.stop(); invalidateCommunityFeed(); });
  return { ...api, props, sheetOpen, state, cloudStatus, calls, finishImport: imported.resolve, modals };
}

test('adding from a detail updates its joined state without refreshing cards, cursor or scroll position', async context => {
  const view = community(context);
  await tick();
  await view.loadMore();
  const visible = view.feed.value;
  view.feedViewport.onScroll({ detail: { scrollTop: 680 } });
  await view.open(visible.posts[1]);
  view.sheetOpen.value = true;
  view.add(view.current.value);
  view.modals.at(-1).success({ confirm: true });
  view.finishImport();
  await tick();
  assert.equal(view.imported(view.current.value), true);
  view.current.value = null;
  view.sheetOpen.value = false;
  await tick();
  assert.equal(view.feed.value, visible);
  assert.equal(view.feed.value.cursor, 'third-page');
  assert.equal(view.feedViewport.scrollTop.value, 680);
  assert.equal(view.calls.length, 2);
});

test('returning from another tab retains query, recommendation seed and scroll; hidden feeds cannot refresh or paginate', async context => {
  const view = community(context);
  await tick();
  view.search.value = '牛肉';
  await new Promise(resolve => setTimeout(resolve, 240));
  await tick();
  view.feedViewport.onScroll({ detail: { scrollTop: 420 } });
  const visible = view.feed.value;
  const calls = view.calls.length;
  view.props.active = false;
  await tick();
  view.feedViewport.onScroll({ detail: { scrollTop: 0 } });
  await view.loadMore();
  await view.feedViewport.onRefresh();
  invalidateCommunityFeed({ reset: false });
  view.props.active = true;
  await tick();
  assert.equal(view.search.value, '牛肉');
  assert.equal(view.feed.value, visible);
  assert.equal(view.calls.length, calls);
  assert.equal(view.feedViewport.scrollTop.value, 420);
});

test('page retains one lazily mounted feed per identity and mutations never call a full feed reload', () => {
  const page = source('src/pages/index/index.vue');
  assert.match(page, /v-if="communityVisited" v-show="tab === 'community'" class="community-tab"/);
  assert.match(page, /<CommunityView[^>]*:key="`\$\{cloudStatus.userId\}:\$\{cloudStatus.familyId\}`"[^>]*:active="tab === 'community'"/);
  assert.equal((page.match(/<CommunityView\b/g) || []).length, 1);
  const component = source('src/components/CommunityView.vue');
  assert.doesNotMatch(component.slice(component.indexOf('async function removePost()')), /await loadFeed\(/);
  assert.match(component, /hiddenPosts.value = \[\.\.\.new Set/);
  assert.match(source('src/services/cloud.js'), /\['publishToCommunity', 'deleteCommunityPost', 'addCollection'\]\.includes\(operation\?\.name\)\) invalidateCommunityFeed\(\{ reset: false \}\)/);
  assert.match(source('src/services/cloud.js'), /function clearPrivateCache\(\)[^\n]*invalidateCommunityFeed\(\)/);
});
