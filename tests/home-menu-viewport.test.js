import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope, nextTick, ref } from 'vue';
import { homeMenuGeometry } from '../src/domain/home-menu.js';
import { useHomeMenuViewport } from '../src/composables/useHomeMenuViewport.js';

const flush = async () => { await nextTick(); await new Promise(resolve => setImmediate(resolve)); };

function fixture(context, options = {}) {
  const originalUni = globalThis.uni;
  const scope = effectScope();
  const visible = ref(options.visible ?? true);
  const locked = ref(false);
  const layout = { panelTop: 280, menuBottom: 884, scrollTop: 0, windowInfo: { windowWidth: 390, windowHeight: 844, uniPlatform: 'h5' }, capsule: null, defer: false, ...options };
  const moves = [];
  const pending = [];
  let measurements = 0;
  let controller;
  globalThis.uni = {
    getSystemInfoSync: () => layout.windowInfo,
    getMenuButtonBoundingClientRect: () => layout.capsule,
    createSelectorQuery() {
      measurements += 1;
      return {
        in() { return this; }, select() { return this; }, selectViewport() { return this; }, boundingClientRect() { return this; }, scrollOffset() { return this; },
        exec(callback) {
          const complete = () => callback([{ top: layout.panelTop - layout.scrollTop }, { scrollTop: layout.scrollTop }, layout.noContent ? null : { bottom: layout.menuBottom - layout.scrollTop }]);
          if (layout.defer) pending.push(complete);
          else queueMicrotask(complete);
        },
      };
    },
    pageScrollTo({ scrollTop, duration }) {
      assert.equal(duration, 0);
      moves.push(scrollTop);
      if (!layout.delayScroll) { layout.scrollTop = scrollTop; controller.onScroll({ scrollTop }); }
    },
  };
  controller = scope.run(() => useHomeMenuViewport(visible, locked));
  context.after(() => { scope.stop(); globalThis.uni = originalUni; });
  return {
    ...controller, visible, locked, layout, moves, pending,
    measurements: () => measurements,
    scroll(scrollTop) { layout.scrollTop = scrollTop; controller.onScroll({ scrollTop }); },
    stop: () => scope.stop(),
  };
}

test('home workspace geometry keeps browser and WeChat controls below their native safe area', () => {
  assert.deepEqual(homeMenuGeometry(), { safeTop: 0, headerHeight: 52, toolsHeight: 54, searchTop: 52, listTop: 106, kitchenTop: 64 });
  assert.equal(homeMenuGeometry({ windowWidth: 760 }).listTop, 106);
  assert.equal(homeMenuGeometry({ windowWidth: 1024 }).listTop, 124);
  assert.equal(homeMenuGeometry({ screenWidth: 1024 }).toolsHeight, 60);
  const native = homeMenuGeometry({ uniPlatform: 'mp-weixin', statusBarHeight: 44, windowWidth: 390 }, { bottom: 76 });
  assert.deepEqual(native, { safeTop: 88, headerHeight: 88, toolsHeight: 54, searchTop: 88, listTop: 142, kitchenTop: 100 });
  assert.equal(homeMenuGeometry({ uniPlatform: 'mp-weixin', statusBarHeight: 44 }).safeTop, 100);
});

test('menu docking uses the content bottom without a removed tab offset', async context => {
  const current = fixture(context);
  await flush();
  assert.equal(current.measurements(), 1);
  assert.equal(current.style.value['--home-menu-list-top'], '106px');
  assert.equal(current.style.value['--home-menu-tabs-height'], undefined);
  current.scroll(38);
  assert.equal(current.docked.value, false);
  current.scroll(40);
  assert.equal(current.docked.value, true);
  for (const top of [40, 35, 20, 0]) current.scroll(top);
  assert.equal(current.measurements(), 1);
  assert.equal(current.docked.value, false);
  assert.deepEqual(current.moves, []);
  await current.dock();
  assert.deepEqual(current.moves, [40]);
  assert.equal(current.docked.value, true);
});

test('kitchen navigation does not receive menu page scroll commands', async context => {
  const current = fixture(context);
  await flush();
  current.scroll(40);
  current.visible.value = false;
  await flush();
  assert.deepEqual(current.moves, []);
  assert.equal(current.docked.value, false);
  current.scroll(520);
  current.scrollPage({ distance: -100, start: true });
  await current.dock();
  assert.deepEqual(current.moves, []);
  current.layout.scrollTop = 0;
  current.visible.value = true;
  await flush();
  await current.dock();
  assert.deepEqual(current.moves, [40]);
  assert.equal(current.docked.value, true);
});

test('leaving and returning remeasures without forcing a page scroll', async context => {
  const current = fixture(context);
  await flush();
  current.scroll(20);
  current.visible.value = false;
  await flush();
  current.visible.value = true;
  await flush();
  assert.deepEqual(current.moves, []);
  assert.equal(current.layout.scrollTop, 20);
  assert.equal(current.pinned.value, false);
});

test('resize remeasures the real menu bottom as well as the WeChat safe area', async context => {
  const current = fixture(context);
  await flush();
  current.layout.windowInfo = { uniPlatform: 'mp-weixin', statusBarHeight: 44, windowWidth: 390, windowHeight: 568 };
  current.layout.capsule = { bottom: 76 };
  current.layout.menuBottom = 760;
  await current.refresh();
  assert.equal(current.listInset.value, 142);
  assert.equal(current.style.value['--home-menu-safe-top'], '88px');
  current.scroll(192);
  assert.equal(current.docked.value, true);
  await current.dock();
  assert.equal(current.moves.at(-1), 192);
  current.layout.windowInfo = { uniPlatform: 'h5', windowWidth: 1024, windowHeight: 844 };
  current.layout.menuBottom = 884;
  await current.refresh();
  assert.equal(current.listInset.value, 124);
  assert.equal(current.pinned.value, true);
  await current.dock();
  assert.equal(current.moves.at(-1), 40);
});

test('a fully visible category column needs no outer scroll at all', async context => {
  const current = fixture(context, { menuBottom: 700 });
  await flush();
  assert.equal(current.docked.value, true);
  await current.dock();
  assert.deepEqual(current.moves, [0]);
});

test('missing menu geometry never falls back to forcing the tabs to the top', async context => {
  const current = fixture(context, { noContent: true });
  await flush();
  await current.dock();
  assert.equal(current.docked.value, false);
  assert.deepEqual(current.moves, []);
  current.layout.noContent = false;
  await current.dock();
  assert.deepEqual(current.moves, [40]);
});

test('rapid navigation away and back never scrolls the new page', async context => {
  const current = fixture(context);
  await flush();
  current.scroll(40);
  current.visible.value = false;
  current.visible.value = true;
  await flush();
  assert.deepEqual(current.moves, []);
  assert.equal(current.docked.value, true);
});

test('simultaneous child layout requests share one measurement and preserve docking', async context => {
  const current = fixture(context);
  await flush();
  current.scroll(40);
  const first = current.refresh();
  const second = current.refresh();
  assert.equal(first, second);
  await flush();
  assert.deepEqual(current.moves, []);
  assert.equal(current.docked.value, true);
  await current.dock();
  assert.deepEqual(current.moves, [40]);
});

test('pulling down from the list top never exceeds either measured page boundary', async context => {
  const current = fixture(context);
  await flush();
  current.scroll(40);
  current.scrollPage({ distance: -15, start: true });
  current.scrollPage({ distance: -10, start: false });
  current.scrollPage({ distance: 500, start: false });
  current.scrollPage({ distance: -500, start: false });
  assert.deepEqual(current.moves, [25, 15, 40, 0]);
  assert.equal(current.docked.value, false);
});

test('page drag deltas accumulate even before the previous native scroll event returns', async context => {
  const current = fixture(context, { delayScroll: true });
  await flush();
  current.scroll(40);
  current.scrollPage({ distance: -10, start: true });
  current.scrollPage({ distance: -10, start: false });
  current.scrollPage({ distance: -10, start: false });
  assert.deepEqual(current.moves, [30, 20, 10]);
});

test('opening a sheet cancels pending docking and unlock only remeasures', async context => {
  const current = fixture(context);
  await flush();
  current.scroll(40);
  current.dock();
  current.locked.value = true;
  await flush();
  current.scrollPage({ distance: -20, start: true });
  assert.deepEqual(current.moves, []);
  current.scroll(0);
  assert.equal(current.pinned.value, true);
  current.layout.scrollTop = 40;
  current.locked.value = false;
  await flush();
  assert.equal(current.docked.value, true);
  assert.deepEqual(current.moves, []);
});

test('leaving the page clears boundaries and ignores stale native measurement callbacks', async context => {
  const current = fixture(context, { visible: false });
  await flush();
  assert.equal(current.measurements(), 0);
  current.visible.value = true;
  await flush();
  current.scroll(40);
  current.layout.defer = true;
  const refreshing = current.refresh();
  await flush();
  current.visible.value = false;
  await flush();
  current.pending.shift()();
  await refreshing;
  assert.equal(current.docked.value, false);
  current.scrollPage({ distance: -20, start: true });
  assert.deepEqual(current.moves, []);
  current.layout.defer = false;
  current.layout.scrollTop = 0;
  current.visible.value = true;
  await flush();
  assert.equal(current.docked.value, false);
});

test('unmounting cancels pending docking and rejects subsequent gestures', async context => {
  const current = fixture(context);
  await flush();
  current.scroll(40);
  current.dock();
  current.stop();
  await flush();
  current.scrollPage({ distance: -10, start: true });
  assert.deepEqual(current.moves, []);
});
