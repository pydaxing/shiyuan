import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parse, compileTemplate } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import sharp from 'sharp';
import postcss from 'postcss';
import { orderMenuActions, orderMenuGeometry, orderMenuIcon } from '../src/domain/order-action-menu.js';
import { NATIVE_UI_COLORS } from '../src/domain/ui-theme.js';

const source = readFileSync(new URL('../src/components/OrderActionMenu.vue', import.meta.url), 'utf8');
const page = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8');
const descriptor = parse(source).descriptor;
const compiled = compileTemplate({ source: descriptor.template.content, filename: 'OrderActionMenu.vue', id: 'order-menu-test' });
assert.deepEqual(compiled.errors, []);
const renderCode = compiled.code.replace(/import \{([^}]+)\} from "vue"/g, (_, imports) => `const {${imports.replace(/ as /g, ': ')}} = Vue;`).replace('export function render', 'return function render');
const renderTemplate = new Function('Vue', renderCode)({ ...Vue, resolveComponent: name => name });
const setupCode = descriptor.scriptSetup.content.replace(/^import .*;\s*$/gm, '');
const viewport = { windowWidth: 390, windowHeight: 700 };
const anchor = { left: 300, right: 344, top: 160, bottom: 204 };

function nodes(node) {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== 'object') return [];
  return [node, ...(Array.isArray(node.children) ? node.children.flatMap(nodes) : typeof node.children?.default === 'function' ? nodes(node.children.default()) : [])];
}

function menu({ status = 'accepted', busy = false, deferred = false, invalid = false, actions, floating = false, hasDishes = true } = {}) {
  const props = Vue.reactive({ label: '今天晚餐', status, opened: false, busy, actions, floating, hasDishes });
  const events = [];
  const queries = [];
  const resizes = new Set();
  const focused = [];
  let cleanup;
  const scope = Vue.effectScope();
  const bindings = {
    computed: Vue.computed,
    nextTick: Vue.nextTick,
    ref: Vue.ref,
    watch: Vue.watch,
    defineProps: () => props,
    defineEmits: () => action => {
      events.push(action);
      if (action === 'activate') props.opened = true;
      if (action === 'close') props.opened = false;
    },
    getCurrentInstance: () => ({ uid: 42, proxy: {} }),
    onUnmounted: callback => { cleanup = callback; },
    afterNativeRender: async () => Vue.nextTick(),
    orderMenuActions,
    orderMenuGeometry,
    uni: {
      createSelectorQuery() {
        let measure;
        return {
          in() { return this; },
          select(selector) { assert.equal(selector, '.order-more-button'); return this; },
          boundingClientRect(callback) { measure = callback; return this; },
          exec() { queries.push(measure); if (!deferred) measure(invalid ? null : anchor); },
        };
      },
      getWindowInfo: () => viewport,
      onWindowResize: callback => resizes.add(callback),
      offWindowResize: callback => resizes.delete(callback),
    },
  };
  const setup = new Function(...Object.keys(bindings), `${setupCode}\nreturn { props, layout, options, menuId, menuStyle, highlighted, triggerRef, menuRef, toggle, close, choose, onTriggerKey, onMenuKey, positionMenu };`);
  const context = scope.run(() => setup(...Object.values(bindings)));
  context.triggerRef.value = { focus: () => focused.push('trigger') };
  context.menuRef.value = { querySelectorAll: () => context.options.value.map(option => ({ focus: () => focused.push(option.action) })) };
  const settle = async () => { for (let count = 0; count < 8; count += 1) await Vue.nextTick(); };
  const draw = () => nodes(renderTemplate(Vue.proxyRefs({ ...props, ...context, orderMenuIcon }), []));
  const find = className => draw().find(node => node.props?.class?.split(' ').includes(className));
  const press = (key, onTrigger = false) => {
    let prevented = false;
    (onTrigger ? context.onTriggerKey : context.onMenuKey)({ key, preventDefault() { prevented = true; } });
    return prevented;
  };
  return { props, context, events, queries, resizes, focused, settle, draw, find, press, open: async () => { context.toggle(); await settle(); }, dispose() { cleanup(); scope.stop(); } };
}

test('preparing menus show cancel then delete, cancelled menus restore then delete, completed only delete', () => {
  for (const status of ['pending', 'accepted']) assert.deepEqual(orderMenuActions(status), [{ action: 'cancel', label: '取消' }, { action: 'remove', label: '删除' }]);
  assert.deepEqual(orderMenuActions('cancelled'), [{ action: 'restore', label: '恢复' }, { action: 'remove', label: '删除' }]);
  assert.deepEqual(orderMenuActions('completed'), [{ action: 'remove', label: '删除' }]);
});

test('empty cancelled meals keep delete but never offer a restore that resurrects removed dishes', async () => {
  const actions = orderMenuActions('cancelled', false);
  assert.deepEqual(actions, [{ action: 'remove', label: '删除' }]);
  const control = menu({ status: 'cancelled', hasDishes: false });
  await control.open();
  assert.deepEqual(control.context.options.value, actions);
  control.context.choose('restore');
  assert.equal(control.events.includes('restore'), false);
  control.context.choose('remove');
  assert.deepEqual(control.events.slice(-2), ['close', 'remove']);
  assert.match(page, /:has-dishes="order.items.length > 0"/);
  assert.match(page, /v-if="!order.items.length" class="muted">本餐暂无菜品/);
  control.dispose();
});

test('an open cancelled-meal menu closes when its dishes disappear', async () => {
  const control = menu({ status: 'cancelled' });
  await control.open();
  assert.equal(control.props.opened, true);
  control.props.hasDishes = false;
  await control.settle();
  assert.equal(control.props.opened, false);
  assert.deepEqual(control.context.options.value, [{ action: 'remove', label: '删除' }]);
  control.dispose();
});

test('food-detail bubbles accept only permitted edit/delete actions without adding order operations', async () => {
  const actions = [{ action: 'edit', label: '编辑' }, { action: 'remove', label: '删除' }];
  const control = menu({ actions, floating: true });
  await control.open();
  assert.deepEqual(control.context.options.value, actions);
  assert.ok(control.find('order-menu-root').props.class.includes('is-floating-menu'));
  control.context.choose('cancel');
  assert.equal(control.events.includes('cancel'), false);
  control.context.choose('edit');
  assert.deepEqual(control.events.slice(-2), ['close', 'edit']);
  await control.open();
  control.props.label = '另一道菜';
  await control.settle();
  assert.equal(control.props.opened, false);
  control.dispose();
});

test('bubble aligns to the right trigger and its pointer stays centered on the dots', () => {
  assert.deepEqual(orderMenuGeometry(anchor, viewport, 2), { top: 210, left: 216, width: 128, height: 98, pointer: 106, placement: 'below' });
  assert.equal(orderMenuGeometry(anchor, viewport, 1).height, 54);
});

test('bubble flips above bottom cards and clamps to narrow screen edges without clipping its pointer', () => {
  const bottom = orderMenuGeometry({ ...anchor, top: 640, bottom: 684 }, viewport, 2);
  assert.equal(bottom.placement, 'above');
  assert.equal(bottom.top, 536);
  for (const windowWidth of [180, 320, 375, 390]) {
    for (const left of [-10, 12, windowWidth - 44]) {
      const geometry = orderMenuGeometry({ ...anchor, left, right: left + 44 }, { ...viewport, windowWidth }, 2);
      assert.ok(geometry.left >= 12);
      assert.ok(geometry.left + geometry.width <= windowWidth - 12);
      assert.ok(geometry.pointer >= 12 && geometry.pointer <= geometry.width - 12);
    }
  }
});

test('unmeasurable and offscreen triggers do not create floating menus', () => {
  for (const rect of [null, {}, { ...anchor, top: NaN }, { ...anchor, left: 500, right: 544 }, { ...anchor, bottom: -1 }, { ...anchor, top: 720, bottom: 764 }]) assert.equal(orderMenuGeometry(rect, viewport, 2), null);
  assert.equal(orderMenuGeometry(anchor, viewport, 0), null);
  assert.equal(orderMenuGeometry(anchor, { windowWidth: 20, windowHeight: 700 }, 2), null);
  assert.equal(orderMenuGeometry({ left: 12, right: 56, top: 65, bottom: 109 }, { windowWidth: 320, windowHeight: 180 }, 2), null);
});

test('the dots are a real accessible button and opening only reveals a measured menu', async () => {
  const control = menu();
  assert.equal(control.find('order-menu-popover'), undefined);
  const trigger = control.find('order-more-button');
  assert.equal(trigger.type, 'button');
  assert.equal(trigger.props['aria-haspopup'], 'menu');
  assert.equal(trigger.props['aria-label'], '今天晚餐的更多操作');
  trigger.props.onClick({ stopPropagation() {} });
  await control.settle();
  assert.deepEqual(control.events, ['activate']);
  assert.equal(control.find('order-more-button').props['aria-expanded'], true);
  assert.deepEqual(control.find('order-menu-popover').props.style, { top: '210px', left: '216px', width: '128px', height: '98px' });
  assert.equal(control.find('order-menu-pointer').props.style.left, '106px');
  assert.deepEqual(control.draw().filter(node => node.props?.role === 'menuitem').map(node => nodes(node).find(child => child.type === 'text').children), ['取消', '删除']);
  assert.equal(control.focused.at(-1), 'cancel');
  control.dispose();
});

test('outside taps and a second trigger tap dismiss without emitting any data action', async () => {
  const control = menu();
  await control.open();
  control.find('order-menu-backdrop').props.onClick({ stopPropagation() {} });
  await control.settle();
  assert.equal(control.find('order-menu-popover'), undefined);
  assert.deepEqual(control.events, ['activate', 'close']);
  assert.equal(control.focused.at(-1), 'trigger');
  await control.open();
  control.context.toggle();
  assert.deepEqual(control.events, ['activate', 'close', 'activate', 'close']);
  control.dispose();
});

test('an explicit menu action closes first and prevents a second action from the same event frame', async () => {
  for (const status of ['accepted', 'cancelled', 'completed']) {
    const control = menu({ status });
    await control.open();
    const action = orderMenuActions(status)[0].action;
    const button = control.draw().find(node => node.props?.role === 'menuitem');
    assert.equal(button.props['aria-label'], `${orderMenuActions(status)[0].label}今天晚餐`);
    button.props.onClick({ stopPropagation() {} });
    control.context.choose(action);
    assert.deepEqual(control.events, ['activate', 'close', action]);
    control.dispose();
  }
});

test('busy, hidden and inapplicable options cannot emit a cancellation, restoration or deletion', async () => {
  const control = menu({ busy: true });
  await control.open();
  control.context.choose('remove');
  assert.deepEqual(control.events, []);
  assert.equal(control.find('order-more-button').props.disabled, true);
  control.props.busy = false;
  await control.open();
  control.context.choose('restore');
  assert.deepEqual(control.events, ['activate']);
  control.props.busy = true;
  await control.settle();
  control.context.choose('cancel');
  assert.equal(control.props.opened, false);
  assert.deepEqual(control.events, ['activate', 'close']);
  control.dispose();
});

test('keyboard navigation opens, moves, wraps, and returns focus on Escape or Tab', async () => {
  const control = menu();
  assert.equal(control.press('ArrowUp', true), true);
  await control.settle();
  assert.equal(control.focused.at(-1), 'remove');
  control.press('ArrowDown');
  await control.settle();
  assert.equal(control.focused.at(-1), 'cancel');
  control.press('End');
  await control.settle();
  assert.equal(control.focused.at(-1), 'remove');
  control.press('Home');
  await control.settle();
  assert.equal(control.focused.at(-1), 'cancel');
  assert.equal(control.press('Escape'), true);
  assert.equal(control.focused.at(-1), 'trigger');
  await control.open();
  assert.equal(control.press('Tab'), false);
  assert.equal(control.props.opened, false);
  assert.ok(!control.events.some(action => ['remove', 'cancel', 'restore'].includes(action)));
  control.dispose();
});

test('delayed native measurements cannot resurrect a closed, replaced or unmounted popup', async () => {
  const control = menu({ deferred: true });
  await control.open();
  assert.equal(control.find('order-menu-popover'), undefined);
  control.context.close();
  await control.open();
  control.queries[0](anchor);
  await control.settle();
  assert.equal(control.context.layout.value, null);
  control.queries[1](anchor);
  await control.settle();
  assert.ok(control.context.layout.value);
  control.context.positionMenu();
  await control.settle();
  control.dispose();
  control.queries[2](anchor);
  await control.settle();
  assert.equal(control.resizes.size, 0);
  assert.equal(control.props.opened, false);
});

test('a changed status closes old actions and an unavailable native anchor dismisses safely', async () => {
  const control = menu();
  await control.open();
  control.props.status = 'cancelled';
  await control.settle();
  assert.equal(control.context.layout.value, null);
  assert.equal(control.resizes.size, 0);
  control.dispose();
  const invalid = menu({ invalid: true });
  await invalid.open();
  assert.equal(invalid.props.opened, false);
  assert.equal(invalid.find('order-menu-popover'), undefined);
  invalid.dispose();
});

test('kitchen removes swipe handling, keeps one controlled popup and portals it outside the finished veil', () => {
  assert.doesNotMatch(page, /OrderSwipeCard|order-swipe/);
  assert.equal(existsSync(new URL('../src/components/OrderSwipeCard.vue', import.meta.url)), false);
  assert.doesNotMatch(source, /lang="wxs"|@longpress|@touchstart|@touchend/);
  assert.match(source, /<root-portal>/);
  assert.match(source, /<Teleport to="body">/);
  assert.match(source, /class="app-shell order-menu-root"/);
  assert.match(source, /prefers-reduced-motion/);
  assert.match(source, /min-width: 44px; min-height: 44px/);
  assert.match(page, /onPageScroll\(\(\) => \{ openedOrderId.value = ''; \}\)/);
  assert.match(page, /watch\(\[tab, sheetOpen, orderActionBusy\]/);
  assert.match(page, /:opened="openedOrderId === order.id"/);
});

test('kitchen and detail menu actions use the same leading icons without adding extra actions or touch targets', async () => {
  const cases = [
    [{ status: 'pending' }, ['cancel', 'trash-danger']],
    [{ status: 'accepted' }, ['cancel', 'trash-danger']],
    [{ status: 'cancelled' }, ['restore', 'trash-danger']],
    [{ status: 'completed' }, ['trash-danger']],
    [{ floating: true, actions: [{ action: 'edit', label: '编辑' }, { action: 'remove', label: '删除' }] }, ['edit', 'trash-danger']],
    [{ floating: true, actions: [{ action: 'edit', label: '编辑' }] }, ['edit']],
    [{ floating: true, actions: [{ action: 'remove', label: '删除' }] }, ['trash-danger']],
  ];
  for (const [props, expected] of cases) {
    const control = menu(props);
    await control.open();
    const items = control.draw().filter(node => node.props?.role === 'menuitem');
    assert.equal(items.length, expected.length);
    items.forEach((item, index) => {
      const contents = nodes(item);
      const icon = contents.find(node => node.type === 'AppIcon');
      const label = contents.find(node => node.type === 'text');
      assert.equal(icon.props.name, expected[index]);
      assert.equal(icon.props.size, 18);
      assert.equal(icon.props.class, 'order-menu-icon');
      assert.ok(contents.indexOf(icon) < contents.indexOf(label));
      assert.equal(contents.filter(node => node.type === 'button').length, 1);
      assert.equal(item.props['hover-class'], 'touch-feedback');
      assert.equal(item.props.class.includes('is-danger'), expected[index] === 'trash-danger');
    });
    assert.deepEqual(control.events, ['activate']);
    control.dispose();
  }
  assert.equal(orderMenuIcon('unsupported'), '');
});

test('action icon sizing preserves the compact bubble, row height and text alignment', () => {
  const rules = postcss.parse(descriptor.styles[0].content);
  const declarations = selector => {
    const values = {};
    rules.walkRules(rule => { if (rule.selectors.includes(selector)) rule.walkDecls(declaration => { values[declaration.prop] = declaration.value; }); });
    return values;
  };
  assert.equal(declarations('.order-menu-item')['justify-content'], 'flex-start');
  assert.equal(declarations('.order-menu-item')['align-items'], 'center');
  assert.equal(declarations('.order-menu-item').gap, '10px');
  assert.equal(declarations('.order-menu-item')['min-height'], '44px');
  assert.equal(declarations('.order-menu-icon').flex, '0 0 18px');
  assert.equal(declarations('.order-menu-icon')['pointer-events'], 'none');
  assert.equal(orderMenuGeometry(anchor, viewport, 2).width, 128);
});

test('action menu icons are packaged with transparent backgrounds and semantic neutral or danger strokes', async () => {
  for (const name of ['cancel', 'restore', 'edit', 'trash-danger']) {
    const expectedColor = name.endsWith('-danger') ? NATIVE_UI_COLORS.danger : NATIVE_UI_COLORS.muted;
    const channels = expectedColor.slice(1).match(/../g).map(value => Number.parseInt(value, 16));
    const { data, info } = await sharp(readFileSync(new URL(`../src/static/icon-${name}.png`, import.meta.url))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 96);
    assert.equal(info.height, 96);
    assert.equal(data[3], 0);
    let opaquePixels = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      if (data[offset + 3] !== 255) continue;
      assert.deepEqual(Array.from(data.subarray(offset, offset + 3)), channels);
      opaquePixels += 1;
    }
    assert.ok(opaquePixels > 150, `${name} has a visible stroke`);
  }
});
