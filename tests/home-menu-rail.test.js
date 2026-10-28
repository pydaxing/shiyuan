import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/components/HomeMenu.vue', import.meta.url), 'utf8');
const wxs = source.match(/<script module="railGesture" lang="wxs">([\s\S]*?)<\/script>/)[1];

function rail({ viewport = 250, content = 384, top = 0, kind = 'rail', docked = true, locked = false } = {}) {
  const module = { exports: {} };
  runInNewContext(wxs, { module, Math, parseFloat });
  const gesture = module.exports;
  const state = {};
  const calls = [];
  const measured = [];
  const heights = { viewport, content };
  const data = { docked, locked };
  const owner = {
    getState: () => state,
    selectComponent(selector) {
      return { getComputedStyle(properties) {
        assert.equal(Array.from(properties).join(), 'height');
        measured.push(selector);
        return { height: `${['.home-menu-rail-scroll', '.home-menu-sections'].includes(selector) ? heights.viewport : heights.content}px` };
      } };
    },
    callMethod(name, category) { calls.push({ name, category: category && typeof category === 'object' ? { ...category } : category }); },
  };
  const event = (vertical, horizontal = 20) => ({ currentTarget: { dataset: data }, touches: [{ pageX: horizontal, pageY: vertical }] });
  const scroll = value => gesture[kind === 'rail' ? 'scroll' : 'listScroll']({ detail: { scrollTop: value } }, owner);
  scroll(top);
  calls.length = 0;
  return { state, calls, measured, heights, scroll, data,
    start: vertical => gesture[kind === 'rail' ? 'start' : 'listStart'](event(vertical), owner),
    move: (vertical, horizontal) => gesture[kind === 'rail' ? 'contain' : 'listMove'](event(vertical, horizontal), owner),
    tap: category => gesture.tap({ currentTarget: { dataset: { category } } }, owner),
  };
}

test('the category rail permits native scrolling until its own lower boundary', () => {
  const menu = rail();
  menu.start(300);
  assert.equal(menu.move(250), undefined);
  menu.scroll(50);
  assert.equal(menu.move(200), undefined);
  menu.scroll(134);
  assert.equal(menu.move(150), false);
  assert.equal(menu.move(100), false);
  assert.equal(menu.state.railLimit, 134);
  assert.equal(menu.measured.length, 2);
  assert.deepEqual(menu.calls, []);
});

test('lower boundaries block outward movement while pulling down from the top restores the cover', () => {
  const menu = rail({ top: 134 });
  menu.start(200);
  assert.equal(menu.move(100), false);
  assert.equal(menu.move(150), undefined);
  menu.scroll(0);
  assert.equal(menu.move(200), false);
  assert.equal(menu.move(150), false);
  assert.deepEqual(menu.calls, [
    { name: 'scrollPage', category: { distance: -50, start: true } },
    { name: 'scrollPage', category: { distance: 50, start: false } },
  ]);
});

test('a fully visible rail blocks further upward motion but permits returning to the cover', () => {
  const menu = rail({ viewport: 515 });
  menu.start(200);
  assert.equal(menu.move(100), false);
  assert.equal(menu.move(300), false);
  assert.equal(menu.state.railLimit, 0);
  assert.deepEqual(menu.calls, [{ name: 'scrollPage', category: { distance: -200, start: true } }]);
});

test('the rail remeasures only when a new gesture starts after pinning or resizing', () => {
  const menu = rail();
  menu.start(300);
  assert.equal(menu.state.railLimit, 134);
  menu.heights.viewport = 515;
  menu.start(300);
  assert.equal(menu.state.railLimit, 0);
  assert.equal(menu.measured.length, 4);
  assert.equal(menu.move(200), false);
});

test('scrolling categories does not select the category underneath the lifted finger', () => {
  const menu = rail();
  menu.start(300);
  menu.move(100);
  assert.equal(menu.tap('主食'), false);
  assert.deepEqual(menu.calls, []);
  menu.start(100);
  menu.move(102);
  assert.equal(menu.tap('小食'), false);
  assert.deepEqual(menu.calls, [{ name: 'selectCategory', category: '小食' }]);
});

test('ordinary dish, empty and set category taps keep using the existing navigation handler', () => {
  const menu = rail();
  for (const category of ['荤菜', '素菜', '套餐']) {
    menu.start(100);
    menu.tap(category);
  }
  assert.deepEqual(menu.calls.map(call => call.category), ['荤菜', '素菜', '套餐']);
  assert.match(source, /defineExpose\(\{[^}]*selectCategory/);
  assert.match(source, /:data-category="item" @click="railGesture\.tap"/);
});

test('before the categories fit, gestures scroll the page rather than either inner list', () => {
  for (const kind of ['rail', 'list']) {
    const menu = rail({ kind, docked: false });
    menu.start(300);
    assert.equal(menu.move(200), undefined);
    assert.equal(menu.move(100), undefined);
    assert.deepEqual(menu.calls, []);
    menu.data.docked = true;
    menu.start(300);
    assert.equal(menu.move(200), undefined);
  }
});

test('right list scroll events update category tracking without moving the outer page', () => {
  const menu = rail({ kind: 'list', viewport: 384, content: 1200 });
  menu.start(300);
  assert.equal(menu.move(200), undefined);
  menu.scroll(100);
  assert.equal(menu.state.listScrollTop, 100);
  assert.deepEqual(menu.calls, [{ name: 'onListScroll', category: { scrollTop: 100 } }]);
  assert.equal(menu.move(100), undefined);
});

test('right list bottom cannot continue pushing the page or create space below the rail', () => {
  const menu = rail({ kind: 'list', viewport: 384, content: 1200, top: 816 });
  menu.start(300);
  assert.equal(menu.move(200), false);
  assert.equal(menu.move(100), false);
  assert.deepEqual(menu.calls, []);
  assert.equal(menu.move(150), undefined);
});

test('pulling down at the list top hands the gesture back without trapping the family cover', () => {
  const menu = rail({ kind: 'list', viewport: 384, content: 1200 });
  menu.start(100);
  assert.equal(menu.move(130), false);
  menu.data.docked = false;
  assert.equal(menu.move(150), false);
  assert.deepEqual(menu.calls, [
    { name: 'scrollPage', category: { distance: -30, start: true } },
    { name: 'scrollPage', category: { distance: -20, start: false } },
  ]);
});

test('horizontal dish swipes and taps are not stolen by vertical scroll coordination', () => {
  const menu = rail({ kind: 'list', viewport: 384, content: 1200 });
  menu.start(100);
  assert.equal(menu.move(102, 16), undefined);
  assert.equal(menu.move(106, 120), undefined);
  assert.deepEqual(menu.calls, []);
});

test('an open sheet blocks both rails without dispatching any page gesture', () => {
  for (const kind of ['rail', 'list']) {
    const menu = rail({ kind, locked: true });
    menu.start(100);
    assert.equal(menu.move(140), false);
    assert.equal(menu.move(80), false);
    assert.deepEqual(menu.calls, []);
  }
});
