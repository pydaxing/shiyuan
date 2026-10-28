import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { baseParse, compile } from '@vue/compiler-dom';
import * as Vue from 'vue';
import { foodMinutesLabel } from '../src/domain/presentation.js';

const source = readFileSync(new URL('../src/components/MenuSwipeRow.vue', import.meta.url), 'utf8');
const wxs = source.match(/<script module="swipe" lang="wxs">([\s\S]*?)<\/script>/)[1];
const options = new Function('AppIcon', 'FoodThumbnail', 'foodMinutesLabel', source.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\s*$/gm, '').replace('export default', 'return'))({}, {}, foodMinutesLabel);

const metadataNodes = [];
function visitMetadata(node) {
  if (node.type !== 1) return;
  if (node.props.some(prop => prop.name === 'class' && prop.value?.content === 'home-menu-meta')) metadataNodes.push(node);
  node.children.forEach(visitMetadata);
}
baseParse(source.match(/<template>([\s\S]*?)<\/template>/)[1]).children.forEach(visitMetadata);
const renderMetadata = new Function('Vue', compile(metadataNodes[0].loc.source, { mode: 'function' }).code)({ ...Vue, resolveComponent: name => name });
function metadata(entry) {
  const context = { entry };
  for (const [name, getter] of Object.entries(options.computed)) Object.defineProperty(context, name, { get: () => getter.call(context) });
  return renderMetadata(context, []);
}

test('dish metadata renders the category and actual cooking duration side by side', () => {
  for (const minutes of [1, 10, 25, 600, '20']) {
    const rendered = metadata({ kind: 'dish', category: '素菜', minutes, meta: '' });
    assert.equal(rendered.children[0].children, '素菜');
    const duration = rendered.children[1];
    assert.equal(duration.type, 'view');
    assert.equal(duration.children[0].props.name, 'clock');
    assert.equal(duration.children[0].props.size, 12);
    assert.equal(duration.children[1].children, `${minutes} 分钟`);
  }
});

test('unknown or invalid cooking duration never hides the category or invents minutes', () => {
  for (const minutes of [null, undefined, '', '  ', 0, -1, NaN, Infinity, '未填写']) {
    const rendered = metadata({ kind: 'dish', category: '主食', minutes, meta: 'undefined 分钟' });
    assert.equal(rendered.children[0].children, '主食');
    assert.equal(rendered.children[1].type, Vue.Comment);
  }
});

test('set metadata renders the actual dish count with a menu icon, not cooking duration', () => {
  for (const [entry, expected] of [
    [{ recipes: [{ id: 'first' }, { id: 'second' }, { id: 'third' }] }, '3 道菜'],
    [{ recipes: [{ id: 'first' }], recipeIds: ['first', 'removed'] }, '1 道菜'],
    [{ recipeIds: ['first', 'second'] }, '2 道菜'],
    [{ recipes: [], recipeIds: ['removed'] }, '0 道菜'],
  ]) {
    const rendered = metadata({ ...entry, kind: 'set', category: '荤菜', minutes: 25, meta: '旧数量' });
    assert.equal(rendered.children[0].children, '套餐');
    const count = rendered.children[1];
    assert.equal(count.type, 'view');
    assert.equal(count.children[0].props.name, 'menu');
    assert.equal(count.children[0].props.size, 12);
    assert.equal(count.children[1].children, expected);
  }
});

test('metadata reacts to edited duration and set members without a cached display string', () => {
  const entry = Vue.reactive({ kind: 'dish', category: '荤菜', minutes: 25 });
  const rendered = Vue.computed(() => metadata(entry));
  assert.equal(rendered.value.children[1].children[1].children, '25 分钟');
  entry.minutes = 35;
  assert.equal(rendered.value.children[1].children[1].children, '35 分钟');
  entry.minutes = null;
  assert.equal(rendered.value.children[1].type, Vue.Comment);
  entry.kind = 'set';
  entry.recipes = [{ id: 'first' }];
  assert.equal(rendered.value.children[1].children[1].children, '1 道菜');
  entry.recipes.push({ id: 'second' });
  assert.equal(rendered.value.children[1].children[1].children, '2 道菜');
});

test('metadata keeps the icon and number together when a narrow row wraps', () => {
  const styles = source.match(/\.home-menu-secondary-meta\s*\{([^}]+)\}/)[1];
  assert.match(styles, /flex-shrink:\s*0/);
  assert.match(styles, /white-space:\s*nowrap/);
  assert.match(source, /\.home-menu-meta\s*\{[^}]*flex-wrap:\s*wrap/);
});

test('menu entries always show their category even when no duration is given', () => {
  for (const [entry, expected] of [[{ kind: 'dish', category: '主食' }, '主食'], [{ kind: 'dish', label: '素菜' }, '素菜'], [{ kind: 'set', category: '荤菜' }, '套餐'], [{ kind: 'dish' }, '其他']]) {
    assert.equal(options.computed.categoryLabel.call({ entry }), expected);
  }
  assert.match(source, /class="home-menu-item-category">\{\{ categoryLabel \}\}/);
  assert.doesNotMatch(source, /v-if="entry.meta" class="home-menu-meta"/);
  assert.match(source, /<FoodThumbnail :src="entry.image" :kind="entry.kind"\s*\/>/);
});

function row({ opened = false, busy = false, sharing = false, entry = { id: 'dish', key: 'dish', kind: 'dish', title: '香菇滑鸡' }, onActivate = () => {} } = {}) {
  const module = { exports: {} };
  runInNewContext(wxs, { module, Math });
  const gesture = module.exports;
  const state = {};
  const paints = [];
  const calls = [];
  const events = [];
  const context = { entry, busy, opened, sharing, $emit(name, value) { events.push({ name, value }); if (name === 'activate') onActivate(); } };
  Object.assign(context, Object.fromEntries(Object.entries(options.methods).map(([name, method]) => [name, method.bind(context)])));
  const owner = {
    getState: () => state,
    selectComponent(selector) { assert.equal(selector, '.menu-swipe-surface'); return { setStyle: style => paints.push(style) }; },
    callMethod(name, payload) { calls.push(name); context[name](payload); },
  };
  const sync = (open, disabled = false) => { context.opened = open; context.busy = disabled; gesture.sync(options.computed.swipeState.call(context), null, owner); };
  sync(opened, busy);
  const event = (type, horizontal = 200, vertical = 100, timeStamp = 0) => ({ type, timeStamp, touches: type === 'touchend' ? [] : [{ pageX: horizontal, pageY: vertical }], changedTouches: [{ pageX: horizontal, pageY: vertical }], currentTarget: { dataset: { action: 'open' } } });
  const touch = (type, horizontal, vertical, timeStamp) => gesture[type.replace('touch', '')](event(type, horizontal, vertical, timeStamp), owner);
  return { gesture, state, paints, calls, events, context, owner, sync, touch, event, tap(action = 'open') { return gesture.tap({ currentTarget: { dataset: { action } } }, owner); } };
}

test('one ordinary tap opens either a dish or set and the plus dispatches only its selection key', () => {
  for (const kind of ['dish', 'set']) for (const action of ['open', 'toggle']) {
    const entry = { id: 'meal', key: kind === 'set' ? 'set:meal' : 'meal', kind };
    const menu = row({ entry });
    menu.touch('touchstart', 200, 100, 0);
    menu.touch('touchend', 202, 101, 70);
    menu.tap(action);
    assert.deepEqual(menu.events, [{ name: 'close', value: undefined }, { name: action, value: action === 'toggle' ? entry.key : entry }]);
  }
});

test('horizontal motion stays in WXS, paints within bounds and crosses the bridge only at activation and settlement', () => {
  const menu = row();
  menu.touch('touchstart', 300, 100, 0);
  for (let index = 1; index <= 120; index += 1) menu.touch('touchmove', 300 - index * 2, 101, index * 5);
  assert.deepEqual(menu.calls, ['activate']);
  assert.equal(menu.state.offset, -180);
  assert.equal(menu.paints.at(-1).transform, 'translate3d(-180px, 0, 0)');
  menu.touch('touchend', 60, 101, 650);
  assert.deepEqual(menu.calls, ['activate', 'settled']);
  assert.equal(menu.state.open, true);
  assert.equal(menu.tap(), false);
  assert.ok(!menu.events.some(event => ['open', 'toggle', 'remove'].includes(event.name)));
});

test('vertical scrolling and small hand tremors never reveal actions or block vertical motion', () => {
  const menu = row();
  menu.touch('touchstart', 200, 100, 0);
  assert.equal(menu.touch('touchmove', 198, 104, 20), undefined);
  assert.equal(menu.touch('touchmove', 196, 125, 40), undefined);
  assert.equal(menu.touch('touchmove', 140, 180, 100), undefined);
  menu.touch('touchend', 140, 180, 130);
  menu.tap();
  assert.equal(menu.state.axis, 'vertical');
  assert.equal(menu.state.offset, 0);
  assert.deepEqual(menu.calls, []);
});

test('short slow drags snap closed, deliberate quick swipes open, right swipes close', () => {
  const menu = row();
  menu.touch('touchstart', 200, 100, 0);
  menu.touch('touchmove', 170, 100, 400);
  menu.touch('touchend', 170, 100, 450);
  assert.equal(menu.state.open, false);
  menu.touch('touchstart', 200, 100, 500);
  menu.touch('touchmove', 155, 100, 545);
  menu.touch('touchend', 155, 100, 555);
  assert.equal(menu.state.open, true);
  menu.touch('touchstart', 100, 100, 600);
  menu.touch('touchmove', 210, 100, 900);
  menu.touch('touchend', 210, 100, 950);
  assert.equal(menu.state.open, false);
});

test('cancelling or adding a second touch restores the initial state without acting on a dish', () => {
  for (const opened of [false, true]) for (const cancelType of ['touchcancel', 'multitouch']) {
    const menu = row({ opened });
    menu.touch('touchstart', 200, 100, 0);
    menu.touch('touchmove', 100, 100, 40);
    if (cancelType === 'touchcancel') menu.gesture.cancel(menu.event(cancelType), menu.owner);
    else menu.gesture.move({ ...menu.event('touchmove'), touches: [{ pageX: 90, pageY: 100 }, { pageX: 140, pageY: 100 }] }, menu.owner);
    menu.tap();
    assert.equal(menu.state.open, opened);
    assert.equal(menu.state.active, false);
    assert.ok(!menu.events.some(event => event.name === 'open'));
  }
});

test('a fresh touch is not swallowed after a swipe, and tapping an open row first closes the actions', () => {
  const menu = row();
  menu.touch('touchstart', 200, 100, 0);
  menu.touch('touchmove', 100, 100, 100);
  menu.touch('touchend', 100, 100, 300);
  menu.touch('touchstart', 200, 100, 400);
  menu.touch('touchend', 200, 100, 470);
  menu.tap();
  assert.equal(menu.state.open, false);
  assert.ok(!menu.events.some(event => event.name === 'open'));
  menu.touch('touchstart', 200, 100, 500);
  menu.touch('touchend', 200, 100, 570);
  menu.tap();
  assert.equal(menu.events.filter(event => event.name === 'open').length, 1);
});

test('opening another row or disabling controls cancels and closes the previous row safely', () => {
  const previous = row({ opened: true });
  const next = row({ onActivate: () => previous.sync(false) });
  next.touch('touchstart', 200, 100, 0);
  next.touch('touchmove', 100, 100, 60);
  assert.equal(previous.state.open, false);
  assert.equal(previous.state.offset, 0);
  next.sync(true, true);
  next.touch('touchend', 100, 100, 100);
  next.tap();
  next.context.dispatchAction({ action: 'remove' });
  assert.equal(next.state.open, false);
  assert.ok(!next.events.some(event => event.name === 'remove'));
});

test('external close and busy states cross the native bridge as scalars and reset the translated surface', () => {
  for (const busy of [false, true]) {
    const menu = row({ opened: true });
    assert.equal(options.computed.swipeState.call(menu.context), 1);
    menu.sync(false, busy);
    assert.equal(options.computed.swipeState.call(menu.context), busy ? 2 : 0);
    assert.equal(menu.state.open, false);
    assert.equal(menu.state.active, false);
    assert.equal(menu.paints.at(-1).transform, 'translate3d(0px, 0, 0)');
    menu.sync(false);
    menu.touch('touchstart', 200, 100, 0);
    menu.touch('touchmove', 80, 100, 100);
    menu.touch('touchend', 80, 100, 300);
    assert.equal(menu.state.open, true);
  }
});

test('share preparation locks the open native row without translating it closed', () => {
  const menu = row({ opened: true, sharing: true });
  menu.context.dispatchAction({ action: 'share' });
  assert.deepEqual(menu.events.map(event => event.name), ['share']);
  menu.sync(true, true);
  assert.equal(options.computed.swipeState.call(menu.context), 3);
  assert.equal(menu.state.disabled, true);
  assert.equal(menu.state.open, true);
  assert.equal(menu.paints.at(-1).transform, 'translate3d(-180px, 0, 0)');
  menu.touch('touchstart', 200, 100, 0);
  menu.touch('touchmove', 300, 100, 100);
  menu.touch('touchend', 300, 100, 300);
  menu.tap();
  menu.context.dispatchAction({ action: 'share' });
  assert.deepEqual(menu.events.map(event => event.name), ['share']);
  menu.sync(true);
  assert.equal(menu.state.disabled, false);
  assert.equal(menu.state.open, true);
  menu.sync(false, true);
  assert.equal(options.computed.swipeState.call(menu.context), 2);
  assert.equal(menu.state.offset, 0);
});

test('the native change observer uses the supported prop name rather than a hyphenated attribute', () => {
  const template = baseParse(source.match(/<template>([\s\S]*?)<\/template>/)[1]);
  const root = template.children.find(node => node.type === 1);
  const bindings = new Map(root.props.filter(prop => prop.name === 'bind').map(prop => [prop.arg?.content, prop.exp?.content]));
  assert.equal(bindings.get('prop'), 'swipeState');
  assert.equal(bindings.get('change:prop'), 'swipe.sync');
  assert.equal(bindings.get('tabindex'), 'busy ? -1 : 0');
  assert.ok(!bindings.has('change:swipe-state'));
  assert.doesNotMatch(wxs, /console\.log/);
});

test('parent activation never interrupts an in-progress drag, and separate component instances share no gesture state', () => {
  const first = row();
  const second = row();
  first.touch('touchstart', 200, 100, 0);
  first.touch('touchmove', 150, 100, 100);
  first.sync(true);
  assert.equal(first.state.dragging, true);
  assert.equal(first.state.offset, -50);
  assert.equal(second.state.offset, 0);
  first.touch('touchend', 150, 100, 400);
  assert.equal(first.state.open, false);
});

test('edit, share and delete forward the original dish or set without mutating it, keyboard exposes actions', () => {
  for (const kind of ['dish', 'set']) for (const action of ['edit', 'share', 'remove']) {
    const entry = { id: 'original', key: `${kind}:original`, kind };
    const menu = row({ entry });
    menu.context.dispatchAction({ action });
    assert.deepEqual(menu.events, [...(action === 'share' ? [] : [{ name: 'close', value: undefined }]), { name: action, value: entry }]);
  }
  const menu = row();
  menu.context.handleKey({ key: 'ArrowLeft', preventDefault() {} });
  menu.context.handleKey({ key: 'Escape', preventDefault() {} });
  assert.deepEqual(menu.events.map(event => event.name), ['activate', 'close']);
});

test('tap owners are non-hover views so H5 supplies the WXS owner, with native buttons and no blanket touch blocking', () => {
  const nodes = [];
  function visit(node) { if (node.type === 1) { nodes.push(node); node.children.forEach(visit); } }
  baseParse(source.match(/<template>([\s\S]*?)<\/template>/)[1]).children.forEach(visit);
  const actions = nodes.filter(node => node.props.some(prop => prop.name === 'on' && prop.exp?.content === 'swipe.tap'));
  assert.equal(actions.length, 3);
  for (const action of actions) {
    assert.equal(action.tag, 'view');
    assert.ok(!action.props.some(prop => prop.name === 'hover-class'));
    assert.equal(action.children.filter(node => node.tag === 'button').length, 1);
  }
  assert.doesNotMatch(source, /@touch(?:start|move|end)\.(?:prevent|stop)/);
  assert.match(source, /touch-action: pan-y/);
  assert.match(source, /width: 60px; height: 100%; min-width: 44px; min-height: 44px; padding: 0; border-radius: 0/);
  assert.match(source, /align-items: stretch; width: 180px; padding: 0/);
  assert.match(source, /class="menu-swipe-edit"[^>]*>[\s\S]*?<text>编辑<\/text>/);
  assert.match(source, /class="menu-swipe-share"[^>]*>[\s\S]*?<text>分享<\/text>/);
  assert.ok(source.indexOf('class="menu-swipe-edit"') < source.indexOf('class="menu-swipe-share"'));
  assert.ok(source.indexOf('class="menu-swipe-share"') < source.indexOf('class="menu-swipe-delete"'));
  assert.match(source, /class="menu-swipe-delete"[^>]*>[\s\S]*?<text>删除<\/text>/);
  assert.match(source, /:disabled="busy \|\| !opened"/);
  assert.match(source, /prefers-reduced-motion/);
});

test('revealing menu actions keeps the white surface and leaves cart selection unchanged', () => {
  const template = baseParse(source.match(/<template>([\s\S]*?)<\/template>/)[1]);
  const root = template.children.find(node => node.type === 1);
  const classBinding = root.props.find(prop => prop.name === 'bind' && prop.arg?.content === 'class');
  const renderClasses = new Function('opened', 'selected', `return (${classBinding.exp.content});`);
  for (const selected of [false, true]) {
    for (const opened of [false, true]) assert.equal(renderClasses(opened, selected)['is-open'], opened);
  }
  const surfaceStyles = source.match(/\.menu-swipe-surface\s*\{([^}]+)\}/)[1];
  assert.match(surfaceStyles, /border-radius: 0;/);
  assert.match(surfaceStyles, /background: var\(--white\)/);
  assert.doesNotMatch(source, /\.menu-swipe\.is-open \.menu-swipe-surface\s*\{[^}]*background/);
  assert.doesNotMatch(source, /--swipe-open-surface/);
  const menu = row({ opened: true });
  menu.sync(false);
  assert.equal(renderClasses(menu.context.opened, true)['is-open'], false);
  assert.equal(menu.paints.at(-1).transform, 'translate3d(0px, 0, 0)');
  assert.ok(!menu.events.some(event => event.name === 'toggle'));
});
