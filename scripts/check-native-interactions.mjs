import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { transformSync } from '@babel/core';
import * as Vue from 'vue';
import solarLunar from 'solarlunar';
import { baseParse } from '@vue/compiler-dom';
import { foodMinutesLabel, mealVoterRows, DEFAULT_SET_COVER, validateImage, stepImages } from '../src/domain/presentation.js';
import { coverFrameStyle } from '../src/domain/image-crop.js';
import { communityPublisherName } from '../src/domain/community-policy.js';
import { foodDetailToolbarOpacity } from '../src/domain/food-detail.js';
import { createMediaCache } from '../src/services/media-cache.js';
import { imageVersion } from '../src/domain/image-variants.js';
import { familyAppearance, familyPublicId } from '../src/domain/family.js';
import { emptySnapshot } from '../src/domain/empty.js';

const directory = resolve(process.argv[2] || 'dist/build/mp-weixin');
const nativeModules = new Map();
function loadFile(filename) {
  if (filename === resolve(directory, 'common/vendor.js')) return Vue;
  if (nativeModules.has(filename)) return nativeModules.get(filename).exports;
  const module = { exports: {} };
  nativeModules.set(filename, module);
  const { code } = transformSync(readFileSync(filename, 'utf8'), { presets: [['@babel/preset-env', { targets: { ie: '11' } }]], babelrc: false, configFile: false });
  runInNewContext(code, { module, exports: module.exports, require: specifier => loadFile(resolve(dirname(filename), specifier)), setTimeout, clearTimeout }, { filename });
  return module.exports;
}
function load(name) { return loadFile(resolve(directory, `services/${name}.js`)); }

const cache = new Map();
const responses = [];
const feedModule = load('community-feed');
const request = query => new Promise(resolve => responses.push({ query, resolve }));
const feed = feedModule.createCommunityFeed({ cache, request });
const query = { type: '全部', category: '全部', search: '' };
const loading = feed.select(query, 'family');
assert.equal(feed.state.value.loading, true);
assert.equal(feed.state.value.ready, false);
assert.equal(responses.length, 1);
responses[0].resolve({ posts: [{ id: 'native-dish' }], cursor: '' });
await loading;
assert.equal(feed.state.value.posts[0].id, 'native-dish');
feed.dispose();
const returning = feedModule.createCommunityFeed({ cache, request });
returning.select(query, 'family');
assert.equal(returning.state.value.posts[0].id, 'native-dish');
assert.equal(responses.length, 1);
const retainedFeed = returning.state.value;
const retainedRevision = feedModule.communityFeedRevision.value;
feedModule.invalidateCommunityFeed({ reset: false });
returning.select(query, 'family', { retain: true });
assert.equal(returning.state.value, retainedFeed);
assert.equal(feedModule.communityFeedRevision.value, retainedRevision);
assert.equal(responses.length, 1, 'returning after a mutation must not reload the native feed');
returning.dispose();

const commands = [];
const initialPreferences = emptySnapshot();
initialPreferences.family.id = 'family';
let shownPreferences;
let preferenceStatus;
let preferenceSequence = 0;
const preferences = load('command-queue').createCommandQueue({
  snapshot: initialPreferences,
  journal: { read: () => [], write() {} },
  newId: () => `native-command-${++preferenceSequence}`,
  send: payload => new Promise((resolve, reject) => commands.push({ payload, resolve, reject })),
  reconcile: async (response, id) => { preferences.receive(response.snapshot, response.revision, id); },
  refresh: async () => {},
  onChange: snapshot => { shownPreferences = snapshot; },
  onStatus: status => { preferenceStatus = status; },
});
preferences.activate(initialPreferences, { scope: 'native:family:guest', familyId: 'family', userId: 'guest', revision: 1 });
const first = preferences.enqueue('setFeature', ['fridge', true]);
const last = preferences.enqueue('setFeature', ['fridge', false]);
const failed = preferences.enqueue('setChef', [true]);
assert.equal(first.accepted, true);
assert.equal(shownPreferences.family.features.fridge, false);
assert.equal(shownPreferences.family.members[0].isChef, true);
assert.equal(commands.length, 1);
commands[0].resolve({ snapshot: { ...initialPreferences, family: { ...initialPreferences.family, features: { ...initialPreferences.family.features, fridge: true } } }, revision: 2 });
await first;
assert.equal(shownPreferences.family.features.fridge, false);
assert.equal(commands.length, 2);
commands[1].resolve({ snapshot: initialPreferences, revision: 3 });
await last;
assert.equal(shownPreferences.family.features.fridge, false);
commands[2].reject(Object.assign(new Error('preference rejected'), { code: 'INVALID' }));
await assert.rejects(failed, /preference rejected/);
assert.equal(shownPreferences.family.members[0].isChef, false);
assert.equal(preferenceStatus.pendingCount, 0);
assert.equal(preferenceStatus.failures.length, 1);
const shareModule = load('prepared-shares');
let shareRequests = 0;
const shareCache = shareModule.createPreparedShares({ request: async () => { shareRequests += 1; return { token: 'a'.repeat(48), expiresAt: Date.now() + 86400000 }; } });
const shareContext = { scope: 'native:family', familyId: 'family', itemId: 'dish', kind: 'dish', fingerprint: 'original' };
const preparation = shareCache.prepare(shareContext);
assert.equal(shareCache.prepare(shareContext), preparation);
await preparation;
assert.equal(shareCache.peek(shareContext).token, 'a'.repeat(48));
assert.equal(shareRequests, 1);
assert.equal(shareCache.peek({ ...shareContext, fingerprint: 'edited' }), null);
const iconAction = readFileSync(resolve(directory, 'components/MenuDetailActions.wxml'), 'utf8');
assert.match(iconAction, /bindtap=/);
assert.match(iconAction, /data-eventsync="true"/);
assert.match(iconAction, /aria-label=/);
const nativeButton = readFileSync(resolve(directory, 'components/NativeShareButton.wxml'), 'utf8');
assert.match(nativeButton, /open-type=/);
assert.match(nativeButton, /data-share-key=/);
const styles = readFileSync(resolve(directory, 'app.wxss'), 'utf8');
assert.doesNotMatch(styles, /\.app-shell\s+(?:to|from)\s*\{/);
let nativeByline;
runInNewContext(readFileSync(resolve(directory, 'components/CommunityByline.js'), 'utf8'), {
  require: specifier => {
    if (specifier === '../common/vendor.js') return { ...Vue, e: (...values) => Object.assign({}, ...values), t: Vue.toDisplayString, p: value => value };
    assert.equal(specifier, '../domain/community-policy.js');
    return { communityPublisherName };
  },
  wx: { createComponent: component => { nativeByline = component; } },
});
const nativeBylineMarkup = readFileSync(resolve(directory, 'components/CommunityByline.wxml'), 'utf8');
const publisherBinding = nativeBylineMarkup.match(/class="community-byline-author"[^>]*aria-label="{{([^}]+)}}"/)?.[1];
assert.ok(publisherBinding);
assert.doesNotMatch(nativeBylineMarkup, /community-byline-count|community-cover-count/);
for (const expanded of [false, true]) {
  const props = Vue.reactive({ post: { author: '很长的真实原作者名称不应被保存成省略文本', importedFamilyCount: 2 }, expanded });
  const renderByline = nativeByline.setup(props);
  const rendered = renderByline();
  assert.equal(rendered[publisherBinding], `发布者：${props.post.author}`);
  props.post = { author: '更新后的作者' };
  assert.equal(renderByline()[publisherBinding], '发布者：更新后的作者');
  props.post = { author: '' };
  assert.ok(!Object.values(renderByline()).some(value => typeof value === 'string' && value));
}
let nativeFamilyCount;
runInNewContext(readFileSync(resolve(directory, 'components/CommunityFamilyCount.js'), 'utf8'), {
  require: specifier => {
    assert.equal(specifier, '../common/vendor.js');
    return { ...Vue, e: (...values) => Object.assign({}, ...values), t: Vue.toDisplayString, p: value => value };
  },
  wx: { createComponent: component => { nativeFamilyCount = component; } },
});
const nativeFamilyCountMarkup = readFileSync(resolve(directory, 'components/CommunityFamilyCount.wxml'), 'utf8');
const householdBinding = nativeFamilyCountMarkup.match(/class="[^"]*community-cover-count[^"]*"[^>]*aria-label="{{([^}]+)}}"/)?.[1];
assert.ok(householdBinding);
const countProps = Vue.reactive({ count: 2, inline: false });
const renderFamilyCount = nativeFamilyCount.setup(countProps);
for (const inline of [false, true]) {
  countProps.inline = inline;
  for (const count of [2, 0, 12345]) {
    countProps.count = count;
    const rendered = renderFamilyCount();
    assert.equal(rendered[householdBinding], `${count} 个家庭在做`);
    assert.ok(Object.values(rendered).some(value => value?.name === (inline ? 'menu' : 'menu-photo') && value.size === 14));
  }
  for (const count of [undefined, null, -1, 1.5, '2', NaN, Infinity]) {
    countProps.count = count;
    assert.equal(renderFamilyCount()[householdBinding], undefined);
  }
}
assert.ok(readFileSync(resolve(directory, 'static/icon-menu-photo.png')).length > 0, 'photo count uses a white native icon with a baked shadow, not a background');
assert.ok(readFileSync(resolve(directory, 'static/icon-clock-inverse.png')).length > 0, 'detail time icon stays legible on the dark label');
const communityMarkup = readFileSync(resolve(directory, 'components/CommunityView.wxml'), 'utf8');
const communityScrollMarkup = communityMarkup.match(/<scroll-view\b[^>]*class="community-feed-scroll"[^>]*>/)?.[0];
assert.ok(communityScrollMarkup, 'the real food feed owns one native refreshable scroll viewport');
for (const property of ['refresher-enabled', 'refresher-triggered', 'refresher-threshold', 'refresher-background', 'scroll-top']) assert.match(communityScrollMarkup, new RegExp(`${property}="\\{\\{[^}]+\\}\\}"`));
for (const event of ['scroll', 'scrolltolower', 'refresherpulling', 'refresherrefresh', 'refresherrestore', 'refresherabort']) assert.match(communityScrollMarkup, new RegExp(`bind${event}="`));
assert.match(communityMarkup, /<view[^>]*slot="refresher"[^>]*class="community-refresher"/);
assert.match(communityMarkup, /<view[^>]*slot="refresher"[^>]*style="\{\{[^}]+\}\}"/);
assert.match(styles, /\.community-refresher\{[^}]*align-items:center;justify-content:center;[^}]*padding:0;transform:translateY\(var\(--community-toolbar-height\)\)/, 'refresh feedback centers below the overlaid filter toolbar');
assert.doesNotMatch(communityMarkup.match(/<scroll-view[^]*?<\/scroll-view>/)?.[0] || '', /<food-detail-sheet\b/);
assert.equal((communityMarkup.match(/<community-byline\b/g) || []).length, 1, 'feed cards retain their compact native byline');
assert.match(communityMarkup, /<community-byline[^>]*class="feed-byline"/);
assert.match(communityMarkup, /<community-family-count\b/);
assert.match(communityMarkup, /class="feed-meta"[^]*?<community-family-count[^>]*class="feed-family-count"/);
const nativeDetailMarkup = readFileSync(resolve(directory, 'components/FoodDetailSheet.wxml'), 'utf8');
const detailMetadataMarkup = nativeDetailMarkup.match(/<view\b[^>]*class="food-detail-attribution(?: [^"]*)?"[^>]*>([^]*?)<\/view>/)?.[1];
assert.ok(detailMetadataMarkup, 'community detail author keeps its own row below the title');
assert.match(detailMetadataMarkup, /<text[^>]*class="food-detail-publisher"/);
assert.doesNotMatch(detailMetadataMarkup, /<community-family-count\b/);
assert.equal((communityMarkup.match(/<community-family-count\b/g) || []).length, 1, 'feed count is not duplicated by a legacy detail footer');
let nativeDetail;
runInNewContext(readFileSync(resolve(directory, 'components/FoodDetailSheet.js'), 'utf8'), {
  require: specifier => {
    if (specifier === '../common/vendor.js') return { ...Vue, e: (...values) => Object.assign({}, ...values), t: Vue.toDisplayString, p: value => value, o: handler => handler };
    assert.equal(specifier, '../domain/food-detail.js');
    return { foodDetailToolbarOpacity };
  },
  wx: { createComponent: component => { nativeDetail = component; } },
});
const detailProps = Vue.reactive({ title: '完整菜品名称', community: false, publisher: '保存的原作者', familyCount: 2, canShare: true, canEdit: true, canRemove: true });
const renderDetail = nativeDetail.setup(detailProps);
const detailContext = { $slots: {}, $feedback() {}, $emit() {} };
const scrollBinding = nativeDetailMarkup.match(/<sheet[^>]*bindscroll="{{(\w+)}}"/)?.[1];
const opacityBinding = nativeDetailMarkup.match(/class="food-detail-toolbar-backdrop" style="{{'opacity:' \+ (\w+)}}"/)?.[1];
const detailPublisherBinding = nativeDetailMarkup.match(/class="food-detail-publisher" aria-label="{{(\w+)}}"/)?.[1];
const detailCoverBinding = nativeDetailMarkup.match(/<recipe-cover[^>]*u-p="{{(\w+)}}"/)?.[1];
assert.ok(scrollBinding && opacityBinding && detailPublisherBinding && detailCoverBinding);
const nativeDetailCover = () => renderDetail(detailContext)[detailCoverBinding];
assert.equal(renderDetail(detailContext)[detailPublisherBinding], undefined, 'non-community entry never shows saved public attribution');
assert.equal(nativeDetailCover()['family-count'], null);
detailProps.community = true;
assert.equal(renderDetail(detailContext)[opacityBinding], 0);
for (const [offset, opacity] of [[30, .25], [60, .5], [120, 1], [900, 1], [60, .5], [0, 0]]) {
  renderDetail(detailContext)[scrollBinding]({ detail: { scrollTop: offset } });
  assert.equal(renderDetail(detailContext)[opacityBinding], opacity, 'compiled native scroll drives the topbar transparency both ways');
}
assert.equal(renderDetail(detailContext)[detailPublisherBinding], '发布者：保存的原作者');
assert.equal(nativeDetailCover()['family-count'], 2, 'community household count is passed to the cover instead of the author row');
for (const count of [0, 2, 999]) {
  detailProps.familyCount = count;
  assert.equal(nativeDetailCover()['family-count'], count);
}
for (const count of [null, undefined, -1, NaN, Infinity, '2']) {
  detailProps.familyCount = count;
  assert.equal(nativeDetailCover()['family-count'], null, 'unknown or invalid family counts are not fabricated as zero');
}
detailProps.familyCount = 2;
detailProps.community = false;
assert.equal(renderDetail(detailContext)[detailPublisherBinding], undefined);
assert.equal(nativeDetailCover()['family-count'], null, 'leaving the community context removes count attribution');
detailProps.community = true;
detailProps.publisher = '';
detailProps.familyCount = null;
assert.equal(renderDetail(detailContext)[detailPublisherBinding], undefined);
assert.ok(!Object.values(renderDetail(detailContext)).some(value => value?.labelled));
assert.doesNotMatch(communityMarkup, /feed-join/);
const feedCoverMarkup = communityMarkup.match(/<button[^>]*class="feed-cover"[^>]*>[^]*?<\/button>/)?.[0];
assert.ok(feedCoverMarkup);
assert.doesNotMatch(feedCoverMarkup, /community-family-count/);
assert.doesNotMatch(communityMarkup, /feed-cover-author|feed-cover-byline|家庭在做/);
assert.doesNotMatch(readFileSync(resolve(directory, 'components/RecipeCover.wxml'), 'utf8'), /recipe-cover-publisher/);
assert.match(readFileSync(resolve(directory, 'components/RecipeCover.wxml'), 'utf8'), /<community-family-count\b/);
assert.match(readFileSync(resolve(directory, 'components/RecipeCover.wxml'), 'utf8'), /class="recipe-cover-meta(?: [^"]*)?"/);
assert.doesNotMatch(readFileSync(resolve(directory, 'components/RecipeCover.wxml'), 'utf8').match(/<community-family-count\b[^>]*>/)[0], /labelled|inline/);
const photoLabelRule = styles.match(/[^{}]*\.feed-cover-category[^{}]*\.recipe-cover-tag[^{}]*\{([^{}]*)\}/)?.[1];
assert.match(photoLabelRule || '', /background:var\(--photo-label-surface\)/);
assert.match(photoLabelRule || '', /color:var\(--white\)/);
assert.match(photoLabelRule || '', /border-radius:999px/);
const photoCountRule = styles.match(/(?:^|})\s*(?:\.app-shell )?\.community-cover-count\{([^}]+)\}/)?.[1];
assert.match(photoCountRule || '', /background:none/);
assert.match(photoCountRule || '', /bottom:var\(--cover-meta-inset,\s*8px\)/);
assert.match(photoCountRule || '', /right:var\(--cover-meta-inset,\s*8px\)/);
assert.match(photoCountRule || '', /pointer-events:none/);
const inlineCountRule = styles.match(/\.community-cover-count\.is-inline\{([^}]+)\}/)?.[1];
assert.match(inlineCountRule || '', /position:static/);
assert.match(inlineCountRule || '', /color:var\(--muted\)/);
const metadataCountRule = [...styles.matchAll(/\.feed-family-count\{([^}]+)\}/g)].at(-1)?.[1];
assert.match(metadataCountRule || '', /flex:0 0 auto/);
assert.match(metadataCountRule || '', /margin-left:auto/);
const detailMetadataRule = styles.match(/\.food-detail-attribution\{([^}]+)\}/)?.[1];
assert.match(detailMetadataRule || '', /display:flex/);
assert.match(detailMetadataRule || '', /align-items:center/);
assert.match(detailMetadataRule || '', /flex-wrap:wrap/);
assert.match(detailMetadataRule || '', /margin-top:4px/);
assert.match(styles, /\.recipe-cover\.is-immersive \.recipe-cover-meta\{[^}]*bottom:calc\(var\(--detail-card-overlap\) \+ 24px\)/, 'cover metadata clears the overlapping body card');
assert.match(styles, /\.recipe-cover-meta \.community-cover-count\{[^}]*position:static;flex:0 0 auto;[^}]*max-width:none;[^}]*margin-left:auto/, 'cover count keeps its intrinsic width instead of shrinking inside the native component host');
assert.match(styles, /\.recipe-cover-meta \.community-cover-count-value\{text-shadow:none\}/);
const avatarHostStyles = styles.match(/\.member-avatar-image\{([^}]+)\}/)?.[1].split(';') || [];
for (const declaration of ['position:absolute', 'top:0', 'right:0', 'bottom:0', 'left:0', 'display:block', 'width:100%', 'height:100%']) assert.ok(avatarHostStyles.includes(declaration), `native avatar host preserves ${declaration}`);
assert.match(styles, /\.member-photo\{[^}]*position:relative/, 'family avatars anchor the same shared photo host');
const avatarProfiles = Vue.ref([
  { id: 'wechat-member', name: '微信昵称', avatar: 'https://example.com/wechat-avatar.png' },
  { id: 'uploaded-member', name: '上传头像', avatar: 'cloud://family/avatar.png' },
  { id: 'anonymous-member', name: '未设置', avatar: '' },
]);
const avatarStore = {
  state: Vue.computed(() => ({ family: { name: '验收家庭', cover: '', headMemberId: 'wechat-member', members: avatarProfiles.value }, orders: [] })),
  activeMember: Vue.computed(() => avatarProfiles.value[0]),
  familyFeatures: Vue.ref({ fridge: false, shopping: false }),
  preferencePending: Vue.ref(false),
};
function avatarComponent(name) {
  let component;
  const modules = {
    '../common/vendor.js': { ...Vue, _export_sfc: (component, properties) => Object.assign(component, Object.fromEntries(properties)), e: (...values) => Object.assign({}, ...values), f: (items, render) => items.map((item, index) => render(item, index, index)), t: Vue.toDisplayString, n: Vue.normalizeClass, s: value => value, p: value => value, o: handler => handler },
    '../domain/presentation.js': { foodMinutesLabel, mealVoterRows },
    '../domain/image-crop.js': { coverFrameStyle },
    '../domain/family.js': { familyAppearance, familyPublicId },
    '../domain/kitchen.js': { localDate: () => '2026-10-27' },
    '../store.js': avatarStore,
    '../services/cloud.js': { cloudMode: false },
  };
  runInNewContext(readFileSync(resolve(directory, `components/${name}.js`), 'utf8'), {
    require: specifier => { assert.ok(modules[specifier], `${name}: expected native dependency ${specifier}`); return modules[specifier]; },
    wx: { createComponent: value => { component = value; } },
  });
  assert.ok(component?.setup, `${name}: native setup is available`);
  const markup = readFileSync(resolve(directory, `components/${name}.wxml`), 'utf8');
  if (name === 'FamilyView') assert.match(markup, /<lazy-image\b[^>]*class="member-avatar-image(?:\s[^"]*)?"/, 'family native avatar host receives the sizing class');
  else {
    assert.doesNotMatch(markup, /<lazy-image\b|dish-avatar/, 'kitchen has no voter avatar renderer or reserved column');
    assert.match(markup, /<food-thumbnail\b[^>]*class="meal-dish-photo"/, 'kitchen keeps the shared food thumbnail');
  }
  return component;
}
function renderedAvatarProps(value) {
  if (!value || typeof value !== 'object') return [];
  if (value.avatar === true && value.round === true && value.variant === 'card') return [value];
  return Object.values(value).flatMap(renderedAvatarProps);
}
const avatarRows = Vue.reactive({ rows: [{ recipe: { id: 'dish', title: '同一道菜', image: '' }, groups: [], chosenBy: avatarProfiles.value.map(member => ({ id: member.id, name: '旧昵称', avatar: 'cloud://old/snapshot.png' })) }], members: avatarProfiles.value, removable: false });
const renderKitchenDishes = avatarComponent('MealDishList').setup(avatarRows);
const kitchenDishMarkup = readFileSync(resolve(directory, 'components/MealDishList.wxml'), 'utf8');
const kitchenDishListKey = kitchenDishMarkup.match(/wx:for="{{(\w+)}}" wx:for-item="item"/)?.[1];
const kitchenVoterCountKey = kitchenDishMarkup.match(/class="dish-voters"[^>]*>{{item\.(\w+)}} 人想吃/)?.[1];
const kitchenOpenHandlerKey = kitchenDishMarkup.match(/class="meal-dish-open"[^>]*bindtap="{{item\.(\w+)}}"/)?.[1];
const kitchenRemoveHandlerKey = kitchenDishMarkup.match(/class="cart-remove"[^>]*bindtap="{{item\.(\w+)}}"/)?.[1];
assert.ok(kitchenDishListKey && kitchenVoterCountKey && kitchenOpenHandlerKey && kitchenRemoveHandlerKey, 'kitchen counts and checkout actions remain inspectable');
const renderFamilyAvatars = avatarComponent('FamilyView').setup({});
for (const avatar of ['https://example.com/wechat-avatar.png', 'cloud://family/updated-avatar.png', '']) {
  avatarProfiles.value[0].avatar = avatar;
  const expected = avatarProfiles.value.map(member => member.avatar);
  const kitchenDishes = renderKitchenDishes({}, []);
  assert.equal(renderedAvatarProps(kitchenDishes).length, 0, 'native kitchen rows omit all voter avatars, including anonymous members');
  assert.equal(kitchenDishes[kitchenDishListKey].length, 1, 'one dish is not duplicated for multiple voters');
  assert.equal(kitchenDishes[kitchenDishListKey][0][kitchenVoterCountKey], String(expected.length), 'hiding avatars does not change the voter count');
  assert.deepEqual(renderedAvatarProps(renderFamilyAvatars({}, [])).map(photo => photo.src), expected, 'native family list retains current avatars and anonymous fallback');
}
avatarRows.removable = true;
const checkoutDishEvents = [];
const checkoutDishes = renderKitchenDishes({ $emit: (...event) => checkoutDishEvents.push(event) }, []);
assert.equal(renderedAvatarProps(checkoutDishes).length, 0, 'checkout removal controls do not become voter avatars');
checkoutDishes[kitchenDishListKey][0][kitchenOpenHandlerKey]();
checkoutDishes[kitchenDishListKey][0][kitchenRemoveHandlerKey]();
assert.deepEqual(checkoutDishEvents, [['open', avatarRows.rows[0].recipe], ['remove', 'dish']], 'checkout still opens the recipe and removes the selected dish');
const kitchenDishRemoveHandlerKey = kitchenDishMarkup.match(/class="meal-dish-remove"[^>]*catchtap="{{item\.(\w+)}}"/)?.[1];
assert.ok(kitchenDishRemoveHandlerKey, 'kitchen dish removal catches its own native tap');
assert.match(kitchenDishMarkup, /class="meal-dish-meta"/);
assert.match(kitchenDishMarkup, /class="meal-dish-duration"/);
avatarRows.removable = false;
avatarRows.editable = true;
const kitchenDishEvents = [];
const editableKitchenDishes = renderKitchenDishes({ $emit: (...event) => kitchenDishEvents.push(event) }, []);
editableKitchenDishes[kitchenDishListKey][0][kitchenDishRemoveHandlerKey]();
assert.deepEqual(kitchenDishEvents, [['remove', 'dish']], 'the native minus removes only the requested dish without opening its recipe');
const avatarMarkup = readFileSync(resolve(directory, 'components/LazyImage.wxml'), 'utf8');
for (const name of ['lazy-avatar-fallback', 'lazy-avatar-head', 'lazy-avatar-shoulders']) assert.match(avatarMarkup, new RegExp(`<view\\b[^>]*class="${name}\\s`), `${name}: anonymous silhouette is native UI, not a network image`);
const avatarSourceKey = avatarMarkup.match(/<image\b[^>]*src="{{(\w+)}}"/)?.[1];
const avatarFallbackKey = avatarMarkup.match(/<view\b[^>]*wx:if="{{(\w+)}}"[^>]*class="lazy-avatar-fallback\s/)?.[1];
assert.ok(avatarSourceKey && avatarFallbackKey, 'native avatar source and anonymous branches are inspectable');
const avatarFailures = Vue.ref({});
const avatarRecovery = Vue.ref(0);
const avatarScopeRevision = Vue.ref(0);
let avatarOffline = false;
let avatarFileCount = 0;
const avatarRequests = [];
const avatarCache = createMediaCache({
  urls: Vue.ref({}),
  fetchImage: async key => { avatarRequests.push(key); if (avatarOffline) throw new Error('offline'); return 'avatar'; },
  writeImage: async () => `/native-avatar-${++avatarFileCount}`,
  removeImage() {},
  onError: (error, key) => { avatarFailures.value[key] = error.message; },
  onSuccess: key => { delete avatarFailures.value[key]; },
});
let nativeAvatarComponent;
let mountAvatar;
let unmountAvatar;
const avatarModules = {
  '../common/vendor.js': { ...Vue, nextTick$1: Vue.nextTick, getCurrentInstance: () => ({ proxy: {} }), onMounted: callback => { mountAvatar = callback; }, onUnmounted: callback => { unmountAvatar = callback; }, index: { createIntersectionObserver() { assert.fail('small member avatars must not wait for native intersection callbacks'); } }, _export_sfc: component => component, e: (...values) => Object.assign({}, ...values), s: value => value, o: handler => handler, t: Vue.toDisplayString },
  '../services/cloud.js': { resolveImage: (fileId, variant, options) => fileId ? avatarCache.resolve(imageVersion(fileId, variant), options) : '', peekImage: (fileId, variant) => fileId ? avatarCache.peek(imageVersion(fileId, variant)) : '', loadImage: (fileId, variant, options) => fileId ? avatarCache.load(imageVersion(fileId, variant), options) : Promise.resolve(''), mediaFailures: avatarFailures, mediaRecovery: avatarRecovery, mediaScopeRevision: avatarScopeRevision },
  '../domain/image-variants.js': { imageVersion },
  '../domain/image-crop.js': { imageFrameStyle: () => ({}) },
  '../composables/useSheetSizing.js': { useSheetContentResize: () => () => {} },
  '../composables/nativeRender.js': { afterNativeRender: Vue.nextTick },
};
const nativeAvatarCode = transformSync(readFileSync(resolve(directory, 'components/LazyImage.js'), 'utf8'), { presets: [['@babel/preset-env', { targets: { ie: '11' } }]], babelrc: false, configFile: false }).code;
runInNewContext(nativeAvatarCode, { require: specifier => { assert.ok(avatarModules[specifier], `avatar dependency: ${specifier}`); return avatarModules[specifier]; }, wx: { createComponent: component => { nativeAvatarComponent = component; } } });
const nativeAvatarScope = Vue.effectScope();
const nativeAvatarProps = Vue.reactive({ src: '', variant: 'card', mode: 'aspectFill', avatar: true, round: true });
const renderNativeAvatar = nativeAvatarScope.run(() => nativeAvatarComponent.setup(nativeAvatarProps));
const settleAvatar = async () => { await Vue.nextTick(); await new Promise(resolve => setImmediate(resolve)); await Vue.nextTick(); };
try {
  mountAvatar();
  await settleAvatar();
  assert.equal(renderNativeAvatar({}, [])[avatarFallbackKey], true, 'missing profiles get the anonymous outline');
  assert.equal(avatarRequests.length, 0);
  for (const source of ['cloud://family/authorized-avatar.png', 'cloud://family/updated-avatar.png']) {
    nativeAvatarProps.src = source;
    assert.equal(renderNativeAvatar({}, [])[avatarFallbackKey], false, 'profile hydration must not be labelled anonymous while loading');
    await settleAvatar();
    assert.equal(renderNativeAvatar({}, [])[avatarSourceKey], `/native-avatar-${avatarFileCount}`);
    assert.equal(renderNativeAvatar({}, [])[avatarFallbackKey], false, 'native load callbacks are not required to uncover cached photos');
  }
  assert.equal(avatarRequests.length, 2, 'each profile photo loads once without scroll callbacks');
  avatarScopeRevision.value += 1;
  await settleAvatar();
  assert.equal(renderNativeAvatar({}, [])[avatarSourceKey], '/native-avatar-2');
  assert.equal(renderNativeAvatar({}, [])[avatarFallbackKey], false);
  avatarOffline = true;
  nativeAvatarProps.src = 'cloud://family/retry-avatar.png';
  await settleAvatar();
  assert.equal(renderNativeAvatar({}, [])[avatarFallbackKey], true, 'unavailable photos fall back without exposing error text in the avatar');
  avatarOffline = false;
  avatarRecovery.value += 1;
  await settleAvatar();
  assert.equal(renderNativeAvatar({}, [])[avatarFallbackKey], false, 'reconnection replaces the fallback with the current member photo');
  assert.equal(renderNativeAvatar({}, [])[avatarSourceKey], '/native-avatar-3');
} finally { unmountAvatar(); nativeAvatarScope.stop(); }
const avatarSheet = readFileSync(resolve(directory, 'components/LazyImage.wxss'), 'utf8');
for (const selector of ['lazy-avatar-head', 'lazy-avatar-shoulders']) {
  const rule = avatarSheet.match(new RegExp(`\\.${selector}[^{}]*\\{([^{}]*)\\}`))?.[1] || '';
  assert.match(rule, /background:transparent/);
  assert.match(rule, /border:1\.25px solid currentColor/);
}
assert.match(avatarSheet, /border-bottom:0/);
const menuMarkup = readFileSync(resolve(directory, 'components/HomeMenu.wxml'), 'utf8');
const kitchenMarkup = readFileSync(resolve(directory, 'pages/index/index.wxml'), 'utf8');
const kitchenScript = readFileSync(resolve(directory, 'pages/index/index.js'), 'utf8');
const kitchenNodes = [];
function collectKitchenNodes(node) { if (node.type === 1) { kitchenNodes.push(node); node.children.forEach(collectKitchenNodes); } }
baseParse(kitchenMarkup).children.forEach(collectKitchenNodes);
const kitchenCard = kitchenNodes.find(node => node.props.some(prop => prop.name === 'class' && prop.value?.content.includes("'order-card'")));
const kitchenCardHost = kitchenNodes.find(node => node.props.some(prop => prop.name === 'class' && prop.value?.content === 'kitchen-order'));
const kitchenCardKey = kitchenCardHost?.props.find(prop => prop.name === 'wx:key')?.value?.content;
assert.ok(kitchenCardKey, 'native kitchen cards retain an explicit keyed identity');
assert.ok(kitchenCardHost.props.some(prop => prop.name === 'id'), 'the stationary wrapper keeps the order scroll anchor');
assert.match(kitchenScript, new RegExp(`\\b${kitchenCardKey}:(\\w+)\\.id\\+":"\\+\\1\\.status`), 'native card identity includes status so cancellation cannot reuse the old unmuted view after sorting');
const orderMenuMarkup = readFileSync(resolve(directory, 'components/OrderActionMenu.wxml'), 'utf8');
const orderMenuStyles = readFileSync(resolve(directory, 'components/OrderActionMenu.wxss'), 'utf8');
assert.match(kitchenCard.loc.source, /<order-action-menu\b[^>]*bindactivate=[^>]*bindclose=[^>]*bindcancel=[^>]*bindrestore=[^>]*bindremove=/, 'each order provides guarded cancel, restore and delete callbacks from its heading');
assert.match(kitchenScript, /status:(\w+)\.status,opened:[^,]+===\1\.id,busy:/, 'native component props include the current status and controlled open state');
assert.doesNotMatch(kitchenCardHost.loc.source, /order-swipe|bindtouchstart|bindtouchmove|bindlongpress/);
assert.doesNotMatch(orderMenuMarkup, /\bwxs\b|bindlongpress|bindtouchstart|bindtouchend/);
assert.match(orderMenuMarkup, /<button\b[^>]*order-more-button[^>]*aria-haspopup="menu"[^>]*disabled="\{\{[^}]+\}\}"[^>]*catchtap=/);
assert.match(orderMenuMarkup, /<root-portal\b/);
assert.match(orderMenuMarkup, /'app-shell', 'order-menu-root'/);
assert.match(orderMenuMarkup, /is-floating-menu/);
assert.match(orderMenuMarkup, /order-menu-pointer/);
assert.match(orderMenuMarkup, /<button\b[^>]*role="menuitem"[^>]*disabled="\{\{[^}]+\}\}"[^>]*catchtap=/);
const menuIconMarkup = orderMenuMarkup.match(/<app-icon\b[^>]*class="order-menu-icon\b[^"]*"[^>]*\/>(?=\s*<text\b)/)?.[0];
assert.ok(menuIconMarkup, 'native menu icons precede their labels');
assert.doesNotMatch(menuIconMarkup, /\b(?:bind|catch)(?:tap|click)=/, 'native menu icons do not add separate action handlers');
for (const icon of ['cancel', 'restore', 'edit', 'trash-danger']) assert.ok(existsSync(resolve(directory, `static/icon-${icon}.png`)), `native ${icon} menu icon is packaged`);
assert.match(orderMenuMarkup, /order-menu-backdrop[^>]*catchtap=/);
assert.match(kitchenCard.loc.source, /class="order-schedule"[^>]*>[\s\S]*?order-date-tag[\s\S]*?order-meal-tag[\s\S]*?order-status[\s\S]*?<\/view>/);
const kitchenFooter = kitchenNodes.find(node => node.props.some(prop => prop.name === 'class' && prop.value?.content === 'order-actions'));
const footerChildren = kitchenFooter.children.filter(node => node.type === 1);
assert.match(footerChildren[0].loc.source, /^<button\b[^>]*class="text-button order-add-button"[^>]*disabled=[^>]*bindtap=/, 'add dishes is the first action in the same footer');
assert.match(footerChildren[1].loc.source, /^<view\b[^>]*class="order-progress-actions"/);
for (const label of ['备菜', '开饭']) {
  const button = footerChildren[1].children.find(node => node.tag === 'button' && node.loc.source.includes(label === '备菜' ? '>备菜 ' : `>${label}</text>`));
  assert.ok(button, `native ${label} keeps a visible text label`);
  assert.match(button.loc.source, /<app-icon\b/, `native ${label} includes its icon`);
  assert.match(button.loc.source, /disabled="\{\{[^}]+\}\}"/);
}
assert.match(kitchenScript, /name:"chef",active:[^,]+,size:16/);
assert.match(kitchenScript, /name:"menu-inverse",size:16/);
assert.doesNotMatch(kitchenCard.loc.source, /class="order-tools"/);
assert.match(styles, /\.order-date-tag\{background:var\(--green-light\);color:var\(--green\)/);
assert.match(styles, /\.order-meal-tag\{background:var\(--meal-light\);color:var\(--meal\)/);
console.log('微信厨房底栏检查通过：左侧加菜与右侧带图标的备菜进度、开饭同栏，日期与餐次固定独立配色。');
assert.doesNotMatch(kitchenCard.loc.source, /取消这一餐/, 'cancel is no longer duplicated in the card footer');
assert.match(orderMenuStyles, /\.order-more-button[^{}]*\{[^}]*width:44px;height:44px;min-width:44px;min-height:44px/);
assert.match(orderMenuStyles, /\.app-shell\.order-menu-root[^{}]*\{[^}]*position:fixed;[^}]*z-index:90/);
assert.match(orderMenuStyles, /\.order-menu-item[^{}]*\{[^}]*min-height:44px/);
assert.match(orderMenuStyles, /\.order-menu-item[^{}]*\{[^}]*justify-content:flex-start;gap:10px/);
assert.match(orderMenuStyles, /\.order-menu-icon[^{}]*\{[^}]*flex:0 0 18px;[^}]*pointer-events:none/);
assert.match(orderMenuStyles, /prefers-reduced-motion/);
assert.match(styles, /\.order-tag\{[^}]*min-height:24px;padding:3px 8px;border-radius:var\(--radius-small\);font-size:var\(--type-caption\)/);
console.log('微信餐单气泡菜单检查通过：左侧统一小标签、右侧三个点、原生顶层尖角气泡、独立操作按钮，无厨房左滑手势。');
assert.match(styles, /\.order-card\.is-finished\{[^}]*background:var\(--paper\)/, 'completed and cancelled cards share the muted background');
assert.match(kitchenCard.loc.source, /is-finished/);
assert.doesNotMatch(kitchenCard.loc.source, /is-focused/);
assert.doesNotMatch(styles, /\.order-card\.is-focused/);
assert.match(styles, /\.order-card\.is-finished\{[^}]*isolation:isolate/);
const finishedVeil = styles.match(/\.order-card\.is-finished::?after\{([^}]+)\}/)?.[1] || '';
assert.match(finishedVeil, /position:absolute;top:0;right:0;bottom:0;left:0;/);
assert.match(finishedVeil, /z-index:1;border-radius:inherit;background:var\(--paper\);opacity:\.4;pointer-events:none/);
assert.doesNotMatch(styles, /\.order-card\.is-finished\s+\.(?:order-tag|order-status|dish-set-tags|meal-dish-photo|dish-avatar)/);
assert.match(styles, /\.order-status\.completed\{[^}]*background:var\(--success-light\);[^}]*color:var\(--success\)/);
assert.match(styles, /\.order-status\.cancelled\{[^}]*background:var\(--danger-light\);[^}]*color:var\(--danger\)/);
console.log('微信厨房状态检查通过：开饭与取消后整卡叠加浅灰蒙层，保留标签色彩、菜品图片原色及详情点击；无持续高亮边框。');
const menuNodes = [];
function collectMenuNodes(node) { if (node.type === 1) { menuNodes.push(node); node.children.forEach(collectMenuNodes); } }
baseParse(menuMarkup).children.forEach(collectMenuNodes);
const menuStyles = readFileSync(resolve(directory, 'components/HomeMenu.wxss'), 'utf8');
assert.doesNotMatch(styles, /\.home-menu-panel\.is-orders|--home-menu-tabs-height/, 'split navigation removes the old sticky mode bar and its reserved height');
assert.match(menuStyles, /\.home-menu-tools[^{}]*\{[^}]*position:\s*relative/);
assert.match(menuStyles, /\.home-menu-layout[^{}]*\{[^}]*height:var\(--home-menu-viewport-height\)/, 'the dish workspace owns the full available viewport');
assert.match(menuStyles, /\.home-menu-rail[^{}]*\{[^}]*height:var\(--home-menu-rail-height\)/, 'the category rail keeps its own bounded height');
assert.doesNotMatch(menuStyles, /\.home-menu-rail[^{}]*\{[^}]*position:sticky/, 'the category rail cannot float below the right list');
assert.doesNotMatch(menuStyles, /\.home-menu-layout[^{}]*::before/);
const railScrollers = menuNodes.filter(node => node.tag === 'scroll-view');
assert.equal(railScrollers.length, 2, 'both columns use bounded native scrollers after the page reaches its natural bottom');
for (const name of ['scroll-y', 'enhanced', 'bounces', 'scroll-into-view']) assert.ok(railScrollers[0].props.some(prop => prop.name === name), `category rail retains ${name}`);
const categoryRail = menuNodes.find(node => node.tag === 'view' && node.props.some(prop => prop.name === 'class' && /^home-menu-rail\s/.test(prop.value?.content || '')));
assert.ok(categoryRail?.props.some(prop => prop.name === 'bindtouchmove' && prop.value?.content === '{{railGesture.contain}}'), 'category gestures stop synchronously in the native view layer');
assert.match(menuMarkup, /<wxs module="railGesture">[\s\S]*?function route\(event, owner, kind\)[\s\S]*?return false/, 'column boundaries prevent default scrolling in the native view');
assert.ok(railScrollers[0].props.some(prop => prop.name === 'bindscroll' && prop.value?.content === '{{railGesture.scroll}}'), 'category boundary state stays in the native view layer');
assert.match(menuStyles, /--home-menu-rail-height:\s*max\(48px,\s*min\(var\(--home-menu-rail-content-height\),\s*calc\(100vh - var\(--home-menu-list-top\) - var\(--home-menu-bottom-inset\)\)\)\)/, 'only the category rail is capped by its content height');
assert.match(menuStyles, /--home-menu-viewport-height:\s*max\(var\(--home-menu-rail-height\),\s*calc\(100vh - var\(--home-menu-origin-top,\s*100vh\) - var\(--home-menu-bottom-inset\)\)\)/, 'the dish list fills remaining space below short category rails without forcing extra outer scrolling');
for (const name of ['scroll-y', 'enhanced', 'bounces', 'scroll-top']) assert.ok(railScrollers[1].props.some(prop => prop.name === name), `right list retains ${name}`);
assert.ok(railScrollers[1].props.some(prop => prop.name === 'bindscroll' && prop.value?.content === '{{railGesture.listScroll}}'), 'right list scroll updates category tracking through WXS');
assert.match(menuMarkup, /owner.callMethod\('scrollPage'/, 'pulling down at the list top can return to the family cover');
for (const name of ['home-menu-category', 'home-menu-add', 'search-clear']) {
  const button = menuNodes.find(node => node.tag === 'button' && node.props.some(prop => prop.name === 'class' && prop.value?.content.includes(name)));
  assert.ok(button, `${name}: native button is present`);
  assert.ok(button.props.some(prop => ['bindtap', 'catchtap'].includes(prop.name)), `${name}: uses native tap`);
  if (name === 'home-menu-category') assert.ok(button.props.some(prop => prop.name === 'bindtap' && prop.value?.content === '{{railGesture.tap}}'), 'category taps ignore completed drags in the native view layer');
  else assert.ok(button.props.some(prop => prop.name === 'data-eventsync' && prop.value.content === 'true'), `${name}: dispatches synchronously`);
}
for (const markup of [menuMarkup, communityMarkup]) {
  for (const name of ['search-leading-icon', 'search-input-slot', 'search-clear-slot']) {
    assert.match(markup, new RegExp(`<view\\b[^>]*class="${name}[\\s"]`), `${name}: search geometry is owned by native views`);
  }
  assert.match(markup, /换一换试试/, 'empty searches keep the compact recovery hint');
}
assert.doesNotMatch(menuMarkup, /home-menu-search-count|home-menu-empty-action/, 'menu results do not retain a count or duplicate clear action');
assert.doesNotMatch(communityMarkup, /查看全部/, 'empty food searches cannot switch to a removed category');
const swipeMarkup = readFileSync(resolve(directory, 'components/MenuSwipeRow.wxml'), 'utf8');
const swipeNodes = [];
function collectSwipeNodes(node) { if (node.type === 1) { swipeNodes.push(node); node.children.forEach(collectSwipeNodes); } }
baseParse(swipeMarkup.replace(/<wxs[\s\S]*?<\/wxs>/g, '')).children.forEach(collectSwipeNodes);
const swipeRoot = swipeNodes.find(node => node.props.some(prop => prop.name === 'class' && /(?:^|['\s])menu-swipe(?:['\s]|$)/.test(prop.value?.content || '')));
assert.ok(swipeRoot, 'the swipe container exists in the native output');
assert.ok(swipeRoot.props.some(prop => prop.name === 'prop'), 'swipe state is bound on the native view');
assert.ok(swipeRoot.props.some(prop => prop.name === 'change:prop' && prop.value?.content === '{{swipe.sync}}'), 'the native view observes the supported prop binding');
assert.doesNotMatch(swipeMarkup, /change:swipe-state|\[menu-swipe-sync\]/);
for (const name of ['home-menu-photo-slot', 'home-menu-info-slot', 'home-menu-pick-slot']) {
  const owner = swipeNodes.find(node => node.props.some(prop => prop.name === 'class' && prop.value?.content.includes(name)));
  assert.ok(owner.props.some(prop => prop.name === 'bindtap' && prop.value.content === '{{swipe.tap}}'), `${name}: tap is guarded in WXS`);
  const button = owner.children.find(node => node.tag === 'button');
  assert.ok(button, `${name}: retains a semantic native button`);
  assert.ok(button.props.some(prop => prop.name === 'data-eventsync' && prop.value.content === 'true'));
}
for (const name of ['menu-swipe-edit', 'menu-swipe-delete']) {
  const button = swipeNodes.find(node => node.tag === 'button' && node.props.some(prop => prop.name === 'class' && prop.value?.content.includes(name)));
  assert.ok(button.props.some(prop => prop.name === 'catchtap'), `${name}: only the intended action executes`);
  assert.ok(button.props.some(prop => prop.name === 'disabled'));
}
assert.match(swipeMarkup, /bindtouchmove="\{\{swipe.move\}\}"/);
assert.doesNotMatch(swipeMarkup, /catchtouchmove=/);
const compiledWxs = swipeMarkup.match(/<wxs[^>]*>([\s\S]*?)<\/wxs>/)[1];
let compiledRow;
runInNewContext(readFileSync(resolve(directory, 'components/MenuSwipeRow.js'), 'utf8'), {
  require: name => { if (name === '../domain/presentation.js') return { foodMinutesLabel }; assert.equal(name, '../common/vendor.js'); return { ...Vue, e: (...values) => Object.assign({}, ...values), t: Vue.toDisplayString, p: value => value, o: handler => handler, _export_sfc: (component, properties) => Object.assign(component, Object.fromEntries(properties)) }; },
  wx: { createComponent: component => { compiledRow = component; } },
});
assert.ok(compiledRow.methods?.dispatchAction, 'WXS business callbacks are exposed as native component methods');
const nativeCategory = swipeNodes.find(node => node.props.some(prop => prop.name === 'class' && prop.value?.content.includes('home-menu-item-category')));
const nativeMetadata = swipeNodes.find(node => node.props.some(prop => prop.name === 'class' && prop.value?.content.includes('home-menu-secondary-meta')));
assert.ok(nativeCategory && nativeMetadata, 'native menu rows include a category and secondary metadata');
const categoryField = nativeCategory.children.find(node => node.type === 5).content.content;
const metadataCondition = nativeMetadata.props.find(prop => prop.name === 'wx:if').value.content.slice(2, -2);
const metadataTextField = nativeMetadata.children.find(node => node.tag === 'text').children.find(node => node.type === 5).content.content;
const metadataIconField = nativeMetadata.children.find(node => node.tag === 'app-icon').props.find(prop => prop.name === 'u-p').value.content.slice(2, -2);
for (const [entry, category, expected, icon] of [
  [{ kind: 'dish', category: '荤菜', minutes: 25, meta: '' }, '荤菜', '25 分钟', 'clock'],
  [{ kind: 'dish', category: '主食', minutes: null, meta: 'undefined 分钟' }, '主食', '', 'clock'],
  [{ kind: 'dish', category: '素菜' }, '素菜', '', 'clock'],
  [{ kind: 'set', recipes: [{ id: 'first' }, { id: 'second' }, { id: 'third' }], meta: '' }, '套餐', '3 道菜', 'menu'],
  [{ kind: 'set', recipes: [{ id: 'first' }], recipeIds: ['first', 'removed'] }, '套餐', '1 道菜', 'menu'],
]) {
  const props = { entry, busy: false, selected: false, opened: false };
  const computed = Object.fromEntries(Object.entries(compiledRow.computed).map(([name, getter]) => [name, getter.call(props)]));
  const rendered = compiledRow.render({}, [], props, {}, {}, { ...compiledRow.methods, ...computed });
  assert.equal(rendered[categoryField], category, 'native rendering always retains the category');
  assert.equal(Boolean(rendered[metadataCondition]), Boolean(expected), 'native metadata visibility follows the actual duration or dish count');
  if (expected) {
    assert.equal(rendered[metadataTextField], expected, 'native menu metadata shows the current cooking time or set count');
    assert.equal(rendered[metadataIconField].name, icon, 'native menu metadata uses the appropriate icon');
    assert.equal(rendered[metadataIconField].size, 12);
  }
}
const gestureModule = { exports: {} };
runInNewContext(compiledWxs, { module: gestureModule, Math });
const gesture = gestureModule.exports;
const gestureState = {};
const gestures = [];
const rowContext = { busy: false, opened: false, entry: { id: 'native-dish', key: 'native-dish' }, $emit: (name, payload) => gestures.push({ name, payload }) };
const owner = { getState: () => gestureState, selectComponent: () => ({ setStyle() {} }), callMethod: (name, payload) => compiledRow.methods[name].call(rowContext, payload) };
gesture.sync(0, null, owner);
const nativeTouch = (horizontal, timeStamp) => ({ timeStamp, touches: [{ pageX: horizontal, pageY: 100 }], changedTouches: [{ pageX: horizontal, pageY: 100 }] });
gesture.start(nativeTouch(200, 0), owner);
gesture.end(nativeTouch(200, 50), owner);
gesture.tap({ currentTarget: { dataset: { action: 'open' } } }, owner);
assert.equal(gestures.at(-1).name, 'open', 'the compiled WXS tap opens details on the first tap');
assert.equal(gestures.at(-1).payload.id, 'native-dish');
gestures.length = 0;
gesture.start(nativeTouch(200, 100), owner);
gesture.move(nativeTouch(70, 200), owner);
gesture.end(nativeTouch(70, 350), owner);
gesture.tap({ currentTarget: { dataset: { action: 'toggle' } } }, owner);
assert.equal(gestureState.open, true);
assert.ok(!gestures.some(event => ['open', 'toggle'].includes(event.name)), 'a swipe never selects a dish or opens details');
gestures.length = 0;
rowContext.opened = true;
compiledRow.methods.dispatchAction.call(rowContext, { action: 'share' });
assert.deepEqual(gestures.map(event => event.name), ['share'], 'native sharing does not close its source row');
rowContext.busy = true;
rowContext.sharing = true;
assert.equal(compiledRow.computed.swipeState.call(rowContext), 3);
gesture.sync(3, 1, owner);
assert.equal(gestureState.offset, -180, 'pending share preparation preserves the visible row translation');
assert.equal(gestureState.disabled, true);
gesture.tap({ currentTarget: { dataset: { action: 'open' } } }, owner);
assert.equal(gestures.length, 1, 'share preparation prevents duplicate actions');
rowContext.busy = false;
gesture.sync(1, 3, owner);
assert.equal(gestureState.offset, -180);
assert.equal(gestureState.disabled, false);
gesture.sync(0, 1, owner);
assert.equal(gestureState.offset, 0, 'opening an editor or sheet resets the native row offset');
assert.equal(gestureState.open, false);
const swipeStyles = readFileSync(resolve(directory, 'components/MenuSwipeRow.wxss'), 'utf8');
assert.match(swipeStyles, /width:60px;height:100%;min-width:44px;min-height:44px;padding:0;border-radius:0/, 'menu swipe actions restore full-height rectangular native tap targets');
assert.match(swipeStyles, /\.menu-swipe-actions[^{}]*\{[^}]*align-items:stretch;width:180px;padding:0/);
assert.doesNotMatch(swipeStyles, /--food-photo-radius\s*:/, 'menu photos and their loading layers inherit the same corner token as kitchen thumbnails');
for (const selector of ['menu-swipe-surface', 'menu-swipe-actions', 'home-menu-item-category']) {
  assert.match(swipeStyles, new RegExp(`\\.${selector}[^{}]*\\{[^}]*border-radius:0(?:;|\\})`), `native ${selector} keeps square corners`);
}
assert.match(swipeStyles, /\.menu-swipe-surface[^{}]*\{[^}]*background:var\(--white\)/, 'the native menu surface remains white when revealing actions');
assert.doesNotMatch(swipeStyles, /\.menu-swipe\.is-open[^{}]*\.menu-swipe-surface[^{}]*\{[^}]*background/, 'opening menu actions does not add a selected background');
assert.doesNotMatch(styles, /--swipe-action-size/, 'the unused circle diameter token is retired');
assert.match(swipeMarkup, /menu-swipe-edit[\s\S]*?<text[^>]*>编辑<\/text>/);
assert.match(swipeMarkup, /menu-swipe-share[\s\S]*?<text[^>]*>分享<\/text>/);
assert.ok(swipeMarkup.indexOf('menu-swipe-edit') < swipeMarkup.indexOf('menu-swipe-share') && swipeMarkup.indexOf('menu-swipe-share') < swipeMarkup.indexOf('menu-swipe-delete'));
assert.match(swipeMarkup, /menu-swipe-delete[\s\S]*?<text[^>]*>删除<\/text>/);
const detailActionStyles = readFileSync(resolve(directory, 'components/MenuDetailActions.wxss'), 'utf8');
assert.equal((iconAction.match(/recipe-detail-button/g) || []).length, 1, 'the title row owns one selection action while sharing lives in the cover toolbar');
assert.match(styles, /\.food-detail-primary \.menu-detail-order\{[^}]*min-height:44px;[^}]*background:transparent/);
assert.match(styles, /\.detail-choice-surface\{[^}]*min-height:var\(--detail-action-height\);[^}]*border-radius:999px;[^}]*background:var\(--green\)/);
assert.match(styles, /\.recipe-detail-button\{[^}]*background:var\(--white\)/, 'native detail actions retain a white outlined surface');
assert.match(styles, /\.recipe-detail-button\.is-complete\{[^}]*background:var\(--white\)/, 'completed actions keep the same surface');
assert.match(iconAction, /is-complete/, 'selected actions use the common completed state');
assert.match(readFileSync(resolve(directory, 'components/FriendForwardButton.wxml'), 'utf8'), /分享/);
assert.doesNotMatch(detailActionStyles, /\[disabled\]/, 'native component state styles use supported class selectors');
assert.match(readFileSync(resolve(directory, 'components/AppIcon.wxml'), 'utf8'), /style="\{\{/, 'native icon size is applied on the image rather than across component style boundaries');
assert.match(readFileSync(resolve(directory, 'components/RecipeEditor.js'), 'utf8'), /name:"trash-danger",size:20/, 'step deletion uses a red native icon with an explicit size');
assert.match(readFileSync(resolve(directory, 'components/StepImagePicker.js'), 'utf8'), /variant:"card",mode:"aspectFill"/, 'editor attachments load compact thumbnails rather than full detail images');
for (const name of ['ImagePicker', 'StepImagePicker', 'ProfileFields']) {
  const registration = JSON.parse(readFileSync(resolve(directory, `components/${name}.json`), 'utf8'));
  assert.equal(registration.usingComponents['image-upload-progress'], './ImageUploadProgress', `${name} uses the shared native upload overlay`);
  const template = readFileSync(resolve(directory, `components/${name}.wxml`), 'utf8');
  assert.match(template, /<image-upload-progress wx:if=/, `${name} only displays progress while a photo is pending`);
  assert.doesNotMatch(template, /调整展示位置|移除图片|photo-count|photo-processing-grid|已上传/, `${name} has no external upload controls or status prose`);
}
const uploadProgressTemplate = readFileSync(resolve(directory, 'components/ImageUploadProgress.wxml'), 'utf8');
assert.match(uploadProgressTemplate, /role="progressbar"[^>]*aria-valuenow="\{\{/, 'native upload progress retains an accessible numeric value');
assert.match(uploadProgressTemplate, /<text[^>]*>\{\{\w+\}\}<\/text>/, 'the native overlay renders only the percentage');
const uploadProgressStyles = readFileSync(resolve(directory, 'components/ImageUploadProgress.wxss'), 'utf8');
assert.match(uploadProgressStyles, /\.image-upload-progress[^}]*position:absolute;top:0;right:0;bottom:0;left:0/, 'progress stays within its image rather than below it');
assert.match(uploadProgressStyles, /\.image-upload-progress[^}]*align-items:flex-end;justify-content:flex-end/, 'large upload frames place progress at bottom-right');
assert.match(uploadProgressStyles, /\.image-upload-progress\.is-compact[^}]*align-items:center;justify-content:center/, 'small upload frames center progress');
assert.match(uploadProgressStyles, /pointer-events:none/, 'upload progress never intercepts taps');
const purchaseTemplate = readFileSync(resolve(directory, 'components/StockEditor.wxml'), 'utf8');
const purchaseScript = readFileSync(resolve(directory, 'components/StockEditor.js'), 'utf8');
assert.equal((purchaseTemplate.match(/<image-picker\b/g) || []).length, 1, 'purchase and inventory reuse one native image picker');
assert.match(purchaseScript, /frame:"recipe",label:"拍照或上传食材图片"/, 'purchase photos use the shared golden-ratio cover frame');
assert.match(purchaseScript, /title:\w+\.purchase\?\w+\.value\.name\|\|"确认采购":"记录食材"/, 'the native purchase title is the ingredient name');
assert.doesNotMatch(purchaseScript, /compact:|preferredHeight:/, 'native component props do not restore the compact frame or fixed height');
assert.doesNotMatch(purchaseTemplate, /<image-picker\b[^>]*compact=|purchase-summary|preferred-height=/, 'purchase photos are full-width and the sheet follows its content height');
assert.match(purchaseTemplate, /class="image-picker stock-cover-fallback[^"]*"/, 'fridge-off purchases retain a non-interactive cover');
assert.match(purchaseTemplate, /<view class="image-upload(?: data-v-[\da-f]+)?"[^>]*style="\{\{/, 'the static cover uses the same native ratio placeholder');
assert.match(styles, /\.image-upload\{[^}]*width:100%/, 'native purchase photos fill the shared content width');
assert.doesNotMatch(styles, /\.purchase-summary/, 'the old 60px purchase row cannot constrain the cover');
assert.match(styles, /\.compact-image-picker \.upload-caption\{[^}]*top:50%;left:50%;right:auto;bottom:auto;transform:translate\(-50%,-50%\);width:28px;height:28px;min-height:28px/, 'small uploader variants retain their centered camera');
console.log('微信采购图片检查通过：全宽黄金比例大图、右下角百分比、内容自适应弹窗；保留冰箱开关、上传锁定和失败反馈。');
const stockFooter = purchaseTemplate.match(/<view slot="footer">([\s\S]*)<\/view><\/sheet>/)?.[1];
assert.ok(stockFooter, 'stock save controls stay in the fixed sheet footer');
assert.match(stockFooter, /<text wx:if="\{\{\w+\}\}" class="error-message stock-save-error[^\"]*" role="alert"/, 'stock server errors remain visible above the save button');
assert.ok(stockFooter.indexOf('role="alert"') < stockFooter.indexOf('<button'), 'stock errors precede the confirmation action');
for (const field of ['name', 'quantity']) {
  assert.match(purchaseScript, new RegExp(`"error-id":"stock-${field}-error"`), `${field} forwards its error description to the native input`);
}
assert.match(purchaseScript, /ingredientFieldErrors/, 'stock validates with the shared ingredient rules before saving');
const stockStyles = readFileSync(resolve(directory, 'components/StockEditor.wxss'), 'utf8');
assert.match(stockStyles, /\.stock-save-error[^}]*margin:0 0 10px/, 'stock error feedback keeps spacing from the save button');
const stockFieldTemplate = readFileSync(resolve(directory, 'components/FormField.wxml'), 'utf8');
assert.match(stockFieldTemplate, /<text wx:if="\{\{\w+\}\}" id="\{\{\w+\}\}" class="field-error" role="alert"/, 'the shared field owns error text immediately beneath its native control');
for (const tag of ['input', 'textarea']) {
  assert.match(stockFieldTemplate, new RegExp(`<${tag}\\b[^>]*aria-invalid="\\{\\{\\w+\\}\\}"[^>]*aria-describedby="\\{\\{\\w+\\}\\}"`), `${tag} exposes its validation state and inline explanation`);
}
console.log('微信食材校验检查通过：共享数量规则、字段下方原生错误关联；仅网络失败提示留在保存按钮旁。');
const nativePrep = readFileSync(resolve(directory, 'components/MealPreparationSheet.wxml'), 'utf8');
const nativeReady = readFileSync(resolve(directory, 'components/DishReadyButton.wxml'), 'utf8');
const nativeShopping = readFileSync(resolve(directory, 'components/ShoppingView.wxml'), 'utf8');
const nativePrepEditor = readFileSync(resolve(directory, 'components/DishPreparationEditor.wxml'), 'utf8');
const nativePrepEditorScript = readFileSync(resolve(directory, 'components/DishPreparationEditor.js'), 'utf8');
assert.match(nativeReady, /role="button"[^>]*aria-pressed="\{\{\w+\}\}"[^>]*aria-label="\{\{\w+\}\}"/);
assert.match(nativeReady, /<app-icon\b[^>]*\/>\s*<text\b/, 'ready controls have a leading icon and visible text');
assert.doesNotMatch(nativeReady, /dish-ready-face|role="checkbox"/);
assert.match(nativeReady, /secondary-button/);
const nativeReadyScript = readFileSync(resolve(directory, 'components/DishReadyButton.js'), 'utf8');
const readyTextBinding = nativeReady.match(/<text\b[^>]*>{{(\w+)}}<\/text>/)?.[1];
const readyPressedBinding = nativeReady.match(/aria-pressed="{{(\w+)}}"/)?.[1];
assert.ok(readyTextBinding && readyPressedBinding, 'ready text and pressed state both use reactive native bindings');
let nativeReadyComponent;
runInNewContext(nativeReadyScript, {
  require: specifier => {
    assert.equal(specifier, '../common/vendor.js');
    return { ...Vue, _export_sfc: (component, properties) => Object.assign(component, Object.fromEntries(properties)), t: Vue.toDisplayString, p: value => value, o: handler => handler };
  },
  wx: { createComponent: component => { nativeReadyComponent = component; } },
});
const readyProps = Vue.reactive({ prepared: false, busy: false, disabled: false, label: '标记食材已备齐' });
const renderReady = nativeReadyComponent.setup(readyProps);
for (const prepared of [false, true, false]) {
  readyProps.prepared = prepared;
  const rendered = renderReady({ $emit() {} }, []);
  assert.equal(rendered[readyTextBinding], prepared ? '已备齐' : '备齐');
  assert.equal(rendered[readyPressedBinding], prepared);
}
assert.doesNotMatch(nativeReady + nativeReadyScript, /保存中/);
assert.match(nativePrep, /<dish-ready-button\b/);
assert.match(nativePrep, /class="[^\"]*prep-cart-button[^\"]*primary-button[^\"]*"[^>]*aria-label=[^>]*bindtap=/);
assert.match(nativePrep, /class="prep-card-actions[^\"]*"/);
assert.match(nativePrep, /class="prep-card-toolbar[^\"]*"/);
assert.doesNotMatch(nativePrep, /prep-edit-button|>调整</);
assert.match(nativePrep, />按需调整</);
assert.match(nativePrep, />去采购</);
assert.match(nativePrep, /<view\b[^>]*class="prep-cart-icon[^"]*"/);
assert.match(nativePrep, /<text\b[^>]*wx:if="\{\{\w+\}\}"[^>]*class="[^"]*prep-cart-count[^"]*nav-count[^"]*is-overflow[^"]*"[^>]*role="status"/);
assert.match(styles, /\.nav-count\{--count-size:\s*20px;[^}]*width:var\(--count-size\);height:var\(--count-size\);padding:0;border-radius:50%/);
assert.match(styles, /\.nav-count\.is-overflow\{--count-size:\s*26px\}/);
assert.match(styles, /\.nav-count\{[^}]*display:inline-flex;align-items:center;justify-content:center/);
assert.doesNotMatch(nativePrep, />已加购（/);
assert.match(readFileSync(resolve(directory, 'components/MealPreparationSheet.js'), 'utf8'), /已加购/);
assert.doesNotMatch(nativePrep + readFileSync(resolve(directory, 'components/MealPreparationSheet.js'), 'utf8'), /加购中/);
assert.doesNotMatch(nativePrep, /shopping-draft-editor|prep-progress/);
assert.doesNotMatch(nativePrepEditor, /<sheet\b|<select-field\b/);
assert.match(nativePrep, /<dish-preparation-editor\b/);
assert.match(nativePrepEditor, /u-r="ingredientFields"/);
assert.match(nativePrepEditor, /u-r="ingredientErrors"/);
assert.match(nativePrepEditor, /class="preparation-edit-errors/);
assert.match(nativePrepEditorScript, /"external-error":(?:true|!0)/);
assert.doesNotMatch(nativePrepEditor, /u-r="\{\{/);
assert.doesNotMatch(nativePrepEditor, /以上仅调整本餐，不影响原菜谱|preparation-edit-scope/);
assert.match(nativePrepEditor, /class="preparation-unit-options[^\"]*"[^>]*role="listbox"/);
assert.match(nativePrepEditor, /<button[^>]*aria-label="恢复本餐默认食材和用量"[^>]*class="[^\"]*'text-button', 'preparation-reset'[^\"]*"[^>]*><app-icon[^>]*\/><text[^>]*>恢复默认<\/text>/);
assert.match(nativePrepEditor, /class="text-button preparation-add[^\"]*"[^>]*aria-label="添加食材或配料"[^>]*><app-icon[^>]*\/><text[^>]*>添加食材\/配料<\/text>/);
assert.match(nativePrepEditorScript, /name:"restore",active:(?:true|!0),size:16/);
assert.match(nativePrepEditorScript, /name:"plus",active:(?:true|!0),size:16/);
assert.match(readFileSync(resolve(directory, 'components/DishPreparationEditor.wxss'), 'utf8'), /\.preparation-reset[^}]*text-decoration:none/, 'restore uses the shared text action without an underline');
assert.doesNotMatch(nativePrepEditor + nativePrepEditorScript, /保存本餐调整|撤销修改/);
assert.doesNotMatch(nativePrepEditor + nativePrepEditorScript, /正在同步|等待同步|已自动保存/);
assert.doesNotMatch(readFileSync(resolve(directory, 'components/MutationSyncStatus.wxml'), 'utf8'), /mutation-progress/);
assert.match(nativePrepEditorScript, /"field-class":"input preparation-material-input"/);
assert.match(nativePrepEditorScript, /input preparation-material-input preparation-material-quantity/);
assert.match(nativePrepEditorScript, /"empty-value":0/);
assert.match(nativePrepEditorScript, /quantity-zero/);
assert.match(nativePrepEditor, /class="preparation-unit-chevron/);
assert.match(nativePrep, /class="prep-disclosure-chevron/);
assert.match(readFileSync(resolve(directory, 'components/DishPreparationEditor.wxss'), 'utf8'), /grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
assert.match(styles, /\.input\.preparation-material-input\{[^}]*margin:0;[^}]*padding:0;[^}]*border:0;[^}]*font-size:var\(--type-meta\)/);
assert.match(styles, /\.input\.preparation-material-quantity\{text-align:right/);
assert.match(nativePrepEditor, /role="button"[^>]*class="icon-button preparation-remove[^\"]*"[^>]*aria-label=[^>]*bindtap=/);
assert.match(nativePrepEditor + nativePrepEditorScript, /trash-danger/);
assert.doesNotMatch(nativePrepEditor, /role="switch"|preparation-needed-toggle/);
assert.match(nativePrepEditor, /class="preparation-edit-actions[^\"]*"/);
assert.match(nativePrepEditor, /class="preparation-edit-footer[^\"]*"[^>]*><view class="preparation-edit-actions/);
assert.match(readFileSync(resolve(directory, 'components/DishPreparationEditor.wxss'), 'utf8'), /\.preparation-edit-footer[^}]*gap:0;[^}]*margin:0;[^}]*padding:0/);
assert.match(readFileSync(resolve(directory, 'components/DishPreparationEditor.wxss'), 'utf8'), /\.preparation-edit-actions[^}]*justify-content:space-between;[^}]*gap:0 16px/, 'material actions align with opposite sides of the list');
assert.match(readFileSync(resolve(directory, 'components/DishPreparationEditor.wxss'), 'utf8'), /\.preparation-reset[^}]*margin:0 0 0 auto/, 'restore remains right aligned');
assert.doesNotMatch(readFileSync(resolve(directory, 'components/DishPreparationEditor.wxss'), 'utf8'), /preparation-edit-scope|preparation-scope-size|preparation-scope-ink/);
assert.match(nativePrepEditor, /class="meal-material-items[^\"]*"[^>]*role="list"/);
assert.doesNotMatch(nativePrepEditor, /meal-material-group|meal-material-label/);
assert.match(nativePrepEditor, /class="meal-material-items[^\"]*"[^>]*aria-label="本餐食材和配料"/);
assert.match(styles, /\.meal-material-items\{[^}]*flex-direction:column/);
assert.match(nativePrepEditor, /class="meal-material-header preparation-material-header[^\"]*"/);
assert.match(nativePrepEditor, />用量</);
assert.match(nativePrepEditor, />操作</);
assert.match(styles, /\.meal-material-item\{[^}]*border-bottom:1px solid var\(--line\);[^}]*background:transparent/);
assert.match(styles, /\.sheet\.is-preparation \.sheet-header\{[^}]*border-bottom:0/);
assert.match(styles, /\.sheet\.is-preparation \.sheet-footer\{[^}]*border-top:0/);
assert.match(styles, /\.sheet\.is-preparation\{background:var\(--white\)/);
assert.match(styles, /\.sheet\.is-preparation \.sheet-header\{[^}]*background:var\(--white\)/);
assert.match(styles, /\.sheet\.is-preparation \.sheet-footer\{[^}]*background:var\(--white\)/);
assert.match(readFileSync(resolve(directory, 'components/MealPreparationSheet.wxss'), 'utf8'), /\.prep-card[^}]*border:1px solid var\(--line\)/);
assert.doesNotMatch(nativePrep, />查看做法<|>备注<|>在别处备齐</);
assert.match(nativeShopping, /class="shopping-package/);
assert.match(nativeShopping, /class="[^"]*shopping-package-disclosure[^"]*"[^>]*aria-expanded=[^>]*aria-controls=[^>]*bindtap=/);
assert.match(nativeShopping, /id="[^"]*"[^>]*class="shopping-package-ingredients/);
assert.match(nativeShopping, /<meal-ingredient-list\b/);
assert.match(readFileSync(resolve(directory, 'components/MealIngredientList.wxml'), 'utf8'), /role="listitem"/);
assert.match(readFileSync(resolve(directory, 'components/MealIngredientList.wxml'), 'utf8'), /class="meal-material-header[^\"]*"/);
assert.doesNotMatch(readFileSync(resolve(directory, 'components/MealIngredientList.wxml'), 'utf8'), /meal-material-group|meal-material-label/);
assert.match(nativeShopping, />看看美食</);
assert.doesNotMatch(nativeShopping, />没有待买食材<|shopping-empty-title/);
assert.doesNotMatch(nativeShopping, /确认收货|物流|立即支付|购买订单/);
assert.doesNotMatch(nativeShopping, /dish-ready-button|shopping-draft-editor|调整清单|shopping-review/);
assert.match(nativeShopping, /role="checkbox"[^>]*class="shopping-dish-select[^"]*"[^>]*aria-checked=[^>]*aria-label=[^>]*bindtap=/);
assert.match(nativeShopping, /role="checkbox"[^>]*class="shopping-meal-select[^"]*"[^>]*aria-checked=[^>]*bindtap=/);
assert.match(nativeShopping, /class="[^"]*order-card[^"]*shopping-meal[^"]*has-expanded-tail/);
assert.match(readFileSync(resolve(directory, 'components/ShoppingView.wxss'), 'utf8'), /\.shopping-package\.is-expanded[^}]*:last-child\{padding-bottom:0\}/, 'only the final expanded package removes its extra bottom padding');
assert.match(readFileSync(resolve(directory, 'components/ShoppingView.wxss'), 'utf8'), /\.shopping-meal\.has-expanded-tail[^}]*\{padding-bottom:var\(--material-card-bottom-padding\)\}/);
assert.match(readFileSync(resolve(directory, 'components/MealPreparationSheet.wxss'), 'utf8'), /\.prep-card\.is-expanded[^}]*\{padding-bottom:var\(--material-card-bottom-padding\)\}/);
assert.match(nativeShopping, /class="shopping-meal-count[^"]*"[^>]*>\{\{[^}]+\}\}道菜</);
assert.match(nativeShopping, /class="shopping-purchase-count[^"]*"[^>]*>\{\{[^}]+\}\}道菜</);
assert.match(nativeShopping, /class="selection-dock shopping-purchase/);
assert.match(nativeShopping, /class="primary-button selection-submit/);
assert.match(nativeShopping, />下单</);
assert.doesNotMatch(nativeShopping, />下单购买</);
assert.match(readFileSync(resolve(directory, 'components/ShoppingView.js'), 'utf8'), /接入中，敬请期待/);
console.log('微信备菜与采购产物检查通过：备齐与加购沿用共享主次按钮、底部购物车数字角标；采购配料按菜独立收起，按菜或餐选择下单，材料只读，无交易流程。');
const nativeAddition = readFileSync(resolve(directory, 'components/AddDishesSheet.wxml'), 'utf8');
const nativeAdditionScript = readFileSync(resolve(directory, 'components/AddDishesSheet.js'), 'utf8');
const nativeAdditionStyles = readFileSync(resolve(directory, 'components/AddDishesSheet.wxss'), 'utf8');
assert.match(nativeAdditionScript, /"preferred-height":640/);
assert.match(nativeAdditionScript, /"fit-content":!1/);
assert.match(nativeAddition, /class="meal-addition-search search-wrap[^\"]*"/);
for (const searchSlot of ['search-leading-icon', 'search-input-slot', 'search-clear-slot']) assert.match(nativeAddition, new RegExp(`class="${searchSlot}[^\"]*"`));
assert.match(nativeAddition, /aria-label="清空加菜搜索"[^>]*bindtap=/);
assert.match(nativeAddition, /class="meal-addition-empty[^\"]*"[^>]*role="status"/);
assert.match(nativeAddition + nativeAdditionScript, /没有找到相关菜品或套餐/);
assert.match(nativeAddition + nativeAdditionScript, /换一换试试/);
assert.match(nativeAdditionStyles, /\.meal-addition-row[^}]*min-height:64px;[^}]*padding:var\(--food-row-padding\) 0/);
assert.match(styles, /\.meal-addition-search\.search-wrap\{[^}]*height:44px;[^}]*border-radius:var\(--search-radius\)/);
console.log('微信加菜检查通过：紧凑菜品行、首页同款胶囊搜索与清空按钮；搜索及无结果保持弹窗高度，保留内联空态提示。');
const foodThumbnail = readFileSync(resolve(directory, 'components/FoodThumbnail.js'), 'utf8');
assert.match(foodThumbnail, /variant:"card",mode:"aspectFill",thumbnail:!0/, 'all food list thumbnails fill the frame without leaving blank bars');
assert.doesNotMatch(foodThumbnail, /aspectFit|fill:Boolean/, 'food thumbnails do not require page-specific filling opt-ins');
assert.match(foodThumbnail, /coverFrameStyle\)\("recipe"\)/, 'food list thumbnails use the same golden frame as recipe and set covers');
for (const component of ['MenuSwipeRow', 'MealDishList', 'SetSheet', 'CommunityView', 'SetEditor', 'ShareSheet', 'AddDishesSheet', 'CookingDiary']) {
  const registration = JSON.parse(readFileSync(resolve(directory, `components/${component}.json`), 'utf8'));
  assert.equal(registration.usingComponents['food-thumbnail'], './FoodThumbnail', `${component} registers the shared native food thumbnail`);
}
const sharedRegistration = JSON.parse(readFileSync(resolve(directory, 'pages/shared/index.json'), 'utf8'));
assert.equal(sharedRegistration.usingComponents['food-thumbnail'], '../../components/FoodThumbnail', 'friend-shared set details use the same thumbnail');
assert.match(styles, /\.step-photo-tile,[^{]*\.step-photo-add\{[^}]*width:var\(--step-photo-size\);height:var\(--step-photo-size\)/, 'native add and attachment tiles share square geometry');
assert.match(readFileSync(resolve(directory, 'components/RecipeContent.js'), 'utf8'), /mode:"widthFix"/, 'recipe instructions still show natural-ratio photos');
assert.doesNotMatch(menuMarkup, /home-menu-entry-actions|home-menu-edit/);
assert.match(menuMarkup, /class="home-menu-group-heading [^"]*" role="heading" aria-level="2"/, 'populated native menu groups keep their visible category heading');
assert.match(menuStyles, /\.home-menu-group-heading[^{}]*\{padding:2px 0 8px;/, 'native category headings keep a little breathing room above their first dish');
assert.match(menuStyles, /\.home-menu-rail[^{}]*\{[^}]*background:var\(--white\)/, 'native category rail ends naturally on the white page');
assert.match(menuStyles, /\.home-menu-category\.active[^}]*background:var\(--green-light\)/, 'only the selected native category has a soft blue-gray background');
assert.match(menuStyles, /\.home-menu-category\.active[^{}]*:before[^}]*width:3px/, 'native selected categories retain a visible short marker');
const welcomeMarkup = readFileSync(resolve(directory, 'components/HomeWelcome.wxml'), 'utf8');
const welcomeStyles = readFileSync(resolve(directory, 'components/HomeWelcome.wxss'), 'utf8');
assert.match(styles, /\.orders-view\s*\{[^}]*padding-top:0(?:;|\})/, 'native kitchen content aligns with the menu without extra spacing below the shared page header');
assert.match(welcomeMarkup, /mode="aspectFill"/, 'native empty-state illustrations fill their reserved golden-ratio frame');
assert.match(welcomeMarkup, /<family-cover-image\b/, 'compact headers reuse the family cover image pipeline');
assert.match(welcomeMarkup, /class="primary-button home-welcome-button[^>]+catchtap=/, 'native welcome actions stop bubbling and use a real tap handler');
assert.match(welcomeStyles, /min-height:88px/, 'compact native headers remain lightweight rather than restoring the full-size cover');
assert.match(welcomeStyles, /\.home-welcome\.is-kitchen[^{}]*\{[^}]*flex-direction:row;[^}]*align-items:center/, 'native compact kitchen keeps the copy and cover in one row');
assert.match(welcomeStyles, /\.is-kitchen[^{}]*\.home-welcome-actions[^{}]*\{[^}]*align-items:flex-start;[^}]*margin-top:4px/, 'native idle kitchen places the menu action under the left-aligned title');
assert.match(welcomeStyles, /\.is-kitchen[^{}]*\.home-welcome-button[^{}]*\{[^}]*padding-left:0;[^}]*background:transparent;[^}]*border:0/, 'native idle kitchen keeps its menu entry subtle and flush with the title');
assert.doesNotMatch(kitchenMarkup, /再安排一餐|kitchen-plan-another/);
const nativeWelcomeNodes = [];
function collectWelcomeNodes(node) { if (node.type === 1) { nativeWelcomeNodes.push(node); node.children.forEach(collectWelcomeNodes); } }
baseParse(welcomeMarkup).children.forEach(collectWelcomeNodes);
const nativeWelcomeCopy = nativeWelcomeNodes.find(node => node.props.some(prop => prop.name === 'class' && prop.value?.content.split(' ').includes('home-welcome-copy')));
const nativeWelcomeActions = nativeWelcomeNodes.find(node => node.props.some(prop => prop.name === 'class' && prop.value?.content.split(' ').includes('home-welcome-actions')));
assert.ok(nativeWelcomeActions.loc.start.offset > nativeWelcomeCopy.loc.start.offset && nativeWelcomeActions.loc.end.offset < nativeWelcomeCopy.loc.end.offset, 'native welcome actions stay inside the copy column, not beside it');
function welcomeVisibility(className) {
  const node = nativeWelcomeNodes.find(node => node.props.some(prop => prop.name === 'class' && prop.value?.content.split(' ').includes(className)));
  const binding = node?.props.find(prop => prop.name === 'wx:if')?.value?.content.match(/^\{\{(\w+)\}\}$/)?.[1];
  assert.ok(binding, `${className}: conditional native rendering is explicit`);
  return binding;
}
const welcomeArtKey = welcomeVisibility('home-welcome-art');
const welcomeCoverKey = welcomeVisibility('home-welcome-cover');
const welcomeActionsKey = welcomeVisibility('home-welcome-actions');
let nativeWelcome;
const welcomeModules = {
  '../common/vendor.js': { ...Vue, _export_sfc: (component, properties) => Object.assign(component, Object.fromEntries(properties)), e: (...values) => Object.assign({}, ...values), t: Vue.toDisplayString, n: Vue.normalizeClass, s: value => value, p: value => value, o: handler => handler, f: (entries, render) => entries.map(render) },
  '../domain/image-crop.js': { coverFrameStyle },
  '../domain/presentation.js': { DEFAULT_SET_COVER },
};
const { code: nativeWelcomeCode } = transformSync(readFileSync(resolve(directory, 'components/HomeWelcome.js'), 'utf8'), { presets: [['@babel/preset-env', { targets: { ie: '11' } }]], babelrc: false, configFile: false });
runInNewContext(nativeWelcomeCode, {
  require: specifier => { assert.ok(welcomeModules[specifier], `welcome dependency: ${specifier}`); return welcomeModules[specifier]; },
  wx: { createComponent: component => { nativeWelcome = component; } },
});
for (const kitchen of [false, true]) for (const compact of [false, true]) for (const primaryLabel of ['', '看看菜单']) {
  const events = [];
  const props = { kitchen, compact, title: '今天还没安排餐食', description: '', cover: 'cloud://family-cover', illustration: DEFAULT_SET_COVER, primaryLabel, primaryIcon: kitchen ? 'menu' : 'menu-inverse', secondaryLabel: '', secondaryIcon: '', busy: false };
  const rendered = nativeWelcome.setup(props)({ $emit: event => events.push(event) }, []);
  assert.equal(rendered[welcomeArtKey], !compact && !kitchen);
  assert.equal(rendered[welcomeCoverKey], compact);
  assert.equal(Boolean(rendered[welcomeActionsKey]), Boolean(primaryLabel));
  assert.equal(Object.values(rendered).some(value => value?.variant === 'card' && value.src === props.cover), compact, 'all nonempty native kitchen headers and populated menus use the same saved family cover');
  if (primaryLabel) {
    assert.ok(Object.values(rendered).some(value => value?.name === props.primaryIcon && value.size === (kitchen ? 16 : 18) && value.active === kitchen));
    const callbacks = Object.values(rendered).filter(value => typeof value === 'function');
    assert.equal(callbacks.length, 1);
    callbacks[0]({});
    assert.deepEqual(events, ['primary']);
  }
}
const compiledKitchen = { exports: {} };
const nativeDateProps = { calendar: true, kitchen: true, compact: true, title: '有餐食预定，快来准备吧！', description: '10月23日 · 九月十四 · 周五', cover: '', primaryLabel: '', secondaryLabel: '' };
const nativeDateRender = nativeWelcome.setup(nativeDateProps)({}, []);
const nativeDateParts = Object.values(nativeDateRender).find(Array.isArray);
assert.equal(nativeDateParts.length, 3, 'native headers render solar date, lunar date and weekday as three intact segments');
for (const [index, part] of ['10月23日', '九月十四', '周五'].entries()) assert.ok(Object.values(nativeDateParts[index]).includes(part));
assert.match(welcomeStyles, /\.home-welcome-date-part[^{}]*\{[^}]*white-space:nowrap/, 'native lunar dates cannot leave a single character on a new line');
const { code: nativeKitchenCode } = transformSync(readFileSync(resolve(directory, 'domain/kitchen.js'), 'utf8'), { presets: [['@babel/preset-env', { targets: { ie: '11' } }]], babelrc: false, configFile: false });
runInNewContext(nativeKitchenCode, { exports: compiledKitchen.exports, module: compiledKitchen, require: specifier => { assert.equal(specifier, './presentation.js'); return { validateImage, stepImages }; } });
let nativeMealBar;
const nativeMealBarModules = { '../common/vendor.js': welcomeModules['../common/vendor.js'], '../domain/kitchen.js': compiledKitchen.exports };
runInNewContext(readFileSync(resolve(directory, 'components/MealBar.js'), 'utf8'), {
  require: specifier => { assert.ok(nativeMealBarModules[specifier], `meal date dependency: ${specifier}`); return nativeMealBarModules[specifier]; },
  wx: { createComponent: component => { nativeMealBar = component; } },
});
const mealBarMarkup = readFileSync(resolve(directory, 'components/MealBar.wxml'), 'utf8');
assert.match(mealBarMarkup, /class="reservation-day-label"/);
assert.match(mealBarMarkup, /class="reservation-day-date"/);
for (const today of ['2026-10-26', '2026-12-31', '2024-02-28']) {
  const days = compiledKitchen.exports.reservationDays(today);
  const events = [];
  const bindings = nativeMealBar.setup({ today, date: days[1].date, meal: '晚餐' })({ $feedback() {}, $emit: (...args) => events.push(args) }, []);
  const dates = Object.values(bindings).find(value => Array.isArray(value) && value.length === 3);
  assert.equal(dates.length, 3);
  dates.forEach((row, index) => {
    const values = Object.values(row);
    const calendar = compiledKitchen.exports.calendarDateLabel(days[index].date);
    assert.ok(values.includes(days[index].label) && values.includes(calendar), 'native date buttons show the relative name and actual month/day');
    assert.ok(values.includes(`选择${days[index].label}，${calendar}`));
    values.find(value => typeof value === 'function')({});
  });
  assert.deepEqual(events, Array.from(days, day => ['update:date', day.date]));
}
const inventoryMarkup = readFileSync(resolve(directory, 'components/InventoryView.wxml'), 'utf8');
assert.match(inventoryMarkup, /class="stock-photo" style="\{\{/);
assert.match(inventoryMarkup, /class="stock-photo-image" style="position:absolute;inset:0;background:var\(--white\)"/);
assert.match(inventoryMarkup, /class="supplies-empty-art"/);
assert.doesNotMatch(inventoryMarkup, />冰箱空空如也<|inventory-empty-title/);
assert.match(readFileSync(resolve(directory, 'components/ShoppingView.wxml'), 'utf8'), /class="shopping-empty-art supplies-empty-art(?: [^"]*)?"/);
assert.match(styles, /\.supplies-empty-art\{[^}]*border:0;[^}]*border-radius:0;[^}]*background:transparent;[^}]*box-shadow:none/, 'native empty fridge and shopping keep only the large icon, with no circular background or shadow');
assert.match(styles, /\.supplies-empty-art\{width:64px;height:64px;[^}]*margin:0 0 16px/, 'native empty-state artwork removes the old oversized spacer');
assert.match(styles, /\.stock-card\{display:flex;flex-direction:column;align-items:stretch/);
assert.doesNotMatch(styles, /\.stock-grid\{grid-template-columns:minmax\(0,1fr\)/);
assert.match(readFileSync(resolve(directory, 'components/ShoppingView.wxss'), 'utf8'), /\.shopping-empty-button[^{}]*\{[^}]*border-radius:var\(--radius-control\)/);
console.log('微信日期与冰箱产物检查通过：选餐日期双行与实际日期一致，采购空态为圆角矩形；冰箱保持手机端双列白色图片卡片。');
const scheduledNativeMeals = ['2026-10-22', '2026-10-23', '2026-10-24'].flatMap(date => ['早餐', '午餐', '晚餐', '宵夜'].map((meal, index) => ({ id: `${date}-${meal}`, date, meal, status: ['pending', 'accepted'][index % 2] })));
const finishedNativeMeals = scheduledNativeMeals.map((order, index) => ({ ...order, id: `finished-${order.id}`, status: index % 2 ? 'cancelled' : 'completed', [index % 2 ? 'cancelledAt' : 'completedAt']: new Date(Date.parse('2026-10-22T00:00:00Z') + index * 60000).toISOString() }));
const expectedNativeMeals = [...scheduledNativeMeals, ...finishedNativeMeals.reverse()];
assert.deepEqual(Array.from(compiledKitchen.exports.kitchenOrders([...expectedNativeMeals].reverse(), '2026-10-22'), order => order.id), expectedNativeMeals.map(order => order.id));
const compiledKitchenWelcome = { exports: {} };
const { code: nativeKitchenWelcomeCode } = transformSync(readFileSync(resolve(directory, 'domain/home-welcome.js'), 'utf8'), { presets: [['@babel/preset-env', { targets: { ie: '11' } }]], babelrc: false, configFile: false });
const welcomeDomainModules = { './kitchen.js': compiledKitchen.exports, '../common/vendor.js': { solarLunar } };
runInNewContext(nativeKitchenWelcomeCode, { exports: compiledKitchenWelcome.exports, module: compiledKitchenWelcome, Intl: undefined, require: specifier => { assert.ok(welcomeDomainModules[specifier], `welcome domain dependency: ${specifier}`); return welcomeDomainModules[specifier]; } });
assert.equal(compiledKitchenWelcome.exports.homeDateLabel('2026-10-23'), '10月23日 · 九月十四 · 周五', 'native menu and kitchen omit year and lunar prefix and put the weekday last');
assert.equal(compiledKitchenWelcome.exports.homeDateLabel('2025-07-25'), '07月25日 · 闰六月初一 · 周五', 'native calendar preserves leap-month names');
assert.equal(compiledKitchenWelcome.exports.homeDateLabel('2026-02-30'), '', 'native calendar never displays an invalid date');
assert.equal(compiledKitchenWelcome.exports.kitchenWelcome([], '2026-10-22').mode, 'empty', 'an empty native kitchen uses the full illustrated welcome');
assert.equal(compiledKitchenWelcome.exports.kitchenWelcome([], '2026-10-22').title, '今天还没安排餐食', 'the empty kitchen keeps its original title');
for (const status of ['pending', 'accepted', 'completed', 'cancelled']) {
  const historicalMeal = { id: 'past-meal', date: '2026-09-01', meal: '晚餐', status };
  const welcome = compiledKitchenWelcome.exports.kitchenWelcome([historicalMeal], '2026-10-22');
  assert.equal(welcome.mode, 'empty', 'past orders do not keep the current three-day kitchen from displaying its empty state');
  assert.equal(welcome.title, '今天还没安排餐食');
  assert.equal(welcome.recordTitle, '', 'out-of-window history has no visible heading');
  assert.equal(compiledKitchen.exports.kitchenOrders([historicalMeal], '2026-10-22').length, 0);
  for (const date of ['2026-10-22', '2026-10-23', '2026-10-24']) {
    const visibleMeal = { ...historicalMeal, date };
    const visibleWelcome = compiledKitchenWelcome.exports.kitchenWelcome([visibleMeal], '2026-10-22');
    const active = ['pending', 'accepted'].includes(status);
    assert.equal(visibleWelcome.mode, active ? 'active' : 'idle');
    assert.equal(visibleWelcome.title, active ? '有餐食预定，快来准备吧！' : '还没有餐食，快来预订吧！');
  }
}
console.log('微信厨房页头与排序检查通过：仅今天、明天、后天全部状态的餐单可见，旧记录不删除；待做餐按日期餐次在前，开饭与取消统一后置并按操作时间倒序。');
assert.doesNotMatch(swipeStyles, /\.menu-swipe[^{}]*\{[^}]*border-bottom/, 'native menu rows use spacing rather than divider lines');
for (const name of ['RecipeSheet', 'SetSheet']) {
  const detail = readFileSync(resolve(directory, `components/${name}.wxml`), 'utf8');
  assert.match(detail, /menu-detail-actions/);
  assert.doesNotMatch(detail, /menu-entry-remove|detail-action\s/);
}
console.log('微信交互产物经 ES5 二次转译后验证通过：首次加载、返回缓存、即时开关、连续点击排队与失败回退。');
console.log('微信分享产物检查通过：预备卡片去重、编辑后失效、原生分享、圆形操作单击与无障碍标签。');
console.log('微信头像产物检查通过：厨房不显示点餐人头像且不预留占位，人数与选菜操作保留；家庭成员头像更新、匿名图标和圆形容器正常。');
console.log('微信美食署名检查通过：美食详情独有标题下作者与封面右下角无单位家庭数，其他详情不展示；卡片署名、透明渐变顶栏和加入入口保留，未知计数仍隐藏。');
console.log('微信菜品图片检查通过：菜单、厨房、加菜、套餐、分享和日记统一铺满黄金比例框；保留缩略图缓存、步骤原比例与瀑布流。');
console.log('微信首页产物检查通过：类别与烹饪时间／套餐道数、分类小标题与无横线菜单、三项新增入口、WXS 左滑编辑/分享/删除与点击隔离、沉浸详情工具栏及标题旁选菜；保留原编辑及删除确认。');
const sharePickerMarkup = readFileSync(resolve(directory, 'components/FriendShareSheet.wxml'), 'utf8');
const createPickerMarkup = readFileSync(resolve(directory, 'pages/index/index.wxml'), 'utf8');
for (const markup of [sharePickerMarkup, createPickerMarkup]) {
  assert.match(markup, /class="sheet-action-options /, 'both native pickers use the shared horizontal action row');
  assert.match(markup, /class="sheet-action-icon"/, 'both native pickers retain their circular icon surfaces');
  assert.match(markup, /class="sheet-action-label"/, 'round actions retain visible text labels');
  assert.doesNotMatch(markup, /class="share-option|class="menu-create-option"/, 'old full-width tinted rows are removed');
}
assert.equal((sharePickerMarkup.match(/class="sheet-action-cell"/g) || []).length, 2);
assert.equal((createPickerMarkup.match(/class="sheet-action-cell"/g) || []).length, 3);
assert.match(readFileSync(resolve(directory, 'pages/index/index.js'), 'utf8'), /name:"meal-set",size:26/);
for (const variant of ['', '-active']) assert.ok(readFileSync(resolve(directory, `static/icon-meal-set${variant}.png`)).length > 0);
assert.match(sharePickerMarkup, /<native-share-button\b/, 'friend sharing still uses a native share button');
assert.match(sharePickerMarkup, /微信好友/);
assert.match(sharePickerMarkup, /发布美食/);
assert.match(sharePickerMarkup, /不含家庭信息/);
assert.match(sharePickerMarkup, /所有人可见/);
assert.match(styles, /\.sheet-action-icon\{[^}]*width:56px;height:56px;border-radius:50%/);
assert.match(styles, /\.sheet\.is-action-picker \.sheet-header\{border-bottom:0\}/);
assert.match(styles, /\.home-menu-add::?before\{[^}]*background:var\(--paper\)/, 'menu plus uses the same background token as the search field');
assert.match(styles, /\.home-menu-add:not\(\[disabled\]\):hover::?before\{background:var\(--control-hover\)\}/);
assert.doesNotMatch(styles, /\.home-menu-add:hover[,\{]/, 'hover does not paint the full 44px touch target');
console.log('微信圆形入口检查通过：菜单三项与分享两项共用圆形图标、短文字和紧凑弹窗，原生分享及隐私说明保留，加号悬停不扩大背景。');
