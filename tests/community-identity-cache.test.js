import { workspaceDisplayName } from '../src/domain/workspace-identity.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Vue from 'vue';
import { setupSource, componentSource } from './helpers/sfc-setup.js';
import { createCommunityFeed, communityFeedRevision, invalidateCommunityFeed } from '../src/services/community-feed.js';
import { useCommunityFeedViewport } from '../src/composables/useCommunityFeedViewport.js';
import { useCommunityNavigation } from '../src/composables/useCommunityNavigation.js';
import { useRecipeAccordion } from '../src/composables/useRecipeAccordion.js';
import { FOOD_CATEGORIES, foodFeedQuery, orderFoodPosts, buildFoodWaterfall } from '../src/domain/food-feed.js';
import { filterPosts, commentThreads } from '../src/domain/presentation.js';
import { canDeleteCommunityPost, editableCommunityEntry, communityPublisherName } from '../src/domain/community-policy.js';
import { matchesImportedSource } from '../src/domain/kitchen.js';
import { NATIVE_UI_COLORS } from '../src/domain/ui-theme.js';

const post = (id = 'post-a', extra = {}) => ({
  id, familyId: 'family-a', publisherId: 'member-a', publisherType: 'user',
  author: '原家庭', title: '番茄炒蛋', kind: 'dish', image: 'saved-cover',
  recipes: [{ id: 'recipe-a', title: '番茄炒蛋', category: '荤菜', image: 'saved-recipe', ingredients: [], steps: [] }],
  familySnapshot: { id: 'family-a', name: '原家庭', cover: 'published-cover' },
  ...extra,
});
const tick = async () => { for (let index = 0; index < 8; index += 1) await Vue.nextTick(); };
function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

function community(context, { posts = [post()], cached, detail, cloudMode = true, props = { active: true } } = {}) {
  invalidateCommunityFeed();
  const scope = Vue.effectScope();
  const state = Vue.ref({
    family: { id: 'family-a', name: '原家庭', members: [{ id: 'member-a' }] },
    activeMemberId: 'member-a', recipes: [], mealSets: [], posts: [], comments: [],
  });
  const cloudStatus = Vue.ref({ userId: 'member-a', familyId: 'family-a' });
  const sheetOpen = Vue.ref(false);
  const calls = [];
  const bindings = {
    computed: Vue.computed, ref: Vue.ref, watch: Vue.watch, nextTick: Vue.nextTick,
    onUnmounted: Vue.onScopeDispose, defineEmits: () => () => {}, defineProps: () => Vue.reactive(props), defineExpose() {},
    NATIVE_UI_COLORS, state, workspaceDisplayName, activeMember: Vue.computed(() => state.value.family?.members?.find(member => member.id === state.value.activeMemberId)), workspaceName: Vue.computed(() => workspaceDisplayName(state.value.family)), cloudStatus, cloudMode, communityPosts: [], sheetOpen,
    FOOD_CATEGORIES, foodFeedQuery, orderFoodPosts, buildFoodWaterfall, filterPosts, commentThreads,
    createCommunityFeed, communityFeedRevision, useCommunityFeedViewport, useCommunityNavigation, useRecipeAccordion,
    canDeleteCommunityPost, editableCommunityEntry, communityPublisherName, matchesImportedSource,
    COMMUNITY_COMMENTS_ENABLED: false, tapFeedback() {}, dismissFocusedKeyboard() {}, notify() {},
    rememberMedia() {}, mergeCloudCommunity() {}, resolveImage: value => value, dishShareCard: value => value,
    peekCommunityPost: () => cached,
    readCommunityPost: async id => { calls.push({ action: 'read', id }); return detail ? detail.promise : { post: posts.find(entry => entry.id === id) }; },
    invokeCloud: async (action, request) => { calls.push({ action, request }); return { posts, cursor: 'following-page', feedVersion: 2 }; },
  };
  const view = scope.run(() => setupSource('CommunityView', bindings, ['feed', 'lanes', 'current', 'currentPublisher', 'presentFamilyPublisher', 'open', 'feedViewport', 'detailReady', 'friendCard', 'editableEntry', 'canDelete']));
  const names = Vue.computed(() => view.lanes.value.flatMap(lane => lane.map(entry => communityPublisherName(view.presentFamilyPublisher(entry.post)))));
  context.after(() => { scope.stop(); invalidateCommunityFeed(); });
  return { ...view, state, cloudStatus, calls, names, sheetOpen };
}

test('a family rename updates retained list and open detail immediately without refetching or changing history', async context => {
  const view = community(context);
  await tick();
  await view.open(view.feed.value.posts[0]);
  view.feedViewport.onScroll({ detail: { scrollTop: 640 } });
  view.sheetOpen.value = true;
  const rawFeed = view.feed.value;
  const rawPost = rawFeed.posts[0];
  const rawDetail = view.current.value;
  const rawLanes = view.lanes.value;
  const requests = view.calls.length;
  const before = structuredClone(Vue.toRaw(rawPost));
  assert.deepEqual(view.names.value, ['原家庭']);
  assert.equal(view.currentPublisher.value, '原家庭');

  view.state.value.family.name = '茱丽叶的厨房';
  invalidateCommunityFeed({ reset: false });
  assert.deepEqual(view.names.value, ['茱丽叶的厨房']);
  assert.equal(view.currentPublisher.value, '茱丽叶的厨房');
  await tick();
  assert.equal(view.calls.length, requests);
  assert.equal(view.feed.value, rawFeed);
  assert.equal(view.current.value, rawDetail);
  assert.equal(view.lanes.value, rawLanes);
  assert.equal(view.feed.value.cursor, 'following-page');
  assert.equal(view.feedViewport.scrollTop.value, 640);
  assert.deepEqual(rawPost, before);
  assert.equal(view.presentFamilyPublisher(rawPost).recipes, rawPost.recipes);
  assert.equal(view.presentFamilyPublisher(rawPost).familySnapshot, rawPost.familySnapshot);

  // A rejected optimistic edit must restore the same published identity immediately.
  view.state.value.family.name = '原家庭';
  assert.deepEqual(view.names.value, ['原家庭']);
  assert.equal(view.currentPublisher.value, '原家庭');
  assert.equal(view.calls.length, requests);
});

test('cached and late detail responses cannot restore an outdated current-family name', async context => {
  const detail = deferred();
  const cachedPost = post('post-a', { author: '缓存旧名' });
  const view = community(context, { detail, cached: { post: cachedPost, comments: [] } });
  await tick();
  const opening = view.open(view.feed.value.posts[0]);
  assert.equal(view.current.value.author, '缓存旧名');
  view.state.value.family.name = '新家庭名';
  assert.equal(view.currentPublisher.value, '新家庭名');
  detail.resolve({ post: post('post-a', { author: '迟到旧名' }) });
  await opening;
  assert.equal(view.current.value.author, '迟到旧名');
  assert.equal(view.currentPublisher.value, '新家庭名');
  assert.deepEqual(view.names.value, ['新家庭名']);
});

test('only exact current-family IDs are projected and official attribution remains intact', async context => {
  const entries = [
    post(),
    post('other', { familyId: 'family-b' }),
    post('no-family', { familyId: undefined }),
    post('official-type', { publisherType: 'official', author: '官方保留署名' }),
    post('official-id', { publisherId: 'official:shiyuan', author: '官方保留署名' }),
    post('official-origin', { publisherType: 'official', author: '官方保留署名', recipes: [{ id: 'origin', provenance: { attribution: '原作者' } }] }),
  ];
  const view = community(context, { posts: entries });
  await tick();
  view.state.value.family.name = '新家庭名';
  assert.equal(view.presentFamilyPublisher(entries[0]).author, '新家庭名');
  for (const entry of entries.slice(1)) assert.equal(view.presentFamilyPublisher(entry), entry, entry.id);
  assert.equal(communityPublisherName(view.presentFamilyPublisher(entries.at(-1))), '原作者');

  view.cloudStatus.value.familyId = 'family-b';
  assert.equal(view.presentFamilyPublisher(entries[0]), entries[0]);
  assert.equal(view.presentFamilyPublisher(entries[1]), entries[1]);
  view.cloudStatus.value.familyId = 'family-a';
  view.cloudStatus.value.userId = '';
  assert.equal(view.presentFamilyPublisher(entries[0]), entries[0]);
});

test('personal, deleted, empty and unbound family state retain the server-provided identity', async context => {
  const view = community(context);
  await tick();
  const entry = post();
  for (const family of [
    { id: 'family-a', name: '个人空间', kind: 'personal' },
    { id: 'family-a', name: '已删除', deletedAt: 123 },
    { id: 'family-a', name: '已删除', status: 'deleted' },
    { id: 'family-a', name: '   ' },
    { id: 'family-a' },
    { name: '缺少 ID' },
    undefined,
  ]) {
    view.state.value.family = family;
    assert.equal(view.presentFamilyPublisher(entry), entry);
  }
});

test('the local legacy view remains unchanged and both template bylines use the live presentation', context => {
  const view = community(context, { cloudMode: false });
  view.state.value.family.name = '本地名称';
  const entry = post();
  assert.equal(view.presentFamilyPublisher(entry), entry);
  const source = componentSource('CommunityView');
  assert.match(source, /<CommunityByline[^>]*:post="presentFamilyPublisher\(entry.post\)"/);
  assert.match(source, /<FoodDetailSheet[^>]*:publisher="currentPublisher"/);
});

test('discover detail-only entry reuses cached community content without share controls or starting the food feed', async context => {
  const detail = deferred();
  const cached = { post: post(), comments: [] };
  const view = community(context, { cached, detail, props: { active: false, detailOnly: true, initialPost: post('post-a', { title: '餐食旧标题' }) } });
  assert.equal(view.current.value.title, cached.post.title);
  assert.equal(view.detailReady.value, true);
  assert.equal(view.friendCard.value, null);
  assert.equal(view.calls.some(call => call.action === 'feed'), false);
  detail.resolve(cached);
  await tick();
  assert.equal(view.current.value.id, 'post-a');
});

test('a pending legacy public link shows its cover without requesting or sharing an empty ID', async context => {
  const props = Vue.reactive({active:false, detailOnly:true, initialPost:post('', {image:'visible-cover'})});
  const view = community(context, {props});
  assert.equal(view.current.value.image, 'visible-cover');
  assert.equal(view.detailReady.value, false);
  assert.equal(view.friendCard.value, null);
  assert.equal(view.calls.length, 0);
  props.initialPost = post('post-a');
  await tick();
  assert.equal(view.current.value.id, 'post-a');
  assert.equal(view.detailReady.value, true);
  assert.deepEqual(view.calls, [{action:'read', id:'post-a'}]);
});

 test('personal nickname updates cached list and open detail without changing workspace identity', async context => {
  const view = community(context);
  view.state.value.family = { id: 'family-a', kind: 'personal', name: '我的餐桌', ownerId: 'member-a', members: [{ id: 'member-a', name: '原昵称' }] };
  await tick();
  await view.open(view.feed.value.posts[0]);
  const calls = view.calls.length;
  assert.equal(view.currentPublisher.value, '原昵称');
  view.state.value.family.members[0].name = '新昵称';
  assert.equal(view.currentPublisher.value, '新昵称');
  assert.deepEqual(view.names.value, ['新昵称']);
  assert.equal(view.calls.length, calls);
  assert.equal(view.state.value.family.name, '我的餐桌');
});
