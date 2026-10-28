import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue';
import { parse } from '@vue/compiler-sfc';
import postcss from 'postcss';
import { CATEGORIES } from '../src/domain/kitchen.js';
import { HOME_MENU_CATEGORIES, firstHomeMenuCategory, groupHomeMenu, homeMenuCategory, homeMenuCategoryAtScroll } from '../src/domain/home-menu.js';

const menuSource = readFileSync(new URL('../src/components/HomeMenu.vue', import.meta.url), 'utf8');
const homeSource = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8');
const menuStyles = postcss.parse(parse(menuSource).descriptor.styles[0].content);
const tailRule = menuStyles.nodes.find(rule => rule.selector === '.home-menu:not(.is-searching) .home-menu-group:last-child');
const tailMinimum = tailRule?.nodes.find(declaration => declaration.prop === 'min-height')?.value;
const hasDynamicTailInset = tailMinimum === 'var(--home-menu-viewport-height)';
const sample = [
  { key: 'set:dinner', id: 'dinner', title: '清爽晚餐', kind: 'set', recipes: [{ title: '番茄炒蛋', ingredients: [{ name: '番茄' }] }, { title: '香菇滑鸡', ingredients: [{ name: '鸡肉' }] }] },
  { key: 'tomato', title: '番茄炒蛋', kind: 'dish', category: '素菜', ingredients: [{ name: '番茄' }, { name: '鸡蛋' }] },
  { key: 'chicken', title: '香菇滑鸡', kind: 'dish', category: '荤菜', ingredients: [{ name: '鸡肉' }] },
  { key: 'old', title: '老菜谱', kind: 'dish', category: '未分类' },
];

test('home navigation has no all bucket, puts sets last, and does not change recipe categories', () => {
  assert.deepEqual(HOME_MENU_CATEGORIES, [...CATEGORIES, '套餐']);
  assert.ok(!HOME_MENU_CATEGORIES.includes('全部'));
  assert.ok(!CATEGORIES.includes('套餐'));
  assert.equal(homeMenuCategory(sample[0]), '套餐');
  assert.equal(homeMenuCategory(sample[3]), '其他');
  assert.equal(homeMenuCategory({ label: '汤羹' }), '汤羹');
  const groups = groupHomeMenu(sample);
  assert.deepEqual(groups.filter(group => group.entries.length).map(group => group.category), ['荤菜', '素菜', '其他', '套餐']);
  assert.deepEqual(groups.flatMap(group => group.entries).map(entry => entry.key), ['chicken', 'tomato', 'old', 'set:dinner']);
  assert.equal(groups.at(-1).entries[0], sample[0]);
  assert.equal(firstHomeMenuCategory(groups), '荤菜');
  assert.equal(firstHomeMenuCategory(groupHomeMenu([sample[1]])), '素菜');
  assert.equal(firstHomeMenuCategory(groupHomeMenu([sample[0]])), '套餐');
  assert.equal(firstHomeMenuCategory(groupHomeMenu([])), '荤菜');
});

test('search finds dishes and sets by titles and ingredients across categories', () => {
  const keys = query => groupHomeMenu(sample, query).flatMap(group => group.entries).map(entry => entry.key);
  assert.deepEqual(keys('番茄'), ['tomato', 'set:dinner']);
  assert.deepEqual(keys('  晚餐   鸡肉 '), ['set:dinner']);
  assert.deepEqual(keys('鸡肉'), ['chicken', 'set:dinner']);
  assert.deepEqual(keys('不存在'), []);
  assert.equal(groupHomeMenu([{ title: 'BEEF bowl', kind: 'dish', category: '主食' }], 'beef')[3].entries.length, 1);
  assert.equal(sample[0].recipes.length, 2);
});

test('scroll category follows section boundaries without manufacturing a final category at page end', () => {
  const positions = [{ category: '荤菜', top: 284 }, { category: '素菜', top: 489 }, { category: '套餐', top: 900 }];
  assert.equal(homeMenuCategoryAtScroll(positions, 0), '荤菜');
  assert.equal(homeMenuCategoryAtScroll(positions, 300), '荤菜');
  assert.equal(homeMenuCategoryAtScroll(positions, 475), '素菜');
  assert.equal(homeMenuCategoryAtScroll(positions, 880), '套餐');
  assert.equal(homeMenuCategoryAtScroll([], 0), '');
});

function setupMenu(entries = sample, layoutOptions = {}) {
  const props = reactive({ entries, selected: {}, category: '', search: '', busy: false, sharing: false, active: true, docked: false, scrollInset: layoutOptions.scrollInset ?? 125 });
  const sheetOpen = ref(false);
  const mounted = [];
  const unmounted = [];
  const events = [];
  const moves = [];
  const pageMoves = [];
  const scope = effectScope();
  const layout = { viewportHeight: 780, listTop: 280, groupHeight: 200, bottomPadding: 156, railContentHeight: 384, ...layoutOptions };
  let api;
  let model;
  let scrollTop = 0;
  let pageTop = 0;
  let measurements = 0;
  const frameHeight = () => Math.max(48, Math.min(layout.railContentHeight, layout.viewportHeight - props.scrollInset - layout.bottomPadding), layout.viewportHeight - layout.listTop - layout.bottomPadding);
  const maximumPage = () => Math.max(0, layout.listTop + frameHeight() + layout.bottomPadding - layout.viewportHeight);
  function lastGroupHeight() {
    if (!model.visibleGroups.value.length) return 0;
    return Math.max(layout.groupHeight, !props.search.trim() && hasDynamicTailInset ? frameHeight() : 0);
  }
  function maximumScroll() {
    const count = model.visibleGroups.value.length;
    return Math.max(0, (count ? (count - 1) * layout.groupHeight + lastGroupHeight() : 0) - frameHeight());
  }
  function pageScroll(top) {
    pageTop = Math.max(0, Math.min(maximumPage(), top));
    props.docked = pageTop >= maximumPage() - 1;
    api?.onScroll({ scrollTop: pageTop });
  }
  const bindings = {
    computed, ref, watch, HOME_MENU_CATEGORIES, firstHomeMenuCategory, groupHomeMenu, homeMenuCategoryAtScroll,
    afterNativeRender: async () => { await nextTick(); },
    sheetOpen, dismissFocusedKeyboard: () => {}, getCurrentInstance: () => ({ proxy: {} }),
    onMounted: callback => mounted.push(callback), onUnmounted: callback => unmounted.push(callback),
    defineProps: () => props,
    defineEmits: () => (name, value) => {
      events.push([name, value]);
      if (name === 'update:category') props.category = value;
      if (name === 'update:search') props.search = value;
      if (name === 'layout') props.docked = pageTop >= maximumPage() - 1;
      if (name === 'dock') { pageScroll(maximumPage()); pageMoves.push(pageTop); }
    },
    defineExpose: value => { api = value; },
    uni: {
      createSelectorQuery() {
        measurements += 1;
        return {
          in() { return this; }, select() { return this; }, selectAll() { return this; }, selectViewport() { return this; }, boundingClientRect() { return this; }, scrollOffset() { return this; },
          exec(callback) { queueMicrotask(() => callback([
            model.visibleGroups.value.map((group, index) => ({ id: group.id, top: layout.listTop - pageTop + index * layout.groupHeight - scrollTop })),
            { scrollTop }, { top: layout.listTop - pageTop, height: frameHeight() }, { height: layout.railContentHeight }, { scrollTop: pageTop },
          ])); },
        };
      },
    },
  };
  const script = parse(menuSource).descriptor.scriptSetup.content.replace(/^import .*;\s*$/gm, '');
  model = scope.run(() => new Function(...Object.keys(bindings), script + '\nreturn { visibleGroups, emptyMenu, menuStyle, listScrollTarget, scrollEnabled, openedKey, closeMenuActions, selectCategory, beginSearch, clearSearch, openCreateOptions, performEntryAction };')(...Object.values(bindings)));
  scope.run(() => watch(model.listScrollTarget, value => {
    const target = Math.max(0, Math.min(maximumScroll(), value));
    if (target !== scrollTop) { scrollTop = target; moves.push(target); api.onListScroll({ scrollTop }); }
  }, { flush: 'post' }));
  mounted.forEach(callback => callback());
  return {
    props, sheetOpen, events, moves, pageMoves, api, model, layout, frameHeight, lastGroupHeight, maximumScroll, maximumPage,
    scrollTop: () => scrollTop, pageTop: () => pageTop, measurements: () => measurements, pageScroll,
    scroll(top) { scrollTop = Math.max(0, Math.min(maximumScroll(), top)); api.onListScroll({ scrollTop }); },
    async settle() { for (let cycle = 0; cycle < 16; cycle += 1) { await nextTick(); await Promise.resolve(); } },
    destroy() { unmounted.forEach(callback => callback()); scope.stop(); },
  };
}

function renderedColumnGeometry(menu, property) {
  const declarations = Object.fromEntries(menuStyles.nodes.find(rule => rule.selector === '.home-menu').nodes.map(item => [item.prop, item.value]));
  const variables = { ...declarations, ...menu.model.menuStyle.value, '--home-menu-bottom-inset': menu.layout.bottomPadding + 'px' };
  const resolve = expression => expression.replace(/var\((--[\w-]+)(?:,\s*([^()]+))?\)/g, (_, name, fallback) => `(${resolve(variables[name] ?? fallback)})`);
  const resolved = resolve(variables[property]).replace(/100vh/g, String(menu.layout.viewportHeight)).replace(/px/g, '').replace(/\bcalc\(/g, '(').replace(/\b(min|max)\(/g, 'Math.$1(');
  const height = new Function('return ' + resolved)();
  const top = menu.layout.listTop - menu.pageTop();
  return { top, height, bottom: top + height };
}

const renderedRailGeometry = menu => renderedColumnGeometry(menu, '--home-menu-rail-height');
const renderedListGeometry = menu => renderedColumnGeometry(menu, '--home-menu-viewport-height');

test('outer scrolling still stops when categories fit without shifting the columns apart', async () => {
  const menu = setupMenu();
  try {
    await menu.settle();
    assert.equal(menu.model.scrollEnabled.value, false);
    assert.deepEqual(renderedRailGeometry(menu), { top: 280, height: 384, bottom: 664 });
    menu.pageScroll(40);
    assert.equal(menu.maximumPage(), 40);
    assert.equal(menu.model.scrollEnabled.value, true);
    assert.deepEqual(renderedRailGeometry(menu), { top: 240, height: 384, bottom: 624 });
    const measurements = menu.measurements();
    for (const position of [80, 400, 600, 200, 0]) {
      menu.scroll(position);
      menu.pageScroll(800);
      assert.equal(menu.pageTop(), 40);
      assert.deepEqual(renderedRailGeometry(menu), { top: 240, height: 384, bottom: 624 });
    }
    assert.equal(menu.measurements(), measurements);
    assert.deepEqual(menu.pageMoves, []);
  } finally { menu.destroy(); }
});

test('short screens cap both columns at the safe area instead of moving one column away', async () => {
  const menu = setupMenu(sample, { viewportHeight: 568, scrollInset: 193 });
  try {
    await menu.settle();
    menu.pageScroll(1000);
    assert.deepEqual(renderedRailGeometry(menu), { top: 193, height: 219, bottom: 412 });
    assert.equal(menu.layout.railContentHeight - menu.frameHeight(), 165);
    for (const top of [0, 100, 600]) {
      menu.scroll(top);
      assert.equal(menu.pageTop(), 87);
      assert.equal(renderedRailGeometry(menu).top, 193);
    }
  } finally { menu.destroy(); }
});

test('actual category height and selection dock determine the shared bounded viewport', async () => {
  const menu = setupMenu([], { viewportHeight: 932, listTop: 500, scrollInset: 227, bottomPadding: 190, railContentHeight: 416 });
  try {
    await menu.settle();
    assert.equal(menu.model.menuStyle.value['--home-menu-rail-content-height'], '416px');
    menu.pageScroll(1000);
    assert.deepEqual(renderedRailGeometry(menu), { top: 326, height: 416, bottom: 742 });
    menu.layout.bottomPadding = 92;
    menu.pageScroll(1000);
    assert.deepEqual(renderedRailGeometry(menu), { top: 424, height: 416, bottom: 840 });
    menu.layout.railContentHeight = 400;
    await menu.api.refreshLayout();
    menu.pageScroll(1000);
    assert.deepEqual(renderedRailGeometry(menu), { top: 440, height: 400, bottom: 840 });
    menu.layout.railContentHeight = 0;
    await menu.api.refreshLayout();
    assert.equal(menu.model.menuStyle.value['--home-menu-rail-content-height'], '400px');
  } finally { menu.destroy(); }
});

test('a category list already fully visible never requires the tabs to reach the screen top', async () => {
  const menu = setupMenu(sample, { viewportHeight: 1000 });
  try {
    await menu.settle();
    assert.equal(menu.maximumPage(), 0);
    assert.equal(menu.model.scrollEnabled.value, true);
    assert.deepEqual(renderedRailGeometry(menu), { top: 280, height: 384, bottom: 664 });
    assert.deepEqual(renderedListGeometry(menu), { top: 280, height: 564, bottom: 844 });
    assert.equal(menu.frameHeight(), renderedListGeometry(menu).height);
    menu.model.selectCategory('套餐');
    await menu.settle();
    assert.equal(menu.pageTop(), 0);
    assert.equal(menu.scrollTop(), 600);
    assert.equal(renderedRailGeometry(menu).top, 280);
  } finally { menu.destroy(); }
});

test('the dish list fills tall screens independently of category height and the selection dock', async () => {
  const menu = setupMenu(sample, { viewportHeight: 1000, bottomPadding: 124 });
  try {
    await menu.settle();
    for (const bottomPadding of [124, 190, 124]) {
      menu.layout.bottomPadding = bottomPadding;
      await menu.api.refreshLayout();
      assert.equal(renderedListGeometry(menu).bottom, 1000 - bottomPadding);
      assert.equal(renderedRailGeometry(menu).height, 384);
      assert.equal(menu.maximumPage(), 0);
      assert.equal(menu.pageTop(), 0);
    }
    menu.layout.railContentHeight = 320;
    await menu.api.refreshLayout();
    assert.equal(renderedRailGeometry(menu).height, 320);
    assert.equal(renderedListGeometry(menu).bottom, 876);
    assert.equal(menu.maximumPage(), 0);
  } finally { menu.destroy(); }
});

test('remeasuring after outer scroll preserves the document origin instead of growing the list again', async () => {
  const menu = setupMenu();
  try {
    await menu.settle();
    menu.pageScroll(40);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await menu.api.refreshLayout();
      assert.equal(menu.model.menuStyle.value['--home-menu-origin-top'], '280px');
      assert.equal(menu.maximumPage(), 40);
      assert.equal(renderedListGeometry(menu).height, 384);
    }
    menu.layout.viewportHeight = 1000;
    menu.pageScroll(0);
    await menu.api.refreshLayout();
    assert.deepEqual(renderedListGeometry(menu), { top: 280, height: 564, bottom: 844 });
    assert.equal(menu.model.scrollEnabled.value, true);
    menu.layout.viewportHeight = 568;
    menu.pageScroll(1000);
    await menu.api.refreshLayout();
    assert.equal(renderedListGeometry(menu).bottom, 412);
    assert.equal(renderedRailGeometry(menu).height, renderedListGeometry(menu).height);
  } finally { menu.destroy(); }
});

test('category jumps align headings within the right list, including the last short category', async () => {
  const menu = setupMenu();
  try {
    await menu.settle();
    menu.props.selected = { chicken: 1, 'set:dinner': 1 };
    for (const [category, target] of [['荤菜', 0], ['素菜', 200], ['其他', 400], ['套餐', 600]]) {
      menu.model.selectCategory(category);
      await menu.settle();
      assert.equal(menu.scrollTop(), target);
      assert.equal(menu.pageTop(), 40);
      assert.equal(menu.props.category, category);
      assert.equal(menu.model.visibleGroups.value.length, 4);
    }
    assert.equal(menu.lastGroupHeight(), 384);
    assert.equal(menu.maximumScroll(), 600);
    assert.deepEqual(menu.props.selected, { chicken: 1, 'set:dinner': 1 });
  } finally { menu.destroy(); }
});

test('outer scrolling never changes the active category or the right list position', async () => {
  const menu = setupMenu();
  try {
    await menu.settle();
    menu.scroll(290);
    assert.equal(menu.props.category, '素菜');
    const before = menu.measurements();
    for (const top of [0, 10, 20, 40]) menu.pageScroll(top);
    assert.equal(menu.props.category, '素菜');
    assert.equal(menu.scrollTop(), 290);
    assert.equal(menu.measurements(), before);
  } finally { menu.destroy(); }
});

test('empty categories keep both scroll positions and are still selectable', async () => {
  const menu = setupMenu();
  try {
    await menu.settle();
    menu.scroll(400);
    const pageTop = menu.pageTop();
    menu.model.selectCategory('饮品');
    await menu.settle();
    assert.equal(menu.scrollTop(), 400);
    assert.equal(menu.pageTop(), pageTop);
    assert.equal(menu.props.category, '饮品');
    assert.deepEqual(menu.pageMoves, []);
    menu.model.selectCategory('全部');
    assert.equal(menu.props.category, '饮品');
  } finally { menu.destroy(); }
});

test('repeat category taps and rapid navigation use the latest native list target', async () => {
  const menu = setupMenu();
  try {
    await menu.settle();
    menu.model.selectCategory('套餐');
    menu.model.selectCategory('素菜');
    await menu.settle();
    assert.deepEqual(menu.moves, [200]);
    menu.scroll(0);
    menu.model.selectCategory('素菜');
    await menu.settle();
    assert.equal(menu.scrollTop(), 200);
    assert.equal(menu.props.category, '素菜');
  } finally { menu.destroy(); }
});

test('the list tail follows the shared height while long categories remain scrollable', async () => {
  const menu = setupMenu();
  try {
    await menu.settle();
    for (const height of [844, 568, 960, 640]) {
      menu.layout.viewportHeight = height;
      menu.props.scrollInset = 213;
      menu.model.selectCategory('套餐');
      await menu.settle();
      assert.equal(menu.lastGroupHeight(), Math.max(200, menu.frameHeight()));
      assert.equal(menu.scrollTop(), 600);
    }
    menu.layout.groupHeight = 1100;
    menu.model.selectCategory('套餐');
    await menu.settle();
    assert.equal(menu.scrollTop(), 3300);
    assert.equal(menu.lastGroupHeight(), 1100);
    assert.ok(menu.maximumScroll() > 3300);
  } finally { menu.destroy(); }
});

test('a single short category still docks the outer page without adding outer tail whitespace', async () => {
  const menu = setupMenu([sample[0]], { groupHeight: 90 });
  try {
    await menu.settle();
    menu.model.selectCategory('套餐');
    await menu.settle();
    assert.equal(menu.scrollTop(), 0);
    assert.deepEqual(menu.pageMoves, [40]);
    assert.equal(menu.lastGroupHeight(), 384);
    assert.equal(menu.maximumPage(), 40);
  } finally { menu.destroy(); }
});

test('search starts at the right list top and clearing restores the original category and offset', async () => {
  const menu = setupMenu();
  try {
    await menu.settle();
    menu.props.selected = { chicken: 1 };
    menu.scroll(290);
    menu.model.beginSearch();
    menu.props.search = '不存在';
    await menu.settle();
    assert.equal(menu.scrollTop(), 0);
    assert.equal(menu.model.visibleGroups.value.length, 0);
    assert.equal(menu.pageTop(), 0);
    menu.model.clearSearch();
    await menu.settle();
    assert.equal(menu.scrollTop(), 290);
    assert.equal(menu.props.category, '素菜');
    assert.deepEqual(menu.props.selected, { chicken: 1 });
    assert.deepEqual(menu.pageMoves, []);
  } finally { menu.destroy(); }
});

test('empty categories exit search without empty groups or moving either viewport', async () => {
  const menu = setupMenu();
  try {
    await menu.settle();
    menu.model.beginSearch();
    menu.props.search = '番茄';
    await menu.settle();
    assert.deepEqual(menu.model.visibleGroups.value.map(group => group.category), ['素菜', '套餐']);
    menu.model.selectCategory('饮品');
    await menu.settle();
    assert.equal(menu.props.category, '饮品');
    assert.equal(menu.props.search, '');
    assert.deepEqual(menu.model.visibleGroups.value.map(group => group.category), ['荤菜', '素菜', '其他', '套餐']);
    assert.deepEqual(menu.pageMoves, []);
  } finally { menu.destroy(); }
});

test('empty and search-result menus do not add last-category whitespace outside the scroller', async () => {
  const menu = setupMenu([]);
  try {
    await menu.settle();
    assert.equal(menu.model.emptyMenu.value, true);
    assert.deepEqual(menu.model.visibleGroups.value, []);
    assert.equal(menu.maximumPage(), 40);
    assert.match(menuSource, /<HomeWelcome v-if="emptyMenu && !query"/);
    assert.match(menuSource, /@secondary="\$emit\('discover'\)"/);
    assert.match(homeSource, /@discover="discoverFood"/);
    menu.props.entries = sample;
    menu.props.search = '番茄';
    await menu.settle();
    assert.equal(menu.lastGroupHeight(), 200);
    assert.equal(menu.maximumPage(), 40);
  } finally { menu.destroy(); }
});

test('sheets cancel pending navigation and freeze both native scrollers until closed', async () => {
  const menu = setupMenu();
  try {
    await menu.settle();
    menu.model.selectCategory('套餐');
    menu.sheetOpen.value = true;
    await menu.settle();
    assert.deepEqual(menu.moves, []);
    assert.deepEqual(menu.pageMoves, []);
    assert.equal(menu.model.scrollEnabled.value, false);
    menu.sheetOpen.value = false;
    menu.model.selectCategory('套餐');
    await menu.settle();
    assert.equal(menu.scrollTop(), 600);
    assert.equal(menu.model.scrollEnabled.value, true);
  } finally { menu.destroy(); }
});

test('switching to kitchen keeps the mounted list position and ignores hidden gestures', async () => {
  const menu = setupMenu();
  try {
    await menu.settle();
    menu.scroll(290);
    menu.props.active = false;
    menu.scroll(0);
    menu.api.scrollPage({ distance: -40, start: true });
    await menu.settle();
    assert.equal(menu.model.scrollEnabled.value, false);
    assert.equal(menu.props.category, '素菜');
    assert.ok(!menu.events.some(([name]) => name === 'page-drag'));
    menu.props.active = true;
    await menu.settle();
    assert.equal(menu.scrollTop(), 290);
    assert.match(homeSource, /<view v-show="tab === 'menu'" class="menu-view">/);
    assert.match(homeSource, /<HomeMenu[^>]*:active="tab === 'menu'"/);
  } finally { menu.destroy(); }
});

test('unmounting discards pending category navigation', async () => {
  const menu = setupMenu();
  await menu.settle();
  menu.model.selectCategory('套餐');
  menu.destroy();
  await menu.settle();
  assert.deepEqual(menu.moves, []);
  assert.deepEqual(menu.pageMoves, []);
});

test('native list scrolling tracks cached section boundaries without queries per frame', async () => {
  const menu = setupMenu();
  try {
    await menu.settle();
    const before = menu.measurements();
    for (let top = 0; top < 600; top += 1) menu.scroll(top);
    assert.equal(menu.measurements(), before);
    assert.ok(menu.events.filter(([name]) => name === 'update:category').length < 10);
    menu.sheetOpen.value = true;
    const category = menu.props.category;
    menu.scroll(0);
    assert.equal(menu.props.category, category);
  } finally { menu.destroy(); }
});

test('the plus opens creation choices without an edit mode, preserves selection and respects pending removal', async () => {
  const menu = setupMenu();
  try {
    menu.props.selected = { chicken: 1, 'set:dinner': 1 };
    menu.props.category = '饮品';
    menu.model.openedKey.value = 'chicken';
    menu.model.openCreateOptions();
    assert.deepEqual(menu.events.at(-1), ['create', '饮品']);
    assert.equal(menu.model.openedKey.value, '');
    assert.deepEqual(menu.props.selected, { chicken: 1, 'set:dinner': 1 });
    menu.props.busy = true;
    const count = menu.events.length;
    menu.model.openCreateOptions();
    assert.equal(menu.events.length, count);
    menu.props.busy = false;
    menu.model.openCreateOptions();
    assert.equal(menu.events.length, count + 1);
    assert.deepEqual(menu.props.selected, { chicken: 1, 'set:dinner': 1 });
    assert.match(homeSource, /@edit-entry="editEntry" @share-entry="shareEntry" @remove-entry="remove"/);
    assert.match(homeSource, /function editEntry\(entry\) \{ if \(entry.kind === 'set'\) createSet\(entry\); else createDish\(entry\); \}/);
  } finally { menu.destroy(); }
});

test('new home view retains original order, sharing, editor, delete and page locking owners', () => {
  assert.match(homeSource, /pageLock\.onScroll\(event\); homeMenu\.value\?\.onScroll\(event\)/);
  assert.match(homeSource, /onReachBottom\(\(\) => \{ if \(tab.value === 'community'\) communityView\.value\?\.loadMore\(\); \}\)/);
  assert.match(homeSource, /await presentMutation\(submitOrder\(cart\.value, selection\.value, note\.value\)/);
  assert.match(homeSource, /await presentMutation\(removeFamilyEntry\(entry\.id, entry\.kind\)/);
  assert.match(homeSource, /@open="openEntry" @toggle="toggleSelection"/);
  assert.match(homeSource, /:initial-category="creationCategory"/);
  for (const name of ['RecipeSheet', 'SetSheet']) {
    const source = readFileSync(new URL(`../src/components/${name}.vue`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /removable|menu-entry-remove/);
    assert.match(source, /<FoodDetailSheet[^>]*@edit="\$emit\('edit',/);
    assert.match(source, /MenuDetailActions :selected="selected" :busy="props.busy"/);
    assert.match(source, /useFriendShare/);
  }
});

test('menu actions close on scrolling, category changes, search and sheets without mutating the selection', async () => {
  const menu = setupMenu();
  try {
    await menu.settle();
    menu.props.selected = { chicken: 1 };
    for (const close of [() => menu.scroll(100), () => menu.model.selectCategory('素菜'), () => menu.model.beginSearch(), () => menu.model.closeMenuActions(), () => { menu.sheetOpen.value = true; }]) {
      menu.model.openedKey.value = 'chicken';
      close();
      await menu.settle();
      assert.equal(menu.model.openedKey.value, '');
      assert.deepEqual(menu.props.selected, { chicken: 1 });
    }
    assert.doesNotMatch(menuSource, /home-menu-entry-actions|v-if="editing"/);
    assert.match(menuSource, /:opened="openedKey === entry.key"/);
  } finally { menu.destroy(); }
});

test('sharing preserves the source swipe through preparation, nested sheets and dismissal without moving the list', async () => {
  const menu = setupMenu();
  try {
    await menu.settle();
    const entry = menu.props.entries.find(item => item.key === 'chicken');
    menu.model.openedKey.value = entry.key;
    menu.model.performEntryAction('share-entry', entry);
    assert.equal(menu.model.openedKey.value, entry.key);
    assert.deepEqual(menu.events.at(-1), ['share-entry', entry]);
    menu.props.sharing = true;
    menu.props.busy = true;
    await menu.settle();
    const originalScroll = menu.scrollTop();
    const originalPage = menu.pageTop();
    menu.sheetOpen.value = true;
    menu.props.busy = false;
    menu.props.entries = [...menu.props.entries];
    await menu.settle();
    assert.equal(menu.model.openedKey.value, entry.key);
    assert.equal(menu.model.scrollEnabled.value, false);
    menu.props.sharing = false;
    menu.sheetOpen.value = false;
    await menu.settle();
    assert.equal(menu.model.openedKey.value, entry.key);
    assert.equal(menu.scrollTop(), originalScroll);
    assert.equal(menu.pageTop(), originalPage);
    menu.sheetOpen.value = true;
    assert.equal(menu.model.openedKey.value, '');
    assert.match(homeSource, /:sharing="Boolean\(swipeSharing \|\| friendSharing \|\| sharing\)"/);
    assert.match(menuSource, /:busy="busy" :sharing="sharing"/);
  } finally { menu.destroy(); }
});

test('sharing cannot preserve a removed row and non-share actions still close it', async () => {
  const menu = setupMenu();
  try {
    await menu.settle();
    const entry = menu.props.entries.find(item => item.key === 'chicken');
    for (const action of ['open', 'toggle', 'edit-entry', 'remove-entry']) {
      menu.model.openedKey.value = entry.key;
      menu.model.performEntryAction(action, entry);
      assert.equal(menu.model.openedKey.value, '');
    }
    menu.props.sharing = true;
    menu.model.openedKey.value = entry.key;
    menu.props.entries = menu.props.entries.filter(item => item.key !== entry.key);
    await menu.settle();
    assert.equal(menu.model.openedKey.value, '');
  } finally { menu.destroy(); }
});

test('category headings belong only to populated groups and follow search without losing selection', async () => {
  const menu = setupMenu();
  try {
    await menu.settle();
    menu.props.selected = { chicken: 1, 'set:dinner': 1 };
    const groupNames = () => menu.model.visibleGroups.value.map(group => group.category);
    assert.deepEqual(groupNames(), ['荤菜', '素菜', '其他', '套餐']);
    menu.model.selectCategory('饮品');
    await menu.settle();
    assert.equal(menu.props.category, '饮品');
    assert.deepEqual(groupNames(), ['荤菜', '素菜', '其他', '套餐']);
    menu.props.search = '番茄';
    await menu.settle();
    assert.deepEqual(groupNames(), ['素菜', '套餐']);
    menu.props.search = '没有这道菜';
    await menu.settle();
    assert.deepEqual(groupNames(), []);
    menu.model.clearSearch();
    await menu.settle();
    assert.deepEqual(groupNames(), ['荤菜', '素菜', '其他', '套餐']);
    assert.deepEqual(menu.props.selected, { chicken: 1, 'set:dinner': 1 });
    assert.match(menuSource, /v-for="group in visibleGroups"[^>]*>\s*<view class="home-menu-group-heading" role="heading" aria-level="2">\{\{ group\.category \}\}<\/view>\s*<MenuSwipeRow/);
    assert.equal((menuSource.match(/class="home-menu-group-heading"/g) || []).length, 1);
  } finally { menu.destroy(); }
});
