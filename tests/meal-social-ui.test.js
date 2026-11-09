import { DEFAULT_FAMILY_COVER } from '../src/domain/family.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import { MEAL_ICONS, mealOrigin, MEAL_SLOTS, MEAL_MOODS, mealMoodDisplayLabel, mealTimeline } from '../src/domain/meal-social.js';
import { NATIVE_UI_COLORS } from '../src/domain/ui-theme.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { await Vue.nextTick(); await Promise.resolve(); await Vue.nextTick(); }
function harness(context, component, overrides = {}, props = {}) {
  const stopped = [], calls = [], events = [], provided = new Map();
  const scope = Vue.effectScope();
  const modules = {
    useReceivedMealLikes: () => ({ count: Vue.ref(0), error: Vue.ref(''), refresh: async () => {} }),
    ...Vue, DEFAULT_FAMILY_COVER, useNavigationAppearance() {}, inject: () => null, provide: (key, value) => provided.set(key, value), cloudMode: true, cloudStatus: Vue.ref({ phase: 'ready', familyId: 'family-a', userId: 'alice' }),
    onUnmounted: callback => stopped.push(callback), MEAL_ICONS, mealOrigin, MEAL_SLOTS, MEAL_MOODS, mealMoodDisplayLabel, mealTimeline, NATIVE_UI_COLORS, localDate: () => '2026-11-05',
    invokeCloud: (action, args) => { const task = deferred(); calls.push({ action, args: JSON.parse(JSON.stringify(args)), ...task }); return task.promise; },
    ...overrides,
  };
  const script = component ? compileScript(parse(read(`../src/components/${component}.vue`)).descriptor, { id: 'meal-social-ui' }).content : read('../src/composables/useMealPosts.js');
  const code = script.replace(/import (\{[^}]+\}|\w+) from '[^']+';/g, (_, binding) => `const ${binding} = ${binding.startsWith('{') ? 'modules' : '{}'};`);
  const enabled = Vue.ref(true);
  const factory = new Function('modules', component ? code.replace('export default', 'return') : `${code.replace('export function', 'function')}\nreturn useMealPosts;`)(modules);
  const api = scope.run(() => component ? factory.setup(props, { expose() {}, emit: (...args) => events.push(args) }) : factory(overrides.kind || 'mine', enabled));
  const unmount = () => { stopped.splice(0).forEach(fn => fn()); scope.stop(); };
  context.after(unmount);
  return { api, modules, calls, events, enabled, provided, unmount };
}

test('meal refresh after publish supersedes an older in-flight page', async context => {
  const f = harness(context);
  assert.equal(f.calls.length, 1);
  const refreshed = f.api.load(false, true);
  assert.equal(f.calls.length, 2);
  f.calls[1].resolve({ posts: [{ id: 'fresh' }], cursor: null });
  await refreshed;
  f.calls[0].resolve({ posts: [{ id: 'old' }], cursor: null });
  await settle();
  assert.deepEqual(f.api.posts.value.map(p => p.id), ['fresh']);
  assert.equal(f.api.loading.value, false);
});

test('accepted record survives a stale initial response and prefetch is reused on re-entry', async context => {
  const f = harness(context);
  const post = { id: 'new', sourceOrderId: 'dinner', images: ['photo'], moods: [MEAL_MOODS[0]] };
  f.api.acceptPost(post);
  const refresh = f.api.load(false, true);
  f.calls[0].resolve({ posts: [], cursor: null }); await settle();
  assert.deepEqual(f.api.posts.value, [post]);
  f.calls[1].resolve({ posts: [post], cursor: null }); await refresh;
  f.enabled.value = false; await settle(); f.enabled.value = true; await settle();
  assert.equal(f.calls.length, 2, 'opening the diary again reuses the page-owned data');
  assert.equal(f.api.loaded.value, true);
});

test('diary photos and labels arrive together instead of rendering a temporary order card', async context => {
  const posts = Vue.ref([]), loaded = Vue.ref(false);
  const feed = { posts, loaded, cursor: Vue.ref(null), loading: Vue.ref(true), error: Vue.ref(''), busy: Vue.ref({}), load() {}, mutate() {} };
  const f = harness(context, 'MealTimeline', { inject: key => key === 'mealDiaryFeed' ? feed : null, useMealPosts: () => { throw new Error('duplicate diary request'); } }, {
    active: true, today: '2026-11-05', orders: [{ id: 'dinner', date: '2026-11-04', meal: '晚餐', status: 'completed', items: [{ recipe: { id: 'dish' } }] }],
  });
  assert.deepEqual(f.api.entries.value, []);
  posts.value = [{ id: 'record', sourceOrderId: 'dinner', date: '2026-11-04', meal: '晚餐', images: ['photo'], moods: [MEAL_MOODS[0]] }]; loaded.value = true;
  assert.equal(f.api.entries.value.length, 1);
  assert.equal(f.api.entries.value[0].post.moods.length, 1);
  assert.equal(f.api.entries.value[0].order, undefined);
});

test('unavailable meal API leaves a readable retry state and retry can succeed', async context => {
  const f = harness(context);
  f.calls[0].reject(new Error('不支持的请求')); await settle();
  assert.equal(f.api.error.value, '餐食分享暂不可用，请稍后重试');
  assert.equal(f.api.loading.value, false);
  assert.equal(f.api.loaded.value, false);
  const retry = f.api.load();
  f.calls[1].resolve({ posts: [{ id: 'back' }], cursor: null }); await retry;
  assert.equal(f.api.error.value, '');
  assert.equal(f.api.loaded.value, true);
  assert.deepEqual(f.api.posts.value.map(post => post.id), ['back']);
});

test('everyone includes our public meals and reuses prefetched posts on re-entry', async context => {
  const f = harness(context, undefined, { kind: 'public' });
  assert.equal(f.calls[0].action, 'mealFeed');
  f.calls[0].resolve({ posts: [{ id: 'mine', visibility: 'public', isOwner: true }, { id: 'other', visibility: 'public', isOwner: false }], cursor: { id: 'next' } }); await settle();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.api.posts.value.map(post => post.id), ['mine', 'other']);
  f.enabled.value = false; await settle(); f.enabled.value = true; await settle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.api.loaded.value, true);
});

test('public pagination preserves existing cards and cursor after a failed request', async context => {
  const f = harness(context, undefined, { kind: 'public' });
  f.calls[0].resolve({ posts: [{ id: 'mine', visibility: 'public', isOwner: true }], cursor: { id: 'next' } }); await settle();
  const more = f.api.load(true);
  f.calls[1].reject(new Error('网络断开')); await more;
  assert.deepEqual(f.api.cursor.value, { id: 'next' });
  assert.deepEqual(f.api.posts.value.map(post => post.id), ['mine']);
  const retry = f.api.load(true);
  assert.deepEqual(f.calls[2].args, f.calls[1].args);
  f.calls[2].resolve({ posts: [{ id: 'other', visibility: 'public', isOwner: false }], cursor: null }); await retry;
  assert.deepEqual(f.api.posts.value.map(post => post.id), ['mine', 'other']);
});

test('switching identity cancels a public page with previous viewer reaction state', async context => {
  const f = harness(context, undefined, { kind: 'public' });
  f.calls[0].resolve({ posts: [{ id: 'mine', visibility: 'public', isOwner: true }], cursor: { id: 'next' } }); await settle();
  const more = f.api.load(true);
  f.modules.cloudStatus.value.userId = 'bob';
  f.calls[2].resolve({ posts: [{ id: 'alice', visibility: 'public', isOwner: false }], cursor: null }); await settle();
  f.calls[1].resolve({ posts: [{ id: 'old-context', visibility: 'public', isOwner: true }], cursor: { id: 'old-more' } }); await more;
  assert.deepEqual(f.api.posts.value.map(post => post.id), ['alice']);
  assert.equal(f.api.cursor.value, null);
});

test('optimistic likes and tags render before the response, survive reads, and rollback failure', async context => {
  const f = harness(context);
  const original = { id: 'p', liked: false, likeCount: 2, reactions: [{ id: 't', selected: false, count: 4 }] };
  f.calls[0].resolve({ posts: [original], cursor: null }); await settle();
  const like = f.api.mutate('setMealLike', original, { selected: true });
  assert.equal(f.api.posts.value[0].liked, true);
  assert.equal(f.api.posts.value[0].likeCount, 3);
  const refresh = f.api.load(false, true);
  f.calls[2].resolve({ posts: [original], cursor: null }); await refresh;
  assert.equal(f.api.posts.value[0].liked, true);
  f.calls[1].reject(new Error('断开')); await like;
  assert.deepEqual(f.api.posts.value[0], original);
  const reaction = f.api.mutate('setMealReaction', original, { tagId: 't', selected: true });
  assert.deepEqual(f.api.posts.value[0].reactions, [{ id: 't', selected: true, count: 5 }]);
  f.calls[3].resolve({ post: { ...original, reactions: [{ id: 't', selected: true, count: 6 }] } }); await reaction;
  assert.equal(f.api.posts.value[0].reactions[0].count, 6);
});

test('privacy and deletion changes remove the card from the page-owned public cache', async context => {
  const f = harness(context, undefined, { kind: 'public' });
  f.calls[0].resolve({ posts: [{ id: 'a', visibility: 'public' }, { id: 'b', visibility: 'public' }], cursor: null }); await settle();
  f.api.acceptPost({ id: 'a', visibility: 'private' });
  assert.deepEqual(f.api.posts.value.map(p => p.id), ['b']);
  f.api.removePost('b');
  assert.deepEqual(f.api.posts.value, []);
});

test('public reads and pagination require explicit public visibility even for our own records', async context => {
  const f = harness(context, undefined, { kind: 'public' });
  f.calls[0].resolve({ posts: [
    { id: 'mine', visibility: 'public', isOwner: true },
    { id: 'other', visibility: 'public', isOwner: false },
    { id: 'private', visibility: 'private', isOwner: true },
    { id: 'unknown', isOwner: true },
    { id: 'deleted', visibility: 'public', status: 'deleted' },
  ], cursor: { id: 'next' } }); await settle();
  assert.deepEqual(f.api.posts.value.map(post => post.id), ['mine', 'other']);
  const more = f.api.load(true);
  f.calls[1].resolve({ posts: [
    { id: 'mine', visibility: 'private', isOwner: true },
    { id: 'other-private', visibility: 'private' },
    { id: 'other-unknown' },
    { id: 'new-public', visibility: 'public' },
  ], cursor: null }); await more;
  assert.deepEqual(f.api.posts.value.map(post => post.id), ['other', 'new-public'], 'a private pagination row also removes an older cached public copy');
  f.api.acceptPost({ id: 'other', isOwner: true });
  assert.deepEqual(f.api.posts.value.map(post => post.id), ['new-public']);
});

test('an optimistic public reaction cannot mask a newly private read or emit a stale public result', async context => {
  const f = harness(context, undefined, { kind: 'public' });
  const post = { id: 'post', visibility: 'public', isOwner: true, liked: false, likeCount: 0 };
  f.calls[0].resolve({ posts: [post], cursor: null }); await settle();
  const like = f.api.mutate('setMealLike', post, { selected: true });
  assert.equal(f.api.posts.value[0].liked, true);
  const refreshed = f.api.load(false, true);
  f.calls[2].resolve({ posts: [{ ...post, visibility: 'private' }], cursor: null }); await refreshed;
  assert.deepEqual(f.api.posts.value, []);
  f.calls[1].resolve({ post: { ...post, liked: true, likeCount: 1 } });
  assert.equal(await like, undefined);
  assert.deepEqual(f.api.posts.value, []);
  assert.deepEqual(f.api.busy.value, {});
});

test('privacy acceptance and deletion both invalidate earlier reads and reaction acknowledgements', async context => {
  for (const update of [feed => feed.acceptPost({ id: 'post', visibility: 'private' }), feed => feed.removePost('post')]) {
    const f = harness(context, undefined, { kind: 'public' });
    const post = { id: 'post', visibility: 'public', liked: false };
    f.calls[0].resolve({ posts: [post], cursor: null }); await settle();
    const like = f.api.mutate('setMealLike', post, { selected: true });
    const refreshed = f.api.load(false, true);
    update(f.api);
    f.calls[2].resolve({ posts: [post], cursor: null }); await refreshed;
    f.calls[1].resolve({ post: { ...post, liked: true } });
    assert.equal(await like, undefined, 'the parent must not receive an obsolete public snapshot');
    assert.deepEqual(f.api.posts.value, []);
    assert.equal(f.api.error.value, '');
  }
});

test('late reaction success and failure preserve newer diary visibility and family details', async context => {
  for (const failure of [false, true]) {
    const f = harness(context);
    const post = { id: 'post', visibility: 'public', author: { name: '旧家庭名' }, liked: false, likeCount: 0, reactions: [] };
    f.calls[0].resolve({ posts: [post], cursor: null }); await settle();
    const like = f.api.mutate('setMealLike', post, { selected: true });
    const refreshed = f.api.load(false, true);
    f.calls[2].resolve({ posts: [{ ...post, visibility: 'private', author: { name: '新家庭名' } }], cursor: null }); await refreshed;
    if (failure) f.calls[1].reject(new Error('网络断开'));
    else f.calls[1].resolve({ post: { ...post, liked: true, likeCount: 1 } });
    const result = await like;
    assert.equal(f.api.posts.value[0].visibility, 'private');
    assert.equal(f.api.posts.value[0].author.name, '新家庭名');
    assert.equal(f.api.posts.value[0].liked, !failure);
    if (failure) assert.equal(result, undefined);
    else {
      assert.equal(result.post.visibility, 'private', 'the parent receives current privacy, not the reaction response snapshot');
      assert.equal(result.post.author.name, '新家庭名');
    }
  }
});

test('accepting a private diary record suppresses an older reaction failure without rolling it back', async context => {
  const f = harness(context);
  const post = { id: 'post', visibility: 'public', liked: false };
  f.calls[0].resolve({ posts: [post], cursor: null }); await settle();
  const like = f.api.mutate('setMealLike', post, { selected: true });
  const saved = { ...post, visibility: 'private', author: { name: '新家庭名' } };
  f.api.acceptPost(saved);
  f.calls[1].reject(new Error('旧请求失败'));
  assert.equal(await like, undefined);
  assert.deepEqual(f.api.posts.value, [saved]);
  assert.equal(f.api.error.value, '');
});

test('visibility changes reject missing, mismatched, and unconfirmed acknowledgements', async context => {
  for (const response of [{}, { post: { id: 'other', visibility: 'private' } }, { post: { id: 'post', visibility: 'public' } }]) {
    const f = harness(context);
    const post = { id: 'post', visibility: 'public' };
    f.calls[0].resolve({ posts: [post], cursor: null }); await settle();
    const changed = f.api.mutate('setMealVisibility', post, { visibility: 'private' });
    f.calls[1].resolve(response);
    assert.equal(await changed, undefined);
    assert.equal(f.api.error.value, '可见范围尚未确认，请刷新后重试');
    assert.equal(f.api.posts.value[0].visibility, 'public');
    assert.deepEqual(f.api.busy.value, {});
  }
});

test('diary visibility feedback waits for confirmed save and duplicate taps submit once', async context => {
  const feed = harness(context), messages = [];
  const post = { id: 'post', visibility: 'public' };
  feed.calls[0].resolve({ posts: [post], cursor: null }); await settle();
  const diary = harness(context, 'MealTimeline', { inject: key => key === 'mealDiaryFeed' ? feed.api : null, notify: message => messages.push(message) }, { active: true, today: '2026-11-05', orders: [] });
  const saved = diary.api.visibility(post, 'private');
  await diary.api.visibility(post, 'private');
  assert.equal(feed.calls.length, 2);
  assert.deepEqual(messages, [], 'pending requests must not claim to be saved');
  assert.deepEqual(diary.events, []);
  const result = { post: { ...post, visibility: 'private' } };
  feed.calls[1].resolve(result); await saved;
  assert.deepEqual(messages, ['已设为仅饮食日记']);
  assert.deepEqual(diary.events, [['changed', result]]);
  assert.equal(feed.api.posts.value[0].visibility, 'private');
});

test('failed privacy save shows explicit failure, keeps retry details and emits no success', async context => {
  const feed = harness(context), messages = [];
  const post = { id: 'post', visibility: 'public' };
  feed.calls[0].resolve({ posts: [post], cursor: null }); await settle();
  const diary = harness(context, 'MealTimeline', { inject: key => key === 'mealDiaryFeed' ? feed.api : null, notify: message => messages.push(message) }, { active: true, today: '2026-11-05', orders: [] });
  const saved = diary.api.visibility(post, 'private');
  feed.calls[1].reject(new Error('网络断开')); await saved;
  assert.deepEqual(messages, ['未保存成功：网络断开']);
  assert.equal(feed.api.error.value, '网络断开');
  assert.deepEqual(diary.events, []);
  assert.equal(feed.api.posts.value[0].visibility, 'public');
});

test('making a diary record public requires confirmation and reports the confirmed result', async context => {
  const feed = harness(context), messages = [];
  const post = { id: 'post', visibility: 'private' };
  feed.calls[0].resolve({ posts: [post], cursor: null }); await settle();
  const diary = harness(context, 'MealTimeline', { inject: key => key === 'mealDiaryFeed' ? feed.api : null, notify: message => messages.push(message) }, { active: true, today: '2026-11-05', orders: [] });
  const previous = globalThis.uni; let dialog;
  globalThis.uni = { showModal: options => { dialog = options; } };
  context.after(() => { globalThis.uni = previous; });
  const cancelled = diary.api.visibility(post, 'public');
  dialog.success({ confirm: false }); await cancelled;
  assert.equal(feed.calls.length, 1);
  assert.deepEqual(messages, []);
  const confirmed = diary.api.visibility(post, 'public');
  dialog.success({ confirm: true }); await settle();
  assert.equal(feed.calls[1].action, 'setMealVisibility');
  assert.deepEqual(messages, []);
  feed.calls[1].resolve({ post: { ...post, visibility: 'public' } }); await confirmed;
  assert.deepEqual(messages, ['已设为公开']);
  assert.equal(diary.events.length, 1);
});

test('only the frontmost sheet forwards its scroll bottom to timeline pagination', () => {
  const sheet = read('../src/components/Sheet.vue');
  const handler = sheet.match(/function reachBottom\(\) \{[^\n]+/)[0];
  const events = []; let top = true;
  const reachBottom = new Function('layer', 'emit', `${handler}; return reachBottom;`)({ isTop: () => top }, event => events.push(event));
  reachBottom(); top = false; reachBottom(); top = true; reachBottom();
  assert.deepEqual(events, ['reach-bottom', 'reach-bottom']);
  assert.match(sheet, /class="sheet-scroll"[^>]*@scrolltolower="reachBottom"/);
  const page = read('../src/pages/index/index.vue');
  assert.match(page, /<Sheet v-if="mealHistoryOpen"[^>]*:fit-content="false"[^>]*@reach-bottom="mealTimeline\?\.loadMore\(\)"/);
  assert.match(page, /<MealTimeline[^>]*:active="!mealPublishing && !orderRecipe"/);
});

test('family mode rejection preserves identity and duplicate taps submit once', async context => {
  const task = deferred(), calls = [], messages = [];
  const state = Vue.ref({ family: { id: 'family-a', kind: 'family' } });
  const f = harness(context, 'FamilyView', {
    state, activeMember: Vue.ref({ id: 'alice' }), notify: message => messages.push(message),
    familyAppearance: family => family, familyPublicId: family => family.id,
    manageFamily: (action, args) => { calls.push({ action, args }); return task.promise; },
  });
  const pending = f.api.toggleMode(); await f.api.toggleMode();
  assert.deepEqual(calls, [{ action: 'switchWorkspace', args: { mode: 'personal', expectedSpaceId: 'family-a' } }]);
  assert.deepEqual(messages, [], 'pending status does not produce a toast');
  assert.equal(f.api.modeBusy.value, true);
  assert.equal(f.api.displayedFamilyMode.value, false, 'switch moves immediately before cloud result');
  assert.equal(state.value.family.id, 'family-a', 'permissions stay in the confirmed workspace');
  task.reject(new Error('暂时无法切换')); await pending;
  assert.equal(f.api.modeBusy.value, false);
  assert.equal(f.api.modeError.value, '暂时无法切换');
  assert.deepEqual(messages, ['暂时无法切换']);
  assert.equal(f.api.personal.value, false);
  assert.equal(f.api.displayedFamilyMode.value, true, 'failure restores the switch');
  assert.equal(state.value.family.id, 'family-a');
});

test('enabling family without a membership opens family management', async context => {
  const f = harness(context, 'FamilyView', {
    state: Vue.ref({ family: { id: 'personal-alice', kind: 'personal' } }),
    activeMember: Vue.ref({ id: 'alice' }), notify() {},
    familyAppearance: family => family, familyPublicId: family => family.id,
    manageFamily: async () => { throw Object.assign(new Error('请选择家庭'), { code: 'FAMILY_REQUIRED' }); },
  });
  await f.api.toggleMode();
  assert.deepEqual(f.events, [['manage']]);
  assert.equal(f.api.personal.value, true);
  assert.equal(f.api.modeBusy.value, false);
});

test('switching away and back cannot apply the old workspace mutation', async context => {
  const f = harness(context);
  f.calls[0].resolve({ posts: [{ id: 'post', liked: false }], cursor: null }); await settle();
  const update = f.api.mutate('setMealLike', f.api.posts.value[0], { selected: true });
  f.modules.cloudStatus.value.familyId = 'family-b';
  f.modules.cloudStatus.value.familyId = 'family-a';
  assert.equal(f.calls.length, 4);
  f.calls[3].resolve({ posts: [{ id: 'post', liked: false }], cursor: null }); await settle();
  f.calls[1].resolve({ post: { id: 'post', liked: true } }); await update;
  f.calls[2].resolve({ posts: [{ id: 'private-b' }], cursor: null }); await settle();
  assert.deepEqual(f.api.posts.value.map(p => [p.id, p.liked]), [['post', false]]);
  assert.deepEqual(f.api.busy.value, {});
});

test('meal list waits for a ready connection and ignores responses after unmount', async context => {
  const f = harness(context, undefined, { cloudStatus: Vue.ref({ phase: 'connecting', familyId: 'family-a', userId: 'alice' }) });
  assert.equal(f.calls.length, 0);
  f.modules.cloudStatus.value.phase = 'ready'; await settle();
  assert.equal(f.calls.length, 1);
  f.unmount();
  f.calls[0].resolve({ posts: [{ id: 'late' }], cursor: null }); await settle();
  assert.deepEqual(f.api.posts.value, []);
});

test('failed reactions preserve previous data and can be retried once', async context => {
  const f = harness(context);
  f.calls[0].resolve({ posts: [{ id: 'post', liked: false }], cursor: null }); await settle();
  const update = f.api.mutate('setMealLike', f.api.posts.value[0], { selected: true });
  await f.api.mutate('setMealLike', f.api.posts.value[0], { selected: true });
  assert.equal(f.calls.length, 2);
  f.calls[1].reject(new Error('网络断开')); await update;
  assert.equal(f.api.posts.value[0].liked, false);
  assert.equal(f.api.error.value, '网络断开');
  const retry = f.api.mutate('setMealLike', f.api.posts.value[0], { selected: true });
  f.calls[2].resolve({ post: { id: 'post', liked: true } }); await retry;
  assert.equal(f.api.posts.value[0].liked, true);
  assert.equal(f.api.error.value, '');
});

test('meal photo fallback previews never enter the uploaded selection and return after removing real photos', context => {
  const props = Vue.reactive({ modelValue: [], fallbackImages: ['cloud://dish-a', 'cloud://dish-b'], variant: 'meal', label: '餐食实拍' });
  const previews = [];
  const f = harness(context, 'StepImagePicker', { useSheetContentResize() {}, previewImages: (...args) => previews.push(args) }, props);
  assert.deepEqual(f.api.visibleFallbacks.value, props.fallbackImages);
  assert.deepEqual(props.modelValue, []);
  f.api.previewFallback('cloud://dish-b');
  assert.deepEqual(previews[0], [props.fallbackImages, 'cloud://dish-b']);
  f.api.entries.value = [{ path: 'local-photo.jpg' }];
  assert.deepEqual(f.api.visibleFallbacks.value, [], 'new local previews immediately replace the fallback grid');
  f.api.entries.value = [];
  assert.deepEqual(f.api.visibleFallbacks.value, props.fallbackImages, 'cancelled or failed uploads retain the usable original photos');
  props.modelValue = ['cloud://real-meal'];
  assert.deepEqual(f.api.visibleFallbacks.value, []);
  f.api.preview('cloud://real-meal');
  assert.deepEqual(previews[1], [['cloud://real-meal'], 'cloud://real-meal']);
  f.api.remove(0);
  assert.deepEqual(f.events, [['update:modelValue', []], ['incomplete', false]]);
  props.modelValue = f.events[0][1];
  assert.deepEqual(f.api.visibleFallbacks.value, props.fallbackImages);
});

test('recording with fallback dish photos keeps the server-owned plan payload', async context => {
  const order = { id: 'order-a', date: '2026-11-05', meal: '午餐', items: [{ recipe: { image: 'cloud://dish-a' } }, { recipe: { image: 'cloud://dish-b' } }] };
  const f = harness(context, 'MealPublishSheet', { foodCover: image => image }, { order });
  assert.deepEqual(f.api.orderImages.value, ['cloud://dish-a', 'cloud://dish-b']);
  const saved = f.api.save();
  assert.equal(f.calls[0].action, 'finishMeal');
  assert.equal(f.calls[0].args.kind, 'plan');
  assert.equal(f.calls[0].args.orderId, order.id);
  assert.equal(f.calls[0].args.visibility, 'public');
  assert.equal(Object.hasOwn(f.calls[0].args, 'images'), false, 'fallback references are not submitted as user-uploaded meal photos');
  f.calls[0].resolve({ post: { id: 'plan-post' } });
  await saved;
  assert.deepEqual(f.events, [['saved', { id: 'plan-post' }]]);
});

test('collapsed meal labels retain their selection and cannot change during upload or save', async context => {
  const f = harness(context, 'MealPublishSheet');
  assert.equal(f.api.moodsExpanded.value, false);
  assert.equal(f.api.moodSummary.value, '未选择');
  f.api.uploading.value = true;
  f.api.toggleMoodOptions();
  f.api.toggleMood('home');
  await f.api.save();
  assert.equal(f.api.moodsExpanded.value, false);
  assert.deepEqual(f.api.moodIds.value, []);
  assert.equal(f.calls.length, 0);

  f.api.uploading.value = false;
  f.api.toggleMoodOptions();
  assert.equal(f.api.moodsExpanded.value, true);
  f.api.toggleMood('home'); f.api.toggleMood('clean');
  f.api.toggleMoodOptions();
  assert.equal(f.api.moodsExpanded.value, false);
  assert.equal(f.api.moodSummary.value, '家常幸福、今天光盘');
  f.api.toggleMoodOptions();
  assert.deepEqual(f.api.moodIds.value, ['home', 'clean']);
  f.api.toggleMood('home');
  f.api.toggleMoodOptions();
  assert.equal(f.api.moodSummary.value, '今天光盘');

  f.api.images.value = ['cloud://photo'];
  const save = f.api.save();
  f.api.toggleMoodOptions(); f.api.toggleMood('clean');
  assert.equal(f.api.moodsExpanded.value, false);
  assert.deepEqual(f.api.moodIds.value, ['clean']);
  assert.deepEqual(f.calls[0].args.moodIds, ['clean']);
  f.calls[0].resolve({ post: { id: 'with-collapsed-labels' } }); await save;
  assert.deepEqual(f.events, [['saved', { id: 'with-collapsed-labels' }]]);
});

test('unknown publish result locks the draft and retries the exact same request', async context => {
  const f = harness(context, 'MealPublishSheet');
  f.api.images.value = ['cloud://photo'];
  const save = f.api.save();
  await f.api.save();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].action, 'publishMeal');
  f.calls[0].reject(new Error('timeout')); await save;
  assert.equal(f.api.locked.value, true);
  assert.ok(f.api.pendingRequest.value);
  // Even a programmatic field update cannot alter a retry that may be committed.
  f.api.moodIds.value = ['home'];
  const retry = f.api.save();
  assert.deepEqual(f.calls[1].args, f.calls[0].args);
  f.calls[1].resolve({ post: { id: 'one-post' } }); await retry;
  assert.deepEqual(f.events, [['saved', { id: 'one-post' }]]);
  assert.equal(f.api.pendingRequest.value, null);
});

test('a definitive rejected publish keeps photos editable and an unmounted sheet emits no success', async context => {
  const f = harness(context, 'MealPublishSheet');
  await f.api.save(); assert.equal(f.calls.length, 0); assert.match(f.api.error.value, /照片/);
  f.api.images.value = ['cloud://photo'];
  const rejected = f.api.save();
  f.calls[0].reject(Object.assign(new Error('重新选择图片'), { code: 'FORBIDDEN', serverRejected: true })); await rejected;
  assert.equal(f.api.locked.value, false);
  assert.deepEqual(f.api.images.value, ['cloud://photo']);
  const retry = f.api.save(); f.unmount();
  f.calls[1].resolve({ post: { id: 'late' } }); await retry;
  assert.deepEqual(f.events, []);
});

test('leaving a photo draft requires the user to choose discard', async context => {
  const f = harness(context, 'MealPublishSheet');
  const previous = globalThis.uni; let dialog;
  globalThis.uni = { showModal: options => { dialog = options; } };
  context.after(() => { globalThis.uni = previous; });
  f.api.images.value = ['cloud://photo'];
  const keep = f.api.close(); dialog.success({ confirm: false }); await keep;
  assert.deepEqual(f.events, []);
  const leave = f.api.close(); dialog.success({ confirm: true }); await leave;
  assert.deepEqual(f.events, [['close']]);
});

test('confirming an arranged meal uses finishMeal with photos and fixed moods', async context => {
  const f = harness(context, 'MealPublishSheet', {}, { order: { id: 'order-a', date: '2026-11-07', meal: '午餐' } });
  assert.equal(f.api.kind.value, 'plan');
  // Real photos are optional below the dishes; selecting them chooses actual.
  f.api.images.value = ['cloud://removed'];
  assert.equal(f.api.kind.value, 'actual');
  f.api.images.value = [];
  assert.equal(f.api.kind.value, 'plan');
  f.api.images.value = ['cloud://my-lunch'];
  for (const id of ['home', 'clean', 'care', 'simple']) f.api.toggleMood(id);
  assert.deepEqual(f.api.moodIds.value, ['home', 'clean', 'care']);
  const saved = f.api.save();
  assert.equal(f.calls[0].action, 'finishMeal');
  assert.equal(f.calls[0].args.kind, 'actual');
  assert.equal(f.calls[0].args.visibility, 'public');
  assert.equal(f.calls[0].args.orderId, 'order-a');
  assert.equal(f.calls[0].args.date, '2026-11-05');
  assert.equal(f.calls[0].args.meal, '午餐');
  assert.deepEqual(f.calls[0].args.images, ['cloud://my-lunch']);
  f.api.toggleMood('home'); assert.equal(f.api.moodIds.value.length, 3);
  f.calls[0].resolve({ post: { id: 'real-lunch', visibility: 'public' } }); await saved;
  assert.equal(f.events[0][0], 'saved');
});

test('meal diary reveals eight at a time, stops when inactive and fetches the next cursor only at the loaded boundary', async context => {
  const posts = Vue.ref([]), cursor = Vue.ref({ id: 'next' }), loading = Vue.ref(false);
  const calls = [];
  const props = Vue.reactive({ active: true, today: '2026-11-05', orders: Array.from({ length: 19 }, (_, id) => ({ id: String(id), date: '2026-11-04', meal: '晚餐', status: 'accepted', items: [{ recipe: { id: 'dish' } }] })) });
  const f = harness(context, 'MealTimeline', { useMealPosts: () => ({ posts, cursor, loading, loaded: Vue.ref(true), error: Vue.ref(''), busy: Vue.ref({}), load: async more => { calls.push(more); posts.value = [{ id: 'photo', kind: 'actual', date: '2026-11-01', meal: '午餐' }]; cursor.value = null; }, mutate() {} }) }, props);
  assert.equal(f.api.limit.value, 8);
  assert.equal(f.api.days.value.length, 1);
  assert.equal(f.api.days.value[0].entries.length, 8);
  assert.equal(f.provided.get('imageViewActive').value, true);
  await f.api.more(); assert.equal(f.api.limit.value, 16); assert.deepEqual(calls, []);
  props.active = false; await f.api.more(); assert.equal(f.api.limit.value, 16);
  assert.equal(f.provided.get('imageViewActive').value, false);
  props.active = true; await f.api.more(); assert.equal(f.api.limit.value, 24); assert.deepEqual(calls, []);
  await f.api.more(); assert.deepEqual(calls, [true]);
  assert.equal(f.api.entries.value.length, 20);
  assert.deepEqual(f.api.days.value.map(day => day.date), ['2026-11-04', '2026-11-01']);
  assert.equal(f.api.hasMore.value, false);
  await f.api.more(); assert.deepEqual(calls, [true]);
});

test('page pagination follows the visible meal tab and pauses behind a sheet', () => {
  const page = read('../src/pages/index/index.vue');
  const registration = page.match(/onReachBottom\(\(\) => \{[^\n]+/)[0];
  let reachBottom;
  const calls = [];
  const sheetOpen = Vue.ref(false), tab = Vue.ref('activity'), mealSection = Vue.ref('orders');
  const views = ['food', 'square', 'diary'].map(name => Vue.ref({ loadMore: () => calls.push(name) }));
  new Function('onReachBottom', 'sheetOpen', 'tab', 'mealSection', 'communityView', 'mealSquare', 'mealTimeline', registration)(callback => { reachBottom = callback; }, sheetOpen, tab, mealSection, ...views);
  reachBottom();
  tab.value = 'menu'; reachBottom();
  tab.value = 'square'; reachBottom();
  sheetOpen.value = true; reachBottom();
  tab.value = 'community'; reachBottom();
  sheetOpen.value = false; reachBottom();
  tab.value = 'menu'; reachBottom();
  assert.deepEqual(calls, ['square', 'food']);
});

test('successful sharing closes the draft and refreshes both owner history and public feed', async () => {
  const page = read('../src/pages/index/index.vue');
  const source = page.slice(page.indexOf('function mealSaved('), page.indexOf('\n}', page.indexOf('function mealSaved(')) + 2);
  const calls = [], tab = Vue.ref('menu'), mealPublishing = Vue.ref(true), mealShareOrder = Vue.ref({id:'order'}), mealSection = Vue.ref('orders');
  const mealSquare = Vue.ref({ refresh: () => calls.push('square') });
  const mealTimeline = Vue.ref({ refresh: () => calls.push('diary') });
  const save = new Function('publicFeed', 'diaryFeed', 'tab', 'mealPublishing', 'mealShareOrder', 'mealSection', 'mealSquare', 'mealTimeline', 'nextTick', 'notify', 'openMealHistory', 'deletedMealIds', 'mealHistoryOpen', `${source}; return mealSaved;`)({ acceptPost: () => calls.push('public-accept'), load: () => calls.push('square') }, { acceptPost: post => calls.push('accept'), load: () => calls.push('diary') }, tab, mealPublishing, mealShareOrder, mealSection, mealSquare, mealTimeline, Vue.nextTick, () => {}, () => calls.push('open-history'), Vue.ref([]), Vue.ref(true));
  save({visibility:'public'}); await settle();
  assert.equal(tab.value, 'square'); assert.equal(mealPublishing.value, false); assert.equal(mealShareOrder.value, null);
  assert.equal(mealSection.value, 'orders'); assert.deepEqual(calls, ['accept', 'public-accept', 'square', 'diary']);
  for (const visibility of ['private', 'family']) {
    save({ visibility }); await settle();
    assert.equal(tab.value, 'family');
    assert.equal(calls.at(-3), 'open-history');
  }
  assert.equal(mealSection.value, 'orders', 'records open personal history without changing the underlying tab');
});

test('confirmed meal hides immediately without mutating the snapshot, even if refresh fails', async () => {
  const page = read('../src/pages/index/index.vue');
  const source = page.slice(page.indexOf('function mealSaved('), page.indexOf('\n}', page.indexOf('function mealSaved(')) + 2);
  const order = Object.freeze({ id: 'dinner', status: 'accepted' });
  const calls = [], tab = Vue.ref('menu'), completedMealIds = Vue.ref([]), mealPublishing = Vue.ref(true), mealShareOrder = Vue.shallowRef(order), mealSection = Vue.ref('table');
  const save = new Function('publicFeed', 'diaryFeed', 'tab', 'completedMealIds', 'mealPublishing', 'mealShareOrder', 'mealSection', 'mealSquare', 'mealTimeline', 'nextTick', 'refreshCloud', 'notify', 'openMealHistory', 'deletedMealIds', 'mealHistoryOpen', `${source}; return mealSaved;`)(
    { acceptPost: () => calls.push('public-accept'), load: () => calls.push('square') },
    { acceptPost: post => calls.push('accept'), load: () => calls.push('mine') }, tab, completedMealIds, mealPublishing, mealShareOrder, mealSection,
    Vue.ref({ refresh: () => calls.push('square') }), Vue.ref({ refresh: () => calls.push('mine') }), Vue.nextTick,
    async () => { calls.push('refresh'); throw new Error('offline'); }, text => calls.push(text), () => calls.push('open-history'), Vue.ref(['dinner']), Vue.ref(true),
  );
  save({ mealStarted: true, visibility: 'public' });
  assert.deepEqual(completedMealIds.value, ['dinner']);
  assert.equal(order.status, 'accepted');
  assert.equal(tab.value, 'square'); assert.equal(mealPublishing.value, false);
  assert.equal(mealSection.value, 'table');
  await settle();
  assert.deepEqual(calls, ['accept', 'public-accept', 'refresh', '已记下这餐，餐单稍后刷新', 'square', 'mine']);
});

test('a day rollover reveals unconfirmed plans without writing or publishing them', async context => {
  const props = Vue.reactive({ active: true, today: '2026-11-05', orders: [
    { id: 'pending', date: '2026-11-05', meal: '晚餐', status: 'accepted', items: [{ recipe: { id: 'a' } }] },
    { id: 'cancelled', date: '2026-11-05', meal: '午餐', status: 'cancelled', items: [{ recipe: { id: 'a' } }] },
  ] });
  const before = JSON.stringify(props.orders);
  const f = harness(context, 'MealTimeline', { useMealPosts: () => ({ posts: Vue.ref([]), cursor: Vue.ref(null), loading: Vue.ref(false), loaded: Vue.ref(true), error: Vue.ref(''), busy: Vue.ref({}), load() {}, mutate() { throw new Error('unexpected write'); } }) }, props);
  assert.equal(f.api.entries.value.length, 0);
  props.today = '2026-11-06'; await settle();
  assert.deepEqual(f.api.entries.value.map(entry => entry.order.id), ['pending']);
  assert.equal(f.api.entries.value[0].order.status, 'accepted');
  assert.equal(JSON.stringify(props.orders), before);
  assert.deepEqual(f.calls, []);
});

test('a late public reaction acknowledgement cannot revert a diary privacy change', async context => {
  const f = harness(context);
  f.calls[0].resolve({ posts: [{ id: 'post', visibility: 'private', liked: false, likeCount: 0 }], cursor: null }); await settle();
  f.api.syncReactions({ id: 'post', visibility: 'public', isOwner: false, liked: true, likeCount: 1, likeUsers: [{ key: 'member', name: '家人', self: true }], reactions: [] });
  assert.equal(f.api.posts.value[0].visibility, 'private');
  assert.equal(f.api.posts.value[0].liked, true);
  assert.equal(f.api.posts.value[0].likeUsers[0].name, '家人', 'shared diary receives names without replacing privacy');
  f.api.syncReactions({ id: 'post', visibility: 'public', liked: false, likeCount: 0, likeUsers: [], reactions: [] });
  assert.deepEqual(f.api.posts.value[0].likeUsers, []);
  f.api.removePost('post');
  f.api.syncReactions({ id: 'post', visibility: 'public', liked: true });
  assert.deepEqual(f.api.posts.value, [], 'late reactions never recreate removed records');
});

test('both composers submit private visibility and freeze it across uncertain retries', async context => {
  for (const order of [undefined, { id: 'order-a', date: '2026-11-05', meal: '晚餐' }]) {
    const f = harness(context, 'MealPublishSheet', {}, { order });
    f.api.images.value = ['cloud://photo'];
    f.api.toggleVisibilityOptions();
    assert.equal(f.api.visibilityExpanded.value, true);
    f.api.selectVisibility('private');
    assert.equal(f.api.visibilityExpanded.value, false);
    assert.equal(f.api.visibilityLabel.value, '仅饮食日记');
    const saved = f.api.save();
    assert.equal(f.calls[0].args.visibility, 'private');
    f.calls[0].reject(new Error('timeout')); await saved;
    f.api.selectVisibility('public');
    assert.equal(f.api.visibility.value, 'private');
    const retry = f.api.save();
    assert.deepEqual(f.calls[1].args, f.calls[0].args);
    f.calls[1].resolve({ post: { id: 'private', visibility: 'private' } }); await retry;
  }
});


test('diary deletion suppresses historical fallback and sends scoped protocol only after confirmation', async context => {
  const f = harness(context);
  const post = { id: 'shared', sourceOrderId: 'dinner', visibility: 'family' };
  f.calls[0].resolve({ posts: [post], diaryManagementVersion: 1, suppressedOrderIds: ['earlier'], cursor: null });
  await settle();
  const deleting = f.api.mutate('deleteMealPost', post);
  assert.equal(f.calls[1].args.diaryManagementVersion, 1);
  f.calls[1].resolve({ deletedId: 'shared', deleteScope: 'personal' });
  assert.equal((await deleting).deleteScope, 'personal');
  assert.deepEqual(f.api.posts.value, []);
  assert.deepEqual(f.api.suppressedOrderIds.value, ['earlier', 'dinner']);
  f.modules.cloudStatus.value.familyId = 'different'; await settle();
  assert.deepEqual(f.api.suppressedOrderIds.value, []);
  assert.equal(f.api.diaryManagementVersion.value, 0);
});

test('failed delete keeps the original record and does not suppress its order', async context => {
  const f = harness(context);
  const post = { id: 'shared', sourceOrderId: 'dinner' };
  f.calls[0].resolve({ posts: [post], cursor: null }); await settle();
  const deleting = f.api.mutate('deleteMealPost', post);
  assert.equal(f.calls[1].args.diaryManagementVersion, undefined);
  f.calls[1].reject(new Error('网络不可用')); await deleting;
  assert.deepEqual(f.api.posts.value, [post]);
  assert.deepEqual(f.api.suppressedOrderIds.value, []);
  assert.equal(f.api.error.value, '网络不可用');
});

test('managed diary never recreates a deleted meal while archival is still progressing', context => {
  const f = harness(context, 'MealTimeline', { useMealPosts: () => ({ posts: Vue.ref([]), diaryManagementVersion: Vue.ref(1), diaryArchiveComplete: Vue.ref(false), cursor: Vue.ref(null), loading: Vue.ref(false), loaded: Vue.ref(true), error: Vue.ref(''), busy: Vue.ref({}), load() {}, mutate() {} }) }, {
    active: true, today: '2026-11-08', orders: [{ id: 'deleted-order', date: '2026-11-07', meal: '晚餐', status: 'completed', items: [{ recipe: { id: 'r' } }] }],
  });
  assert.deepEqual(f.api.entries.value, []);
});


test('arrangement picker starts empty and only offers eligible meals today', context => {
  const orders = [
    { id: 'today', date: '2026-11-05', meal: '午餐', status: 'pending', items: [{ recipe: { image: 'cover', title: '菜' } }] },
    ...['cancelled', 'completed'].map(status => ({ id: status, date: '2026-11-05', status, items: [{}] })),
    { id: 'empty', date: '2026-11-05', status: 'pending', items: [] },
    { id: 'future', date: '2026-11-06', status: 'pending', items: [{}] },
    { id: 'past', date: '2026-11-04', status: 'pending', items: [{}] },
  ];
  const f = harness(context, 'MealPublishSheet', { foodCover: image => image }, { orders });
  assert.equal(f.api.selectedOrder.value, null);
  assert.equal(f.api.kind.value, 'actual');
  assert.deepEqual(f.api.availableOrders.value.map(item => item.id), ['today']);
  f.api.selectArrangement('today');
  assert.equal(f.api.kind.value, 'plan');
  assert.equal(f.api.meal.value, '午餐');
  assert.deepEqual(f.api.orderImages.value, ['cover']);
  f.api.images.value = ['cloud://photo'];
  assert.equal(f.api.kind.value, 'actual');
  f.api.selectArrangement('');
  assert.equal(f.api.selectedOrder.value, null);
  assert.deepEqual(f.api.images.value, ['cloud://photo']);
});

test('arrangement picker includes today’s deleted diary for rerecording and submits its order', async context => {
  const order = { id: 'deleted-diary', date: '2026-11-05', meal: '午餐', status: 'completed', diaryDeletedAt: 1, items: [{ recipe: { image: 'cover', title: '菜' } }] };
  const orders = [order,
    { ...order, id: 'recorded', diaryDeletedAt: undefined },
    { ...order, id: 'cancelled', status: 'cancelled' },
    { ...order, id: 'empty', items: [] },
    { ...order, id: 'future', date: '2026-11-06' },
  ];
  const f = harness(context, 'MealPublishSheet', { foodCover: image => image }, { orders });
  assert.deepEqual(f.api.availableOrders.value.map(item => item.id), ['deleted-diary']);
  f.api.selectArrangement(order.id);
  assert.equal(f.api.selectedOrder.value.id, order.id);
  assert.equal(f.api.date.value, order.date);
  assert.equal(f.api.meal.value, order.meal);
  assert.deepEqual(f.api.orderImages.value, ['cover']);
  const saving = f.api.save();
  assert.equal(f.calls[0].action, 'finishMeal');
  assert.equal(f.calls[0].args.orderId, order.id);
  f.calls[0].resolve({ post: { id: 'rerecorded' } });
  await saving;
});

test('selected arrangement uses existing finish protocol and locks selection during save', async context => {
  const order = { id: 'today', date: '2026-11-05', meal: '午餐', status: 'accepted', items: [{ recipe: { title: '菜' } }] };
  const f = harness(context, 'MealPublishSheet', {}, { orders: [order] });
  f.api.selectArrangement('today');
  const saving = f.api.save();
  assert.equal(f.calls[0].action, 'finishMeal');
  assert.equal(f.calls[0].args.orderId, 'today');
  assert.equal(f.calls[0].args.kind, 'plan');
  f.api.selectArrangement('');
  assert.equal(f.api.selectedOrderId.value, 'today');
  f.calls[0].resolve({ post: { id: 'post', orderId: 'today' } });
  await saving;
});

test('changed arrangement cannot silently publish as an unrelated photo', async context => {
  const props = Vue.reactive({ orders: [{ id: 'today', date: '2026-11-05', meal: '午餐', status: 'pending', items: [{}] }] });
  const f = harness(context, 'MealPublishSheet', {}, props);
  f.api.selectArrangement('today');
  props.orders = [];
  f.api.images.value = ['cloud://photo'];
  await f.api.save();
  assert.equal(f.calls.length, 0);
  assert.match(f.api.error.value, /安排已变更/);
});

test('liker names appear immediately and roll back with count on save failure', async context => {
  const f = harness(context, undefined, { kind: 'public', currentIdentity: Vue.ref({ profile: { name: '新昵称' } }) });
  const post = { id: 'p', visibility: 'public', liked: false, likeCount: 1, likeUsers: [{ key: 'b', name: '家人', self: false }] };
  f.calls[0].resolve({ posts: [post], cursor: null }); await settle();
  const pending = f.api.mutate('setMealLike', post, { selected: true });
  assert.deepEqual(f.api.posts.value[0].likeUsers.map(user => user.name), ['家人', '新昵称']);
  assert.equal(f.api.posts.value[0].likeCount, 2);
  f.calls[1].reject(new Error('网络失败')); await pending;
  assert.deepEqual(f.api.posts.value[0].likeUsers, post.likeUsers);
  assert.equal(f.api.posts.value[0].likeCount, 1);
});

test('like and cancel are immediate and serialize the final intent without disabled buttons', async context => {
  const f = harness(context);
  const post = { id: 'p', visibility: 'public', liked: false, likeCount: 0, likeUsers: [] };
  f.calls[0].resolve({ posts: [post], cursor: null }); await settle();
  const save = f.api.mutate('setMealLike', post, { selected: true });
  assert.equal(f.api.posts.value[0].likeUsers.length, 1);
  assert.deepEqual(f.api.busy.value, {});
  await f.api.mutate('setMealLike', f.api.posts.value[0], { selected: false });
  assert.equal(f.api.posts.value[0].liked, false);
  assert.equal(f.api.posts.value[0].likeUsers.length, 0);
  assert.equal(f.calls.length, 2, 'writes cannot arrive out of order');
  f.calls[1].resolve({ reaction: { id: 'p', liked: true, likeCount: 1 } }); await settle();
  assert.equal(f.api.posts.value[0].liked, false, 'old acknowledgement cannot flash the old like');
  assert.equal(f.calls[2].args.selected, false);
  const refresh = f.api.load(false, true);
  f.calls[3].resolve({ posts: [{ ...post, liked: true, likeCount: 1 }], cursor: null }); await refresh;
  assert.equal(f.api.posts.value[0].liked, false);
  f.calls[2].resolve({ reaction: { id: 'p', liked: false, likeCount: 0 } }); await save;
  assert.equal(f.api.posts.value[0].likeCount, 0);
});

test('lost like response retries idempotently without removing the optimistic nickname', async context => {
  const f = harness(context);
  const post = { id: 'p', liked: false, likeCount: 0, likeUsers: [] };
  f.calls[0].resolve({ posts: [post], cursor: null }); await settle();
  const save = f.api.mutate('setMealLike', post, { selected: true });
  f.calls[1].reject(Object.assign(new Error('网络超时'), { code: 'NETWORK' })); await settle();
  assert.equal(f.api.posts.value[0].liked, true);
  assert.equal(f.calls[2].args.selected, true);
  f.calls[2].resolve({ reaction: { id: 'p', liked: true, likeCount: 1 } }); await save;
  assert.equal(f.api.posts.value[0].likeUsers.length, 1);
  assert.equal(f.api.error.value, '');
});

test('invalid like acknowledgement cannot silently pretend the like was saved', async context => {
  const f = harness(context);
  const post = { id: 'p', liked: false, likeCount: 0, likeUsers: [] };
  f.calls[0].resolve({ posts: [post], cursor: null }); await settle();
  const save = f.api.mutate('setMealLike', post, { selected: true });
  f.calls[1].resolve({ reaction: { id: 'p', liked: false, likeCount: 0 } }); await save;
  assert.equal(f.api.posts.value[0].liked, false);
  assert.match(f.api.error.value, /尚未确认/);
});

test('delete hides immediately through refresh, paging and late updates; confirmed deletion stays hidden', async context => {
  const f = harness(context);
  const post = { id: 'shared', sourceOrderId: 'dinner', createdAt: 2 };
  f.calls[0].resolve({ posts: [post], cursor: 'next' }); await settle();
  const deleting = f.api.mutate('deleteMealPost', post);
  assert.deepEqual(f.api.posts.value, []);
  assert.deepEqual(f.api.suppressedOrderIds.value, ['dinner']);
  f.api.acceptPost(post);
  f.api.syncReactions({ ...post, liked: true });
  const refresh = f.api.load(false, true);
  f.calls[2].resolve({ posts: [post], cursor: 'next' }); await refresh;
  assert.deepEqual(f.api.posts.value, []);
  assert.deepEqual(f.api.suppressedOrderIds.value, ['dinner']);
  f.calls[1].resolve({ deletedId: post.id, deleteScope: 'personal' }); await deleting;
  const more = f.api.load(true);
  f.calls[3].resolve({ posts: [post, { id: 'older' }], cursor: null }); await more;
  assert.deepEqual(f.api.posts.value.map(p => p.id), ['older']);
});

test('failed concurrent delete restores only its own record and preserves other order suppression', async context => {
  const f = harness(context);
  const a = { id: 'a', sourceOrderId: 'oa', createdAt: 3 }, b = { id: 'b', sourceOrderId: 'ob', createdAt: 2 }, c = { id: 'c', createdAt: 1 };
  f.calls[0].resolve({ posts: [a, b, c], cursor: null, suppressedOrderIds: ['existing'] }); await settle();
  const da = f.api.mutate('deleteMealPost', a), db = f.api.mutate('deleteMealPost', b);
  assert.deepEqual(f.api.posts.value, [c]);
  f.calls[2].resolve({ deletedId: 'b' }); await db;
  f.calls[1].reject(new Error('网络不可用')); await da;
  assert.deepEqual(f.api.posts.value, [a, c]);
  assert.deepEqual(new Set(f.api.suppressedOrderIds.value), new Set(['existing', 'ob']));
});

test('invalid delete acknowledgement restores entry and scope switch ignores old failure', async context => {
  const f = harness(context), post = { id: 'a', sourceOrderId: 'oa' };
  f.calls[0].resolve({ posts: [post], cursor: null }); await settle();
  const first = f.api.mutate('deleteMealPost', post);
  f.calls[1].resolve({}); await first;
  assert.deepEqual(f.api.posts.value, [post]);
  assert.match(f.api.error.value, /删除状态尚未确认/);
  const second = f.api.mutate('deleteMealPost', post);
  f.modules.cloudStatus.value.familyId = 'new-space'; await settle();
  f.calls[3].resolve({ posts: [{ id: 'new' }], cursor: null }); await settle();
  f.calls[2].reject(new Error('old failure')); await second;
  assert.deepEqual(f.api.posts.value, [{ id: 'new' }]);
  assert.deepEqual(f.api.suppressedOrderIds.value, []);
  assert.equal(f.api.error.value, '');
});

test('family default cover preserves publisher avatar instead of replacing it with default scenery', async context => {
  const identity = Vue.ref({ family: { id: 'family-a', name: '家庭', cover: DEFAULT_FAMILY_COVER }, profile: { avatar: 'viewer' } });
  const f = harness(context, undefined, { currentIdentity: identity });
  f.calls[0].resolve({ posts: [{ id: 'a', author: { mode: 'family', currentSpace: true, avatar: 'publisher' } }], cursor: null }); await settle();
  assert.equal(f.api.posts.value[0].author.avatar, 'publisher');
  identity.value.family.cover = 'custom-cover';
  assert.equal(f.api.posts.value[0].author.avatar, 'custom-cover');
  identity.value.family.cover = '';
  assert.equal(f.api.posts.value[0].author.avatar, 'publisher');
});


test('global family delete is immediate, rolls back on failure and protects the public cache', async context => {
  const f = harness(context), post = { id: 'family-post', sourceOrderId: 'order', visibility: 'public' };
  f.calls[0].resolve({ posts: [post], diaryManagementVersion: 1 }); await settle();
  const pending = f.api.mutate('deleteFamilyMealPost', post);
  assert.deepEqual(f.api.posts.value, []);
  assert.equal(f.calls[1].action, 'deleteFamilyMealPost');
  f.calls[1].reject(new Error('没有权限')); await pending;
  assert.deepEqual(f.api.posts.value, [post]);
  assert.deepEqual(f.api.suppressedOrderIds.value, []);
  f.api.removePost(post.id, true);
  const loading = f.api.load(false, true);
  f.calls[2].resolve({ posts: [post] }); await loading;
  f.api.acceptPost(post);
  assert.deepEqual(f.api.posts.value, []);
});

test('single feed photo keeps its measured geometry after the card remounts', context => {
  const sizes = new Map();
  const overrides = {
    inject: key => key === 'feedImageSizes' ? sizes : null,
    mealPostMedia: post => post.images.map(image => ({ image })),
    singleFeedImageWidth: (width, height) => width && height ? Math.min(200, width / height * 200) : 160,
  };
  const props = { feed: true, post: { id: 'photo-post', images: ['photo'], visibility: 'public' } };
  const first = harness(context, 'MealPostCard', overrides, props);
  first.api.rememberImageSize('photo', { width: 100, height: 200 });
  first.unmount();
  const restored = harness(context, 'MealPostCard', overrides, props);
  assert.equal(restored.api.singleImageRatio.value, .5);
  assert.equal(restored.api.singleImageStyle.value.width, '100px');
  const multiple = harness(context, 'MealPostCard', overrides, { ...props, post: { ...props.post, images: ['photo', 'other'] } });
  assert.equal(multiple.api.singleImageRatio.value, 0);
  assert.deepEqual(multiple.api.singleImageStyle.value, {});
});
