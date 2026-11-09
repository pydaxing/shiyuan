import { DEFAULT_FAMILY_COVER } from '../src/domain/family.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import { MEAL_ICONS, mealOrigin, MEAL_SLOTS, MEAL_MOODS, mealMoodDisplayLabel, mealPublicationAge } from '../src/domain/meal-social.js';
import { NATIVE_UI_COLORS } from '../src/domain/ui-theme.js';

import { singleFeedImageWidth } from '../src/domain/feed-image-layout.js';
import { mealPostMedia } from '../src/domain/meal-post-media.js';

const compiled = new Map();
function harness(context, component, overrides = {}, props = {}) {
  const stopped = [], calls = [], events = [];
  const scope = Vue.effectScope();
  const modules = {
    ...Vue, DEFAULT_FAMILY_COVER, inject: (key, fallback) => fallback, notify() {}, singleFeedImageWidth, mealPostMedia, MEAL_ICONS, mealOrigin, MEAL_SLOTS, MEAL_MOODS, mealMoodDisplayLabel, mealPublicationAge, NATIVE_UI_COLORS,
    cloudStatus: Vue.ref({ phase: 'ready', familyId: 'family-a', userId: 'alice', mealSharingVersion: 2 }),
    currentIdentity: Vue.ref({ family: { id: 'family-a', name: '小厨房' } }),
    localDate: () => '2026-11-07', foodCover: image => image, previewImages() {},
    onUnmounted: callback => stopped.push(callback),
    invokeCloud(action, args) {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      calls.push({ action, args: JSON.parse(JSON.stringify(args)), resolve, reject });
      return promise;
    },
    ...overrides,
  };
  if (!compiled.has(component)) {
    const source = readFileSync(new URL(`../src/components/${component}.vue`, import.meta.url), 'utf8');
    const script = compileScript(parse(source).descriptor, { id: 'meal-sharing-ui' }).content;
    compiled.set(component, script.replace(/import (\{[^}]+\}|\w+) from '[^']+';/g, (_, binding) => `const ${binding} = ${binding.startsWith('{') ? 'modules' : '{}'};`).replace('export default', 'return'));
  }
  const factory = new Function('modules', compiled.get(component))(modules);
  const api = scope.run(() => factory.setup(props, { expose() {}, emit: (...args) => events.push(args) }));
  context.after(() => { stopped.splice(0).forEach(stop => stop()); scope.stop(); });
  return { api, modules, calls, events };
}
function actionSheets(context) {
  const previous = globalThis.uni, sheets = [];
  globalThis.uni = { showActionSheet: options => sheets.push(options) };
  context.after(() => { globalThis.uni = previous; });
  return sheets;
}
function familyPost(overrides = {}) {
  return { id: 'family-meal', mealSharingVersion: 2, mealContext: 'family', visibility: 'family', showMealBadge: true, isOwner: true, ...overrides };
}

test('confirmed family sharing defaults to public, including legacy families without a kind', async context => {
  const f = harness(context, 'MealPublishSheet');
  assert.equal(f.api.familyMeal, true);
  assert.equal(f.api.visibility.value, 'public');
  assert.equal(f.api.visibilityLabel.value, '发现 · 公开');
  assert.deepEqual(f.api.visibilityOptions.map(option => option.value), ['public', 'family']);
  f.api.selectVisibility('private');
  assert.equal(f.api.visibility.value, 'public', 'a new family meal cannot silently become author-only');
  f.api.images.value = ['cloud://meal-photo'];
  const saved = f.api.save();
  assert.equal(f.calls[0].args.visibility, 'public');
  assert.equal(f.calls[0].args.mealSharingVersion, 2);
  assert.equal(f.calls[0].args.showMealBadge, true);
  assert.equal(Object.hasOwn(f.calls[0].args, 'participantUserIds'), false, 'membership comes from the server, never from the publisher');
  f.calls[0].resolve({ post: familyPost({ visibility: 'public' }) }); await saved;
  assert.deepEqual(f.events, [['saved', familyPost({ visibility: 'public' })]]);
});

test('personal meals keep public and self-only audiences while sending the optional solo badge', async context => {
  const f = harness(context, 'MealPublishSheet', {
    currentIdentity: Vue.ref({ family: { id: 'personal-a', kind: 'personal' } }),
    cloudStatus: Vue.ref({ familyId: 'personal-a', userId: 'alice', mealSharingVersion: 2 }),
  });
  assert.equal(f.api.familyMeal, false);
  assert.equal(f.api.visibility.value, 'public');
  assert.deepEqual(f.api.visibilityOptions.map(option => option.value), ['public', 'private']);
  f.api.selectVisibility('family');
  assert.equal(f.api.visibility.value, 'public');
  f.api.selectVisibility('private');
  assert.equal(f.api.visibilityLabel.value, '仅饮食日记');
  f.api.images.value = ['cloud://solo-photo'];
  const saved = f.api.save();
  assert.equal(f.calls[0].args.spaceId, 'personal-a');
  assert.equal(f.calls[0].args.visibility, 'private');
  f.calls[0].resolve({ post: { id: 'solo', mealSharingVersion: 2, mealContext: 'personal', visibility: 'private', showMealBadge: true } }); await saved;
  assert.equal(f.events.length, 1);
});

test('an older server receives only the existing public/private publish contract', async context => {
  const f = harness(context, 'MealPublishSheet', { cloudStatus: Vue.ref({ familyId: 'family-a', userId: 'alice' }) });
  assert.equal(f.api.sharedDiary, false);
  assert.equal(f.api.visibility.value, 'public');
  assert.deepEqual(f.api.visibilityOptions.map(option => option.value), ['public', 'private']);
  f.api.selectVisibility('family');
  assert.equal(f.api.visibility.value, 'public');
  f.api.selectVisibility('private');
  f.api.images.value = ['cloud://legacy-photo'];
  const saved = f.api.save();
  assert.equal(f.calls[0].args.visibility, 'private');
  assert.equal(Object.hasOwn(f.calls[0].args, 'mealSharingVersion'), false);
  assert.equal(Object.hasOwn(f.calls[0].args, 'showMealBadge'), false);
  f.calls[0].resolve({ post: { id: 'old-private', visibility: 'private' } }); await saved;
  assert.deepEqual(f.events, [['saved', { id: 'old-private', visibility: 'private' }]]);
});

test('background capability and mode updates do not change an already-open draft audience', context => {
  const f = harness(context, 'MealPublishSheet');
  f.modules.currentIdentity.value = { family: { id: 'personal-a', kind: 'personal' } };
  f.modules.cloudStatus.value.mealSharingVersion = 0;
  assert.equal(f.api.familyMeal, true);
  assert.equal(f.api.visibility.value, 'public');
  assert.deepEqual(f.api.visibilityOptions.map(option => option.value), ['public', 'family']);

  const old = harness(context, 'MealPublishSheet', { cloudStatus: Vue.ref({ familyId: 'family-a', userId: 'alice' }) });
  old.modules.cloudStatus.value.mealSharingVersion = 2;
  assert.equal(old.api.sharedDiary, false);
  assert.deepEqual(old.api.visibilityOptions.map(option => option.value), ['public', 'private']);
});

test('new meals retain their automatic badge across audience changes and an exact timeout retry', async context => {
  const f = harness(context, 'MealPublishSheet');
  f.api.selectVisibility('public');
  assert.equal(f.api.showMealBadge.value, true);
  f.api.selectVisibility('family'); f.api.selectVisibility('public');
  assert.equal(f.api.showMealBadge.value, true);
  f.api.images.value = ['cloud://meal-photo'];
  const first = f.api.save();
  assert.equal(f.calls[0].args.showMealBadge, true);
  f.calls[0].reject(new Error('timeout')); await first;
  assert.equal(f.api.locked.value, true);
  assert.equal(f.api.showMealBadge.value, true);
  f.api.selectVisibility('family');
  assert.equal(f.api.visibility.value, 'public');
  f.api.showMealBadge.value = false;
  f.api.visibility.value = 'family';
  const retry = f.api.save();
  assert.deepEqual(f.calls[1].args, f.calls[0].args, 'even programmatic draft changes do not alter a possibly-committed request');
  f.calls[1].resolve({ post: familyPost({ visibility: 'public', showMealBadge: true }) }); await retry;
  assert.equal(f.api.pendingRequest.value, null);
  assert.equal(f.events[0][1].showMealBadge, true);
});

test('an old or mismatched response cannot claim a new family record was saved with the intended audience', async context => {
  for (const post of [
    { id: 'legacy-public', visibility: 'public' },
    familyPost({ visibility: 'family' }),
    familyPost({ showMealBadge: false }),
  ]) {
    const f = harness(context, 'MealPublishSheet');
    f.api.images.value = ['cloud://photo'];
    const saved = f.api.save();
    f.calls[0].resolve({ post }); await saved;
    assert.equal(f.events.length, 0);
    assert.equal(f.api.locked.value, true);
    assert.match(f.api.error.value, /重试确认/);
    const retry = f.api.save();
    assert.deepEqual(f.calls[1].args, f.calls[0].args);
    f.calls[1].resolve({ post: familyPost({ visibility: 'public' }) }); await retry;
    assert.equal(f.events.length, 1);
  }
});

test('family sharing options and badges also apply when recording an arranged meal', async context => {
  const order = { id: 'dinner', date: '2026-11-07', meal: '晚餐', items: [{ recipe: { image: 'cloud://dish' } }] };
  const f = harness(context, 'MealPublishSheet', {}, { order });
  const saved = f.api.save();
  assert.equal(f.calls[0].action, 'finishMeal');
  assert.equal(f.calls[0].args.kind, 'plan');
  assert.equal(f.calls[0].args.orderId, order.id);
  assert.equal(f.calls[0].args.visibility, 'public');
  assert.equal(f.calls[0].args.mealSharingVersion, 2);
  assert.equal(Object.hasOwn(f.calls[0].args, 'images'), false);
  f.calls[0].resolve({ post: familyPost({ visibility: 'public', mealStarted: true }) }); await saved;
  assert.equal(f.events[0][1].mealStarted, true);
});

test('meal bubbles offer one direct audience toggle followed by delete without native action sheets', context => {
  const sheets = actionSheets(context);
  for (const [post, label, target] of [
    [familyPost({ visibility: 'public' }), '仅饮食日记', 'family'],
    [familyPost(), '设为公开', 'public'],
    [familyPost({ visibility: 'private' }), '设为公开', 'public'],
    [{ id: 'legacy', isOwner: true, visibility: 'public' }, '仅饮食日记', 'private'],
    [familyPost({ mealContext: 'personal', visibility: 'private' }), '设为公开', 'public'],
  ]) {
    const f = harness(context, 'MealPostCard', {}, { post });
    f.api.more();
    assert.equal(f.api.menuOpened.value, true);
    assert.deepEqual(f.api.menuActions.value.map(action => action.label), [label, '删除']);
    f.api.chooseMenu('visibility');
    assert.deepEqual(f.events, [['visibility', target]]);
    assert.equal(f.api.menuOpened.value, false);
    f.api.more(); f.api.chooseMenu('remove');
    assert.deepEqual(f.events.at(-1), ['remove']);
  }
  assert.equal(sheets.length, 0);
});

test('bubble selection cannot mutate a replaced, closed, saving or unauthorized meal', context => {
  const props = Vue.reactive({ post: familyPost({ visibility: 'public' }), busy: true });
  const f = harness(context, 'MealPostCard', {}, props);
  f.api.more(); assert.equal(f.api.menuOpened.value, false);
  props.busy = false; f.api.more(); props.busy = true;
  f.api.chooseMenu('visibility'); assert.deepEqual(f.events, []);
  props.busy = false; f.api.more(); props.post = familyPost({ id: 'different-meal' });
  f.api.chooseMenu('remove'); assert.deepEqual(f.events, []);
  props.post.canChangeVisibility = false;
  f.api.more(); f.api.chooseMenu('visibility'); assert.deepEqual(f.events, []);
  assert.deepEqual(f.api.menuActions.value, [{ action: 'remove', label: '删除' }]);
  f.api.more(); f.api.menuOpened.value = false; f.api.chooseMenu('remove');
  assert.deepEqual(f.events, []);
});

test('Discover omits family and personal context markers', () => {
  const source = readFileSync(new URL('../src/components/MealPostCard.vue', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /meal-post-context-badge|mealBadge/);
});

test('meal cards retain recorded dish names when historical meals have no photos', context => {
  const props = Vue.reactive({ post: { images: [], dishes: [{ title: ' 番茄炒蛋 ' }, { title: '清炒时蔬' }, { title: '紫菜汤' }] } });
  const f = harness(context, 'MealPostCard', {}, props);
  assert.deepEqual(f.api.dishNames.value, ['番茄炒蛋', '清炒时蔬', '紫菜汤']);
  props.post = { images: [], dishes: [{ title: '' }, {}] };
  assert.deepEqual(f.api.dishNames.value, []);
  props.post = { images: [] };
  assert.deepEqual(f.api.dishNames.value, []);
});

test('dish thumbnail opens a detail shell and uses its exact meal index; closing ignores late replies', async context => {
  const props = Vue.reactive({ post: familyPost({ kind: 'plan', dishes: [{ recipeId: 'r1', title: '饭', image: '/static/rice.jpg', sourceKind: 'community' }] }) });
  const f = harness(context, 'MealPostCard', {}, props);
  const pending = f.api.openMedia(f.api.media.value[0]);
  assert.equal(f.api.recipeDetail.value.image, props.post.dishes[0].image);
  assert.equal(f.api.openingDish.value, true);
  assert.deepEqual(f.calls[0].args, { postId: 'family-meal', dishIndex: 0 });
  assert.equal(f.calls[0].action, 'mealDishDetail');
  f.api.closeDetail();
  f.calls[0].resolve({ recipe: { id: 'r1', title: '饭', ingredients: [], steps: [] } });
  await pending;
  assert.equal(f.api.recipeDetail.value, null);
});

test('actual photos use the image viewer without making a dish request', async context => {
  const previews = [];
  const f = harness(context, 'MealPostCard', { previewImages: (...args) => previews.push(args) }, { post: familyPost({ kind: 'actual', images: ['photo1', 'photo2'] }) });
  await f.api.openMedia({ isDish: false, image: 'photo2' });
  assert.deepEqual(previews, [[['photo1', 'photo2'], 'photo2']]);
  assert.equal(f.calls.length, 0);
});

test('changing workspace discards an in-flight dish detail response', async context => {
  const f = harness(context, 'MealPostCard', {}, { post: familyPost({ kind: 'plan', dishes: [{ recipeId: 'r1', title: '饭', image: 'cover', sourceKind: 'community' }] }) });
  const pending = f.api.openMedia(f.api.media.value[0]);
  f.modules.cloudStatus.value.familyId = 'another-family';
  await Vue.nextTick();
  f.calls[0].resolve({ recipe: { id: 'r1', title: '饭' } });
  await pending;
  assert.equal(f.api.recipeDetail.value, null);
});


test('missing covers remain noninteractive text while public thumbnails retain their original source indexes', async context => {
  const previews = [];
  const props = { post: familyPost({ kind: 'plan', dishes: [
    { title: '饭', image: '', sourceKind: 'community' }, { recipeId: 'soup', title: '汤', image: 'cloud://soup', sourceKind: 'community' }, { title: '菜', image: '   ', sourceKind: 'custom' },
  ] }) };
  const f = harness(context, 'MealPostCard', { previewImages: (...args) => previews.push(args) }, props);
  assert.deepEqual(f.api.media.value.map(item => item.dishIndex), [1]);
  assert.deepEqual(f.api.dishesWithoutCover.value.map(item => item.dishIndex), [0, 2]);
  for (const item of f.api.dishesWithoutCover.value) await f.api.openMedia(item);
  assert.equal(f.api.recipeDetail.value, null);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(previews, []);
  const opening = f.api.openMedia(f.api.media.value[0]);
  assert.equal(f.api.recipeDetail.value.id, "");
  assert.equal(f.calls[0].args.dishIndex, 1);
  f.calls[0].resolve({ communityPostId: 'public-soup', recipe: { id: 'soup', title: '汤', image: 'cloud://soup' } });
  await opening;
  assert.equal(f.api.recipeDetail.value.title, '汤');
});

test('only confirmed public recipe images open details; custom, actual and unclassified images open the viewer', async context => {
  const previews = [];
  const props = Vue.reactive({ feed: true, post: familyPost({ kind: 'plan', dishes: [
    { recipeId: 'original', title: '家常菜', image: 'cloud://cover', sourceKind: 'community' },
    { recipeId: 'forked', title: '家常菜', image: 'cloud://private-cover', sourceKind: 'custom' },
    { recipeId: 'unknown', title: '家常菜', image: 'cloud://unknown-cover' },
    { recipeId: 'missing', title: '家常菜', image: '', sourceKind: 'custom' },
  ] }) });
  const f = harness(context, 'MealPostCard', { previewImages: (...args) => previews.push(args) }, props);
  assert.equal(f.api.media.value[0].sourceLabel, '美食');
  assert.equal(f.api.media.value[1].sourceLabel, '自建');
  assert.equal(f.api.dishesWithoutCover.value[0].sourceLabel, '自建');
  for (const item of f.api.media.value.slice(1)) await f.api.openMedia(item);
  await f.api.openMedia(f.api.dishesWithoutCover.value[0]);
  assert.equal(f.calls.length, 0);
  assert.equal(f.api.recipeDetail.value, null);
  assert.deepEqual(previews, [
    [['cloud://cover', 'cloud://private-cover', 'cloud://unknown-cover'], 'cloud://private-cover'],
    [['cloud://cover', 'cloud://private-cover', 'cloud://unknown-cover'], 'cloud://unknown-cover'],
  ]);
  const opening = f.api.openMedia(f.api.media.value[0]);
  assert.equal(f.api.recipeDetail.value.id, "");
  assert.deepEqual(f.calls[0].args, { postId: 'family-meal', dishIndex: 0 });
  f.calls[0].resolve({ communityPostId: 'public-original', recipe: { id: 'original', title: '家常菜', image: 'cloud://cover' } });
  await opening;
  props.post = familyPost({ kind: 'actual', images: ['cloud://real-photo'] });
  assert.equal(f.api.media.value[0].sourceLabel, '实拍');
  await f.api.openMedia(f.api.media.value[0]);
  assert.deepEqual(previews.at(-1), [['cloud://real-photo'], 'cloud://real-photo']);
  assert.equal(f.calls.length, 1);
});

test('a stale public badge cannot open details once the same card shows a custom recipe', async context => {
  const previews = [];
  const props = Vue.reactive({ feed: true, post: familyPost({ kind: 'plan', dishes: [{ recipeId: 'r1', title: '汤', image: 'cloud://cover', sourceKind: 'community' }] }) });
  const f = harness(context, 'MealPostCard', { previewImages: (...args) => previews.push(args) }, props);
  const previous = f.api.media.value[0];
  props.post.dishes[0].sourceKind = 'custom';
  await f.api.openMedia(previous);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(previews, [[['cloud://cover'], 'cloud://cover']]);
});

test('changing a recipe classification discards an in-flight public detail response', async context => {
  const props = Vue.reactive({ feed: true, post: familyPost({ kind: 'plan', dishes: [{ recipeId: 'r1', title: '汤', image: 'cloud://cover', sourceKind: 'community' }] }) });
  const f = harness(context, 'MealPostCard', {}, props);
  const opening = f.api.openMedia(f.api.media.value[0]);
  props.post.dishes[0].sourceKind = 'custom';
  f.calls[0].resolve({ recipe: { id: 'r1', title: '汤' } });
  await opening;
  assert.equal(f.api.recipeDetail.value, null);
});

test('text-only dish markup has no button, role, click handler or chevron', () => {
  const { descriptor } = parse(readFileSync(new URL('../src/components/MealPostCard.vue', import.meta.url), 'utf8'));
  const template = descriptor.template.content;
  const row = template.match(/<([\w-]+)\b([^>]*\bclass="meal-post-text-dish"[^>]*)>([\s\S]*?)<\/\1>/);
  assert.ok(row);
  assert.notEqual(row[1], 'button');
  assert.doesNotMatch(row[2], /\brole=|@click|v-on:|hover-class|tabindex/);
  assert.doesNotMatch(row[3], /chevron/);
});


test('shared diary participants use the same direct two-action bubble', context => {
  const sheets = actionSheets(context);
  const f = harness(context, 'MealPostCard', {}, { timeline: true, manageable: true, post: familyPost({ isOwner: false, canDelete: true, canChangeVisibility: true }) });
  assert.equal(f.api.canManage.value, true);
  f.api.more();
  assert.deepEqual(f.api.menuActions.value.map(action => action.label), ['设为公开', '删除']);
  f.api.chooseMenu('visibility');
  assert.deepEqual(f.events, [['visibility', 'public']]);
  f.api.more(); f.api.chooseMenu('remove');
  assert.deepEqual(f.events.at(-1), ['remove']);
  assert.equal(sheets.length, 0);
});

test('discover public post IDs open the shared community detail without requesting a meal snapshot again', async context => {
  const f = harness(context, 'MealPostCard', {}, { post: familyPost({ kind: 'plan', dishes: [{ recipeId: 'recipe', communityPostId: 'public-post', title: '汤', image: 'cover', sourceKind: 'community' }] }) });
  await f.api.openMedia(f.api.media.value[0]);
  assert.equal(f.api.recipeDetail.value.id, 'public-post');
  f.api.closeDetail();
  await f.api.openMedia(f.api.media.value[0]);
  assert.equal(f.api.recipeDetail.value.id, 'public-post');
  assert.equal(f.calls.length, 0);
});

 test('legacy discover opens immediately and reuses its resolved link on the next tap', async context => {
  const props = Vue.reactive({post: familyPost({kind: 'plan', dishes: [{recipeId: 'r1', title: '汤', image: 'cover', sourceKind: 'community'}]})});
  const f = harness(context, 'MealPostCard', {}, props);
  const pending = f.api.openMedia(f.api.media.value[0]);
  assert.equal(f.api.recipeDetail.value.title, '汤');
  assert.equal(f.api.recipeDetail.value.image, 'cover');
  assert.equal(f.api.recipeDetail.value.id, '');
  f.calls[0].resolve({communityPostId: 'public-r1'}); await pending;
  f.api.closeDetail();
  const repeat = f.api.openMedia(f.api.media.value[0]);
  assert.equal(f.api.recipeDetail.value.id, 'public-r1');
  await repeat; assert.equal(f.calls.length, 1);
});


test('single feed photos shrink portrait and landscape previews and reset for another photo', context => {
  const props = Vue.reactive({ feed: true, post: familyPost({ kind: 'actual', images: ['first'] }) });
  const f = harness(context, 'MealPostCard', {}, props);
  assert.equal(f.api.singleImageStyle.value.width, '160px');
  f.api.rememberImageSize('first', { width: 900, height: 1600 });
  assert.equal(f.api.singleImageStyle.value.width, '135px');
  f.api.rememberImageSize('first', { width: 1600, height: 900 });
  assert.equal(f.api.singleImageStyle.value.width, '200px');
  props.post.images = ['second'];
  assert.equal(f.api.singleImageStyle.value.width, '160px');
  props.post.images = ['second', 'third'];
  assert.deepEqual(f.api.singleImageStyle.value, {});
});

test('photo picker starts later selections independently, preserves order and reports one busy interval', async context => {
  const jobs = [];
  let selection = ['a', 'b'];
  const props = { modelValue: [], fallbackImages: [], reservedCount: 6, disabled: false, purpose: 'meal' };
  const { api, events } = harness(context, 'StepImagePicker', {
    useSheetContentResize() {}, imageUploadLabel() {},
    selectImagePaths: async count => selection.slice(0, count),
    persistSelectedImages: (paths, report) => new Promise((resolve, reject) => { jobs.push({ path: paths[0], resolve, reject, report }); }),
  }, props);
  await api.choose();
  assert.deepEqual(jobs.map(job => job.path), ['a', 'b']);
  selection = ['c', 'd'];
  await api.choose();
  assert.deepEqual(jobs.map(job => job.path), ['a', 'b', 'c']);
  assert.equal(api.capacity.value, 0);
  jobs[2].resolve(['cloud-c']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.busy.value, true);
  jobs[1].resolve(['cloud-b']);
  jobs[0].resolve(['cloud-a']);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events.filter(event => event[0] === 'update:modelValue').at(-1)[1], ['cloud-a', 'cloud-b', 'cloud-c']);
  assert.deepEqual(events.filter(event => event[0] === 'busy'), [['busy', true], ['busy', false]]);
});

test('failed photo retry does not duplicate successes or block new selections', async context => {
  const jobs = [];
  let selection = ['a'];
  const { api, events } = harness(context, 'StepImagePicker', {
    useSheetContentResize() {}, imageUploadLabel() {},
    selectImagePaths: async () => selection,
    persistSelectedImages: paths => new Promise((resolve, reject) => jobs.push({ path: paths[0], resolve, reject })),
  }, { modelValue: [], fallbackImages: [], reservedCount: 0, disabled: false });
  await api.choose();
  jobs[0].reject(new Error('network'));
  await new Promise(resolve => setImmediate(resolve));
  selection = ['b'];
  await api.choose();
  await api.choose(true);
  assert.deepEqual(jobs.map(job => job.path), ['a', 'b', 'a']);
  jobs[2].resolve(['cloud-a']); jobs[1].resolve(['cloud-b']);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events.filter(event => event[0] === 'update:modelValue').at(-1)[1], ['cloud-a', 'cloud-b']);
  api.remove(0);
  assert.deepEqual(events.filter(event => event[0] === 'update:modelValue').at(-1)[1], ['cloud-b']);
});


test('personal diary distinguishes original family and personal meals without following current viewing mode', context => {
  for (const [mealContext, mode, expected] of [['family', 'personal', 'family'], ['personal', 'family', 'personal']]) {
    const f = harness(context, 'MealPostCard', {}, { post: { id: mealContext, mealSharingVersion: 2, mealContext, author: { mode }, dishes: [], images: [], visibility: 'public' }, personalDiary: true, timeline: true });
    assert.equal(f.api.origin.value, expected);
  }
  assert.equal(mealOrigin({ author: { mode: 'family' } }), 'family');
  assert.equal(mealOrigin({}), '');
});
