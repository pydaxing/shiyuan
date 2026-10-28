import test from 'node:test';
import assert from 'node:assert/strict';
import { focusKeyboardField, blurKeyboardField, dismissFocusedKeyboard, createKeyboardDismissGesture, isKeyboardFieldEvent } from '../src/services/keyboard.js';

test('outside taps hide an active keyboard once and do nothing on ordinary unfocused taps', () => {
  let hides = 0;
  globalThis.uni = { hideKeyboard: () => { hides += 1; } };
  assert.equal(dismissFocusedKeyboard(), false);
  const token = Symbol('step');
  focusKeyboardField(token);
  assert.equal(dismissFocusedKeyboard(), true);
  assert.equal(dismissFocusedKeyboard(), false);
  blurKeyboardField(token);
  assert.equal(hides, 1);
  delete globalThis.uni;
});

test('switching fields never hides the keyboard and a late blur cannot release the new field', () => {
  let hides = 0;
  globalThis.uni = { hideKeyboard: () => { hides += 1; } };
  const previous = Symbol('title');
  const next = Symbol('description');
  focusKeyboardField(previous);
  focusKeyboardField(next);
  blurKeyboardField(previous);
  assert.equal(hides, 0);
  assert.equal(dismissFocusedKeyboard(), true);
  assert.equal(hides, 1);
  delete globalThis.uni;
});

test('blur or unmount releases only its own token; later reply focus can still be dismissed', () => {
  let hides = 0;
  globalThis.uni = { hideKeyboard: () => { hides += 1; } };
  const token = Symbol('comment');
  focusKeyboardField(token);
  blurKeyboardField(token);
  assert.equal(dismissFocusedKeyboard(), false);
  focusKeyboardField(token);
  assert.equal(dismissFocusedKeyboard(), true);
  focusKeyboardField(token);
  assert.equal(dismissFocusedKeyboard(), true);
  assert.equal(hides, 2);
  delete globalThis.uni;
});

test('outside tap dismisses once but swipes and a tap which focuses a new field never dismiss it', () => {
  let hides = 0;
  globalThis.uni = { hideKeyboard: () => { hides += 1; } };
  const gesture = createKeyboardDismissGesture();
  const start = { touches: [{ clientX: 20, clientY: 40 }] };
  const end = { changedTouches: [{ clientX: 20, clientY: 40 }] };
  const field = Symbol('description');
  gesture.begin(start);
  focusKeyboardField(field);
  gesture.end(end);
  assert.equal(hides, 0);
  gesture.begin(start);
  gesture.move({ touches: [{ clientX: 20, clientY: 80 }] });
  gesture.end(end);
  assert.equal(hides, 0);
  gesture.begin(start);
  const next = Symbol('delete-family');
  focusKeyboardField(next);
  gesture.end(end);
  assert.equal(hides, 0);
  gesture.begin(start);
  gesture.end(end);
  gesture.end(end);
  assert.equal(hides, 1);
  delete globalThis.uni;
});

test('native field taps never hide the keyboard even if focus arrived before touchstart', () => {
  let hides = 0;
  globalThis.uni = { hideKeyboard: () => { hides += 1; } };
  const gesture = createKeyboardDismissGesture();
  const token = Symbol('textarea');
  focusKeyboardField(token);
  try {
    for (const keyboardField of [true, 'true']) {
      const event = { target: { dataset: { keyboardField } }, changedTouches: [{ clientX: 20, clientY: 40 }] };
      gesture.begin(event);
      gesture.end(event);
      assert.equal(dismissFocusedKeyboard(event), false);
      gesture.begin({ changedTouches: [{ clientX: 20, clientY: 40 }] });
      gesture.end(event);
      assert.equal(hides, 0);
    }
    assert.equal(dismissFocusedKeyboard(), true);
    assert.equal(hides, 1);
  } finally { blurKeyboardField(token); delete globalThis.uni; }
});

test('field detection handles H5 inner nodes and never treats all sheet taps as input', () => {
  assert.equal(isKeyboardFieldEvent(), false);
  assert.equal(isKeyboardFieldEvent({ target: { dataset: {} }, currentTarget: { dataset: { keyboardField: 'true' } } }), false);
  assert.equal(isKeyboardFieldEvent({ target: { closest: selector => selector === '[data-keyboard-field="true"]' ? {} : null } }), true);
  assert.equal(isKeyboardFieldEvent({ target: { closest: () => null } }), false);
});

test('native mark excludes input-internal placeholder targets whose dataset is empty', () => {
  let hides = 0;
  globalThis.uni = { hideKeyboard: () => { hides += 1; } };
  const token = Symbol('placeholder');
  const gesture = createKeyboardDismissGesture();
  focusKeyboardField(token);
  try {
    for (const keyboardfield of [true, 'true']) {
      const event = { target: { dataset: {} }, mark: { keyboardfield }, changedTouches: [{ clientX: 20, clientY: 40 }] };
      assert.equal(isKeyboardFieldEvent(event), true);
      gesture.begin(event);
      gesture.end(event);
      assert.equal(dismissFocusedKeyboard(event), false);
    }
    assert.equal(hides, 0);
  } finally { blurKeyboardField(token); delete globalThis.uni; }
});

test('dismissing a field releases its layout owner exactly once, not the previous field owner', () => {
  const calls = [];
  globalThis.uni = { hideKeyboard: () => calls.push('native-hide') };
  try {
    focusKeyboardField('old', () => calls.push('old'));
    focusKeyboardField('new', () => calls.push('new'));
    blurKeyboardField('old');
    dismissFocusedKeyboard();
    dismissFocusedKeyboard();
    assert.deepEqual(calls, ['new', 'native-hide']);
  } finally { delete globalThis.uni; }
});
