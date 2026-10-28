import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { effectScope, nextTick, ref } from 'vue';
import { parse } from '@vue/compiler-sfc';
import { baseParse } from '@vue/compiler-dom';
import postcss from 'postcss';
import { NATIVE_UI_COLORS } from '../src/domain/ui-theme.js';
import { createCommunityFeed } from '../src/services/community-feed.js';
import { useCommunityNavigation } from '../src/composables/useCommunityNavigation.js';
import { useCommunityFeedViewport } from '../src/composables/useCommunityFeedViewport.js';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(context, refresh = async () => {}, onError = () => {}) {
  const scope = effectScope();
  const locked = ref(false);
  const enabled = ref(true);
  const loading = ref(false);
  const navigation = scope.run(() => useCommunityNavigation(locked, ref(false)));
  const viewport = scope.run(() => useCommunityFeedViewport({ navigation, locked, enabled, loading, refresh, onError }));
  context.after(() => scope.stop());
  return { ...viewport, scope, navigation, locked, enabled, loading };
}

test('food-only neutral background matches the supplied reference without changing shared white surfaces', () => {
  const stylesheet = postcss.parse(source('src/styles.css'));
  const declarations = selector => {
    const result = new Map();
    stylesheet.walkRules(rule => { if (rule.selectors.includes(selector)) rule.walkDecls(value => result.set(value.prop, value.value)); });
    return result;
  };
  assert.equal(declarations('.app-shell').get('--feed-surface'), '#fafafa');
  assert.equal(NATIVE_UI_COLORS.feedBackground, declarations('.app-shell').get('--feed-surface'));
  assert.equal(declarations('.app-shell.community-page').get('background'), 'var(--feed-surface)');
  for (const selector of ['.app-shell', '.page-header-fixed', '.community-navigation-surface', '.sidebar', '.community-waterfall .feed-card', '.feed-skeleton-card']) {
    assert.equal(declarations(selector).get('background'), 'var(--white)', selector);
  }
  assert.equal(declarations('.community-page .content').get('padding-bottom'), '0');
  assert.equal(declarations('.community-feed-scroll').get('min-height'), '0');
  assert.equal(declarations('.community-refresher').get('width'), '100%');
  assert.equal(declarations('.community-refresher').get('justify-content'), 'center');
  assert.equal(declarations('.community-feed-content').get('padding-top'), 'var(--community-toolbar-height)');
  assert.equal(declarations('.community-view').get('--page-header-extension-height'), '0px');
  assert.match(declarations('.community-view').get('height'), /100vh - var\(--community-bottom-inset\)/);
  assert.match(source('src/pages/index/index.vue'), /'community-page': tab === 'community'/);
  const configuration = JSON.parse(source('src/pages.json'));
  assert.equal(configuration.pages[0].style.enablePullDownRefresh, undefined);
});

test('only the feed scrolls and refreshes while detail sheets stay outside the native scroller', () => {
  const component = source('src/components/CommunityView.vue');
  const template = baseParse(parse(component).descriptor.template.content);
  const descendants = node => [node, ...(node.children || []).flatMap(descendants)];
  const nodes = descendants(template);
  const scrollers = nodes.filter(node => node.tag === 'scroll-view');
  assert.equal(scrollers.length, 1);
  const scroll = scrollers[0];
  const property = (name, argument) => scroll.props.find(prop => prop.name === name && (!argument || prop.arg?.content === argument));
  assert.equal(property('bind', 'scroll-y').exp.content, '!feedLocked');
  assert.equal(property('bind', 'refresher-enabled').exp.content, 'refresherEnabled');
  assert.equal(property('bind', 'refresher-triggered').exp.content, 'refreshing');
  assert.equal(property('on', 'refresherrefresh').exp.content, 'feedViewport.onRefresh');
  assert.equal(property('on', 'refresherabort').exp.content, 'feedViewport.stopPull');
  assert.equal(property('on', 'scroll').exp.content, 'feedViewport.onScroll');
  assert.equal(property('on', 'scrolltolower').exp.content, 'loadMore');
  assert.equal(property('bind', 'lower-threshold').exp.content, '360');
  assert.equal(descendants(scroll).filter(node => node.tag === 'FoodDetailSheet' || node.tag === 'PageHeader').length, 0);
  assert.match(component, /feed\.error \? feedController\.retry\(\) : loadFeed\(true\)/);
  assert.match(component, /onError: error => notify\(/);
  assert.doesNotMatch(component, /uni\.pageScrollTo/);
});

test('refresh feedback centers within the revealed gap below the overlaid toolbar', () => {
  const stylesheet = postcss.parse(source('src/styles.css'));
  const declarations = selector => {
    const result = {};
    stylesheet.walkRules(selector, rule => rule.walkDecls(value => { result[value.prop] = value.value; }));
    return result;
  };
  const refresher = declarations('.community-refresher');
  assert.equal(refresher['align-items'], 'center');
  assert.equal(refresher['justify-content'], 'center');
  assert.equal(refresher.transform, 'translateY(var(--community-toolbar-height))');
  assert.equal(refresher.padding, '0');
  assert.equal(refresher['padding-bottom'], undefined);
  assert.equal(refresher.height, undefined);
  assert.equal(refresher['pointer-events'], 'none');
  const spinner = declarations('.community-refresh-spinner');
  assert.equal(spinner['margin-bottom'], undefined);
  assert.equal(spinner.flex, '0 0 16px');
  const template = baseParse(parse(source('src/components/CommunityView.vue')).descriptor.template.content);
  const descendants = node => [node, ...(node.children || []).flatMap(descendants)];
  const indicator = descendants(template).find(node => node.props?.some(prop => prop.name === 'slot' && prop.value?.content === 'refresher'));
  assert.equal(indicator.props.find(prop => prop.name === 'bind' && prop.arg?.content === 'style').exp.content, '{ height: `${refreshThreshold}px` }');
});

test('pulling below the threshold and aborting never request data or leave a ready state', context => {
  let calls = 0;
  const viewport = fixture(context, async () => { calls += 1; });
  viewport.navigation.onScroll({ scrollTop: 120 });
  assert.equal(viewport.navigation.hidden.value, true);
  viewport.onPull({ detail: { dy: 30 } });
  assert.equal(viewport.navigation.hidden.value, false);
  assert.equal(viewport.pullReady.value, false);
  viewport.onPull({ detail: { dy: viewport.refreshThreshold } });
  assert.equal(viewport.pullReady.value, true);
  viewport.stopPull();
  assert.equal(viewport.pullReady.value, false);
  assert.equal(viewport.refreshing.value, false);
  assert.equal(calls, 0);
});

test('native refresh stays active for the real request and ignores repeated triggers', async context => {
  const response = deferred();
  let calls = 0;
  const viewport = fixture(context, () => { calls += 1; viewport.loading.value = true; return response.promise; });
  const first = viewport.onRefresh();
  assert.equal(viewport.refreshing.value, true);
  await nextTick();
  assert.equal(viewport.refresherEnabled.value, true);
  await viewport.onRefresh();
  assert.equal(calls, 1);
  response.resolve();
  await first;
  assert.equal(viewport.refreshing.value, false);
});

test('loading, editing and open sheets prevent new refresh work and release native feedback', async context => {
  let calls = 0;
  const viewport = fixture(context, async () => { calls += 1; });
  for (const [control, blocked] of [[viewport.loading, true], [viewport.locked, true], [viewport.enabled, false]]) {
    const previous = control.value;
    control.value = blocked;
    assert.equal(viewport.refresherEnabled.value, false);
    await viewport.onRefresh();
    assert.equal(viewport.refreshing.value, false);
    assert.equal(calls, 0);
    control.value = previous;
  }
});

test('native scroll events drive the existing navigation and reset repeatedly to the first result', async context => {
  const viewport = fixture(context);
  viewport.onScroll({ detail: { scrollTop: 420 } });
  assert.equal(viewport.navigation.hidden.value, true);
  const resetting = viewport.reset();
  assert.equal(viewport.scrollTop.value, 420);
  await resetting;
  assert.equal(viewport.scrollTop.value, 0);
  assert.equal(viewport.navigation.hidden.value, false);
  viewport.onScroll({ detail: { scrollTop: 700 } });
  viewport.locked.value = true;
  viewport.onScroll({ detail: { scrollTop: 0 } });
  viewport.locked.value = false;
  const second = viewport.reset();
  assert.equal(viewport.scrollTop.value, 700);
  await second;
  assert.equal(viewport.scrollTop.value, 0);
  viewport.onScroll({ detail: { scrollTop: -10 } });
  assert.equal(viewport.navigation.hidden.value, false);
});

test('filter changes invalidate old refresh completions instead of stopping the new refresh', async context => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const viewport = fixture(context, () => (++calls === 1 ? first.promise : second.promise));
  const previous = viewport.onRefresh();
  await nextTick();
  await viewport.reset();
  const current = viewport.onRefresh();
  await nextTick();
  first.resolve();
  await previous;
  assert.equal(viewport.refreshing.value, true);
  second.resolve();
  await current;
  assert.equal(viewport.refreshing.value, false);
});

test('refresh exceptions and unmounts both release the spinner without delayed navigation', async context => {
  const response = deferred();
  const messages = [];
  const viewport = fixture(context, () => response.promise, error => messages.push(error.message));
  const refreshing = viewport.onRefresh();
  await nextTick();
  response.reject(new Error('网络暂不可用'));
  await refreshing;
  assert.deepEqual(messages, ['网络暂不可用']);
  assert.equal(viewport.refreshing.value, false);
  viewport.scope.stop();
  await viewport.onRefresh();
  viewport.onPull({ detail: { dy: 100 } });
  viewport.onScroll({ detail: { scrollTop: 800 } });
  assert.equal(viewport.refreshing.value, false);
  assert.equal(viewport.pullReady.value, false);
  assert.equal(viewport.navigation.hidden.value, false);
});

test('switching away while refreshing suppresses a late error without modifying another page', async context => {
  const response = deferred();
  const messages = [];
  const viewport = fixture(context, () => response.promise, error => messages.push(error.message));
  const refreshing = viewport.onRefresh();
  await nextTick();
  viewport.scope.stop();
  response.reject(new Error('迟到的网络错误'));
  await refreshing;
  assert.equal(viewport.refreshing.value, false);
  assert.deepEqual(messages, []);
});

test('refresh bypasses a fresh cache, retains visible cards until success and preserves every filter', async context => {
  const response = deferred();
  const calls = [];
  const feed = createCommunityFeed({ cache: new Map(), request: query => {
    calls.push(query);
    return calls.length === 1 ? Promise.resolve({ posts: [{ id: 'before' }], cursor: 'next-before' }) : response.promise;
  } });
  context.after(() => feed.dispose());
  const query = { type: '菜品', category: '荤菜', search: '牛肉', sort: 'recommended', seed: 'same-round' };
  await feed.select(query, 'member:family');
  await feed.select(query, 'member:family');
  assert.equal(calls.length, 1);
  const refreshing = feed.refresh();
  assert.deepEqual(feed.state.value.posts, [{ id: 'before' }]);
  assert.equal(feed.state.value.ready, true);
  assert.deepEqual(calls[1], { ...query, cursor: '' });
  response.resolve({ posts: [{ id: 'after' }], cursor: 'next-after' });
  await refreshing;
  assert.deepEqual(feed.state.value.posts, [{ id: 'after' }]);
  assert.equal(feed.state.value.cursor, 'next-after');
});

test('refresh failure retains cards and retries the first page rather than the old next-page cursor', async context => {
  const calls = [];
  const feed = createCommunityFeed({ cache: new Map(), request: async query => {
    calls.push(query);
    if (calls.length === 2) throw new Error('网络暂不可用');
    return { posts: [{ id: calls.length === 1 ? 'before' : 'after' }], cursor: 'next-page' };
  } });
  context.after(() => feed.dispose());
  await feed.select({ sort: 'latest', search: '' }, 'member:family');
  await feed.refresh();
  assert.equal(feed.state.value.error, '网络暂不可用');
  assert.deepEqual(feed.state.value.posts, [{ id: 'before' }]);
  await feed.retry();
  assert.equal(calls[2].cursor, '');
  assert.equal(feed.state.value.error, '');
  assert.deepEqual(feed.state.value.posts, [{ id: 'after' }]);
});

test('pagination errors still retry the next page and append without losing earlier results', async context => {
  const calls = [];
  const feed = createCommunityFeed({ cache: new Map(), request: async query => {
    calls.push(query);
    if (calls.length === 2) throw new Error('暂时没加载出来');
    return calls.length === 1 ? { posts: [{ id: 'first' }], cursor: 'next-page' } : { posts: [{ id: 'second' }] };
  } });
  context.after(() => feed.dispose());
  await feed.select({ category: '汤羹' }, 'member:family');
  await feed.refresh(true);
  await feed.retry();
  assert.equal(calls[2].cursor, 'next-page');
  assert.deepEqual(feed.state.value.posts.map(post => post.id), ['first', 'second']);
});

test('refresh results cannot overwrite a newer filter or family scope', async context => {
  const delayed = deferred();
  let calls = 0;
  const feed = createCommunityFeed({ cache: new Map(), request: async query => {
    calls += 1;
    if (calls === 2) return delayed.promise;
    return { posts: [{ id: query.category }] };
  } });
  context.after(() => feed.dispose());
  await feed.select({ category: '荤菜' }, 'member:before');
  const refreshing = feed.refresh();
  await feed.select({ category: '素菜' }, 'member:after');
  delayed.resolve({ posts: [{ id: 'stale-result' }] });
  await refreshing;
  assert.deepEqual(feed.state.value.posts, [{ id: '素菜' }]);
});
