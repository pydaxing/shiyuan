// Execute the actual WeChat render functions: first paint must not depend on
// whether a request has started; cached cards remain visible during refresh.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { baseParse } from '@vue/compiler-dom';
import * as Vue from 'vue';
import { useCommunityFeedViewport } from '../src/composables/useCommunityFeedViewport.js';
import { NATIVE_UI_COLORS } from '../src/domain/ui-theme.js';
const root = new URL('../dist/build/mp-weixin/', import.meta.url);
const nodes = [];
function collect(node) { if (node.type === 1) { nodes.push(node); node.children.forEach(collect); } }
baseParse(readFileSync(new URL('components/MealSquare.wxml', root), 'utf8')).children.forEach(collect);
const attr = (node, name) => node.props.find(prop => prop.name === name)?.value?.content || '';
const read = (data, expression) => expression ? new Function('data', `with(data) { return (${expression.replace(/^\{\{|\}\}$/g, '')}); }`)(data) : undefined;
const classes = name => nodes.find(node => attr(node, 'class').split(' ').includes(name));
let retries = 0;
const feed = { posts: Vue.ref([]), cursor: Vue.ref(null), loading: Vue.ref(false), loaded: Vue.ref(false), error: Vue.ref(''), busy: Vue.ref({}), load() {}, retry() { retries += 1; }, mutate() {} };
const cloudState = { cloudMode: true, cloudStatus: Vue.ref({ phase: 'ready', userId: 'alice', familyId: 'family-a' }) };
const vendor = { ...Vue, provide() {}, inject: () => feed, e: Object.assign, f: Vue.renderList, t: String, n: Vue.normalizeClass, s: value => value, p: value => value, o: value => value, _export_sfc: component => component };
let component;
new Function('require', 'wx', readFileSync(new URL('components/MealSquare.js', root), 'utf8'))(name => {
  if (name.endsWith('vendor.js')) return vendor;
  if (name.endsWith('useNavigationAppearance.js')) return { useNavigationAppearance() {} };
  if (name.endsWith('useCommunityFeedViewport.js')) return { useCommunityFeedViewport };
  if (name.endsWith('sheetStack.js')) return { sheetOpen: Vue.ref(false) };
  if (name.endsWith('store.js')) return { ...cloudState, notify() {} };
  if (name.endsWith('services/cloud.js')) return cloudState;
  if (name.endsWith('ui-theme.js')) return { NATIVE_UI_COLORS };
  return { useMealPosts() { throw new Error('Public feed must reuse page cache'); } };
}, { createComponent: value => { component = value; } });
const scope = Vue.effectScope();
try {
  const events = [];
  const render = scope.run(() => component.setup({ active: true }, { expose() {}, emit: event => events.push(event) }));
  const data = () => render({ $emit: event => events.push(event) }, []);
  const visible = name => Boolean(read(data(), attr(classes(name), 'wx:if')) || read(data(), attr(classes(name), 'wx:elif')));
  assert.equal(visible('meal-square-loading'), true, 'skeleton appears even before request starts');
  feed.loading.value = true;
  assert.equal(visible('meal-square-loading'), true);
  feed.loading.value = false; feed.loaded.value = true;
  assert.equal(visible('meal-square-empty'), true, 'empty state replaces the skeleton after successful empty response');
  read(data(), attr(classes('meal-empty-record'), 'bindtap'))();
  assert.deepEqual(events, ['record'], 'empty state action opens real record flow');
  feed.error.value = '网络断开';
  assert.equal(visible('meal-square-empty'), false, 'network errors are not disguised as no meals');
  assert.equal(visible('meal-state-error'), true);
  const retryButton = classes('meal-state-error').children.find(node => node.type === 1 && node.tag === 'button');
  read(data(), attr(retryButton, 'bindtap'))();
  assert.equal(retries, 1, 'native retry button delegates to the failed-request retry handler');
  feed.error.value = ''; feed.posts.value = [{ id: 'mine', isOwner: true }]; feed.loading.value = true;
  const card = nodes.find(node => node.tag === 'meal-post-card');
  const rows = read(data(), attr(card, 'wx:for'));
  assert.equal(rows.length, 1, 'own public card remains visible while refreshing');
  const props = read({ [attr(card, 'wx:for-item') || 'item']: rows[0] }, attr(card, 'u-p'));
  assert.equal(props.post.id, 'mine'); assert.equal(props.manageable, false);
  assert.equal(visible('meal-square-loading'), false, 'background refresh never covers cached posts');
  console.log('微信大家首屏检查通过：请求前骨架、真实空态、重试、本人公开卡片和后台刷新缓存。');
} finally { scope.stop(); }
