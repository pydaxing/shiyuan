import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDropdownGeometry } from '../src/domain/select-dropdown.js';

test('category popover aligns below the trigger and fits eight options in two-column rows', () => {
  assert.deepEqual(selectDropdownGeometry({ left: 100, bottom: 140 }, { windowWidth: 390, windowHeight: 844 }, 8), { top: 144, left: 100, width: 176, height: 206 });
});

test('category popover keeps horizontal gutters on short and narrow screens', () => {
  assert.deepEqual(selectDropdownGeometry({ left: 280, bottom: 144 }, { windowWidth: 320, windowHeight: 568 }, 8), { top: 148, left: 132, width: 176, height: 206 });
  assert.deepEqual(selectDropdownGeometry({ left: -10, bottom: 80 }, { windowWidth: 180, windowHeight: 400 }, 3), { top: 84, left: 12, width: 156, height: 110 });
});

test('long category grids scroll within the remaining viewport instead of crossing its bottom', () => {
  const viewport = { windowWidth: 375, windowHeight: 320 };
  const geometry = selectDropdownGeometry({ left: 100, bottom: 180 }, viewport, 30);
  assert.equal(geometry.height, 124);
  assert.equal(geometry.top + geometry.height, viewport.windowHeight - 12);
});

test('unmeasurable or unavailable anchors do not create an invalid popup', () => {
  const viewport = { windowWidth: 375, windowHeight: 568 };
  for (const anchor of [null, {}, { left: NaN, bottom: 80 }, { left: 12, bottom: Infinity }]) assert.equal(selectDropdownGeometry(anchor, viewport, 9), null);
  assert.equal(selectDropdownGeometry({ left: 12, bottom: 560 }, viewport, 9), null);
  assert.equal(selectDropdownGeometry({ left: 12, bottom: 80 }, viewport, 0), null);
  assert.equal(selectDropdownGeometry({ left: 12, bottom: 80 }, { windowWidth: 20, windowHeight: 320 }, 9), null);
});
