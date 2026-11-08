import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/components/StretchCover.vue', import.meta.url), 'utf8');
const wxs = source.match(/<script module="cover" lang="wxs">([\s\S]*?)<\/script>/)[1];
function cover({ height = '700px', minimum = '700px', refreshable = false } = {}) {
  const module = { exports: {} }, state = {}, paints = [], calls = [];
  runInNewContext(wxs, { module, Math });
  const gesture = module.exports;
  const owner = {
    getState: () => state,
    callMethod: (...args) => calls.push(args),
    selectComponent: selector => selector === '.stretch-cover'
      ? { getComputedStyle: () => ({ height, 'min-height': minimum }) }
      : { setStyle: value => paints.push(value) },
  };
  gesture.sync(1, undefined, owner);
  gesture.syncRefresh(refreshable ? 1 : 0, undefined, owner);
  return { gesture, state, paints, calls, owner, touch: (x, y) => ({ touches: [{ pageX: x, pageY: y }] }) };
}

test('pull grows progressively more resistant and stays below 80px even over a long distance', () => {
  const f = cover();
  f.gesture.start(f.touch(100, 100), f.owner);
  const heights = [];
  for (const distance of [100, 200, 300, 1000, 10000]) {
    assert.equal(f.gesture.move(f.touch(103, 100 + distance), f.owner), false);
    heights.push(parseFloat(f.paints.at(-1).height));
    assert.ok(heights.at(-1) > 0 && heights.at(-1) < 80);
    assert.equal(f.paints.at(-1).transition, 'none', 'follow the finger directly');
  }
  assert.ok(heights[0] < 35, 'ordinary pulling only adds a little height');
  assert.ok(heights[2] - heights[1] < heights[1] - heights[0], 'equal extra finger travel has less effect');
  f.gesture.end({}, f.owner);
  assert.equal(f.paints.at(-1).height, '0px');
  assert.match(f.paints.at(-1).transition, /260ms/);
});

test('short and long pulls always rebound on release, including consecutive pulls', () => {
  const f = cover();
  for (const distance of [20, 100, 400, 900, 100]) {
    f.gesture.start(f.touch(100, 100), f.owner);
    f.gesture.move(f.touch(100, 100 + distance), f.owner);
    f.gesture.end({}, f.owner);
    assert.equal(f.paints.at(-1).height, '0px');
    assert.equal(f.state.active, false);
    assert.equal(f.state.dragging, false);
  }
});

test('reversing the finger before release never moves the cover above its original position', () => {
  const f = cover();
  f.gesture.start(f.touch(100, 300), f.owner);
  f.gesture.move(f.touch(100, 600), f.owner);
  assert.equal(f.gesture.move(f.touch(100, 200), f.owner), false);
  assert.equal(f.paints.at(-1).height, '0px');
  f.gesture.end({}, f.owner);
  assert.equal(f.paints.at(-1).height, '0px');
});

test('a fitted page blocks upward movement until the next gesture', () => {
  const f = cover(); f.gesture.start(f.touch(100, 100), f.owner);
  assert.equal(f.gesture.move(f.touch(100, 10), f.owner), false);
  assert.equal(f.gesture.move(f.touch(100, 0), f.owner), false);
  f.gesture.end({}, f.owner);
  assert.equal(f.paints.length, 0);
  f.gesture.start(f.touch(100, 100), f.owner);
  assert.equal(f.gesture.move(f.touch(100, 300), f.owner), false);
  assert.equal(f.state.dragging, true, 'a following downward gesture still works');
});

test('real overflow or unknown measurements allow normal upward scrolling', () => {
  for (const size of [{ height: '820px' }, { minimum: 'auto' }, { height: '', minimum: '' }]) {
    const f = cover(size); f.gesture.start(f.touch(100, 100), f.owner);
    assert.equal(f.gesture.move(f.touch(100, 10), f.owner), undefined);
    assert.equal(f.gesture.move(f.touch(100, 0), f.owner), undefined);
    assert.equal(f.paints.length, 0);
  }
});

test('horizontal gestures leave page navigation alone', () => {
  const f = cover(); f.gesture.start(f.touch(100, 100), f.owner);
  assert.equal(f.gesture.move(f.touch(200, 103), f.owner), undefined);
  assert.equal(f.paints.length, 0);
  assert.equal(f.state.active, false);
});

test('normal scrolling away from the page top does not start a pull', () => {
  const f = cover();
  f.gesture.sync(2, 1, f.owner);
  f.gesture.start(f.touch(0, 0), f.owner);
  assert.equal(f.state.active, undefined, 'pull can only start at the page top');
  assert.equal(f.gesture.move(f.touch(0, 300), f.owner), undefined);
  assert.equal(f.paints.length, 0);
});

test('leaving the view or opening a sheet cancels a pull and restores a usable cover', () => {
  const f = cover();
  f.gesture.start(f.touch(0, 0), f.owner);
  f.gesture.move(f.touch(0, 150), f.owner);
  f.gesture.sync(0, 1, f.owner);
  assert.equal(f.paints.at(-1).height, '0px');
  assert.equal(f.state.active, false);
  f.gesture.start(f.touch(0, 0), f.owner);
  f.gesture.move(f.touch(0, 150), f.owner);
  assert.equal(f.paints.at(-1).height, '0px', 'hidden or personal-mode cover stays closed');
  f.gesture.sync(1, 0, f.owner);
  f.gesture.start(f.touch(0, 0), f.owner);
  f.gesture.move(f.touch(0, 150), f.owner);
  assert.ok(parseFloat(f.paints.at(-1).height) > 0, 'first pull after re-entry works');
  f.gesture.end({}, f.owner);
  assert.equal(f.paints.at(-1).height, '0px');
});

test('multiple touches cancel a stretch without leaving extra page height', () => {
  const f = cover(); f.gesture.start(f.touch(0, 0), f.owner);
  f.gesture.move(f.touch(0, 150), f.owner);
  f.gesture.move({ touches: [{ pageX: 0, pageY: 200 }, { pageX: 20, pageY: 200 }] }, f.owner);
  assert.equal(f.paints.at(-1).height, '0px');
  assert.equal(f.state.active, false);
});


test('cover refresh requires threshold on release and locks repeated gestures until completion', () => {
  const f = cover({ refreshable: true });
  f.gesture.start(f.touch(0, 0), f.owner);
  f.gesture.move(f.touch(0, 100), f.owner);
  f.gesture.end({}, f.owner);
  assert.equal(f.calls.filter(([method]) => method === 'requestRefresh').length, 0);
  f.gesture.start(f.touch(0, 0), f.owner);
  f.gesture.move(f.touch(0, 240), f.owner);
  assert.equal(f.state.ready, true);
  assert.equal(f.calls.filter(([method]) => method === 'requestRefresh').length, 0, 'wait for release');
  f.gesture.end({}, f.owner);
  assert.equal(f.paints.at(-1).height, '44px');
  assert.equal(f.calls.filter(([method]) => method === 'requestRefresh').length, 1);
  f.gesture.start(f.touch(0, 0), f.owner);
  f.gesture.move(f.touch(0, 300), f.owner);
  f.gesture.end({}, f.owner);
  assert.equal(f.calls.filter(([method]) => method === 'requestRefresh').length, 1);
  f.gesture.syncRefresh(2, 1, f.owner);
  f.gesture.syncRefresh(1, 2, f.owner);
  assert.equal(f.paints.at(-1).height, '0px');
  assert.equal(f.state.refreshing, false);
});

test('pulling back below threshold, canceling, and leaving never refresh', () => {
  for (const action of ['reverse', 'cancel', 'leave']) {
    const f = cover({ refreshable: true });
    f.gesture.start(f.touch(0, 0), f.owner);
    f.gesture.move(f.touch(0, 260), f.owner);
    if (action === 'reverse') f.gesture.move(f.touch(0, 60), f.owner);
    if (action === 'cancel') f.gesture.cancel({}, f.owner);
    if (action === 'leave') f.gesture.sync(0, 1, f.owner);
    f.gesture.end({}, f.owner);
    assert.equal(f.calls.filter(([method]) => method === 'requestRefresh').length, 0);
    assert.equal(f.paints.at(-1).height, '0px');
  }
});

test('async refresh settles on success and failure, and rejects duplicate requests', async () => {
  const script = source.match(/<script>([\s\S]*?)<\/script>/)[1];
  const messages = [];
  const component = new Function('FamilyCoverImage', 'uni', script.replace(/import[^;]+;/, '').replace('export default', 'return'))({}, { showToast: value => messages.push(value) });
  for (const fail of [false, true]) {
    let resolve, calls = 0;
    const ctx = { active: true, refreshing: false, pullReady: true, refreshAction: () => { calls++; return new Promise((ok, no) => { resolve = () => fail ? no(new Error('网络暂不可用')) : ok(); }); } };
    const task = component.methods.requestRefresh.call(ctx);
    assert.equal(ctx.refreshing, true);
    await component.methods.requestRefresh.call(ctx);
    assert.equal(calls, 1);
    resolve(); await task;
    assert.equal(ctx.refreshing, false);
    assert.equal(ctx.pullReady, false);
  }
  assert.equal(messages.length, 1);
  assert.equal(messages[0].title, '网络暂不可用');
});
