import test from 'node:test';
import assert from 'node:assert/strict';
import { ref, effectScope, nextTick } from 'vue';
import { useKitchenFocus, kitchenOrderAnchor } from '../src/composables/useKitchenFocus.js';

const flush = async () => { await nextTick(); await new Promise(resolve => setImmediate(resolve)); };
function fixture(scroll) {
  const scope = effectScope();
  const orders = ref([{ id: 'meal-1' }, { id: 'meal-2' }]);
  const visible = ref(true);
  const locked = ref(false);
  const anchors = [];
  const controller = scope.run(() => useKitchenFocus(orders, visible, locked, scroll || ((anchor, isCurrent) => { if (isCurrent()) anchors.push(anchor); })));
  return { ...controller, orders, visible, locked, anchors, stop: () => scope.stop() };
}

test('go-to-meal waits until checkout unlocks, then locates the specific card once', async () => {
  const current = fixture();
  current.locked.value = true;
  current.focus('meal-2');
  await flush();
  assert.deepEqual(current.anchors, []);
  current.locked.value = false;
  await flush();
  assert.deepEqual(current.anchors, [kitchenOrderAnchor(1)]);
  current.orders.value = [...current.orders.value];
  current.locked.value = true; await flush(); current.locked.value = false; await flush();
  assert.equal(current.anchors.length, 1, 'a later detail sheet or data refresh must not yank the page back');
  current.focus('meal-2'); await flush();
  assert.equal(current.anchors.length, 2, 'an explicit second navigation can locate the same meal again');
  current.stop();
});

test('kitchen focus uses the new order after sorting, never unsafe IDs as selectors', async () => {
  const current = fixture();
  current.locked.value = true; current.focus('meal-2'); await flush();
  current.orders.value = [{ id: 'meal-2' }, { id: 'meal-1' }];
  current.locked.value = false; await flush();
  assert.deepEqual(current.anchors, ['kitchen-meal-0']);
  assert.match(kitchenOrderAnchor(12), /^[a-z][\w-]+$/);
  current.stop();
});

test('closing, changing pages or switching families invalidates a deferred geometry query', async () => {
  for (const action of ['cancel', 'page', 'stop']) {
    let valid;
    const current = fixture((anchor, isCurrent) => { valid = isCurrent; return new Promise(() => {}); });
    current.focus('meal-2'); await flush();
    assert.equal(valid(), true);
    if (action === 'page') current.visible.value = false;
    else if (action === 'stop') current.stop();
    else current.cancel();
    await flush();
    assert.equal(valid(), false);
    if (action !== 'stop') current.stop();
  }
});

test('rapid requests keep only the last meal, and removed orders are not scrolled to', async () => {
  const current = fixture();
  current.focus('meal-1'); current.focus('meal-2'); await flush();
  assert.deepEqual(current.anchors, ['kitchen-meal-1']);
  current.focus('removed'); await flush();
  assert.equal(current.anchors.length, 1);
  assert.equal(current.focusedId.value, '');
  current.stop();
});

test('procurement reuses meal focus with its own anchors and component scope', async () => {
  const scope = effectScope();
  const component = { id: 'shopping-component' };
  const scrolls = [];
  const anchor = index => `shopping-meal-${index}`;
  const orders = ref([{ id: 'breakfast' }, { id: 'dinner' }]);
  const visible = ref(true);
  const controller = scope.run(() => useKitchenFocus(orders, visible, ref(false), (target, isCurrent, options) => {
    if (isCurrent()) scrolls.push({ target, component: options.scope });
  }, { anchor, scope: component }));
  controller.focus('dinner');
  await flush();
  assert.deepEqual(scrolls, [{ target: 'shopping-meal-1', component }]);
  orders.value = [...orders.value];
  await flush();
  assert.equal(scrolls.length, 1);
  visible.value = false;
  await flush();
  assert.equal(controller.focusedId.value, '');
  scope.stop();
});

test('the first procurement group stays at page top while later groups still get located', async context => {
  const originalUni = globalThis.uni;
  context.after(() => { globalThis.uni = originalUni; });
  const scope = effectScope();
  const moves = [];
  const anchors = [];
  globalThis.uni = { pageScrollTo: options => moves.push(options) };
  const controller = scope.run(() => useKitchenFocus(ref([{ id: 'breakfast' }, { id: 'dinner' }]), ref(true), ref(false), (anchor, isCurrent) => {
    if (isCurrent()) anchors.push(anchor);
  }, { firstAtTop: true, anchor: index => `shopping-meal-${index}` }));
  try {
    controller.focus('breakfast');
    await flush();
    assert.deepEqual(moves, [{ scrollTop: 0, duration: 0 }]);
    assert.deepEqual(anchors, []);
    controller.focus('dinner');
    await flush();
    assert.deepEqual(anchors, ['shopping-meal-1']);
    assert.equal(moves.length, 1);
  } finally { scope.stop(); }
});

test('default meal navigation keeps the card below the page header and the WeChat capsule', async context => {
  const originalUni = globalThis.uni;
  context.after(() => { globalThis.uni = originalUni; });
  for (const native of [false, true]) {
    const moves = [];
    const selectors = [];
    const scope = effectScope();
    globalThis.uni = {
      getSystemInfoSync: () => ({ windowWidth: 390, statusBarHeight: 44, uniPlatform: native ? 'mp-weixin' : 'h5' }),
      getMenuButtonBoundingClientRect: () => ({ bottom: 76 }),
      createSelectorQuery: () => ({
        select(selector) { selectors.push(selector); return this; },
        boundingClientRect() { return this; }, selectViewport() { return this; }, scrollOffset() { return this; },
        exec(callback) { callback([{ top: 440 }, { scrollTop: 300 }]); },
      }),
      pageScrollTo: options => moves.push(options),
    };
    try {
      const focus = scope.run(() => useKitchenFocus(ref([{ id: 'meal-1' }, { id: 'meal-2' }]), ref(true), ref(false)));
      focus.focus('meal-2');
      await flush();
      assert.deepEqual(selectors, ['#kitchen-meal-1']);
      assert.deepEqual(moves, [{ scrollTop: 740 - (native ? 100 : 64), duration: 0 }]);
    } finally { scope.stop(); }
  }
});
