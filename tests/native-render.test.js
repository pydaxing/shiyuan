import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick } from 'vue';
import { afterNativeRender } from '../src/composables/nativeRender.js';

test('native rendering uses the WeChat callback, not the uni async API proxy', async context => {
  const previousWx = globalThis.wx;
  const previousUni = globalThis.uni;
  context.after(() => { globalThis.wx = previousWx; globalThis.uni = previousUni; });
  let nativeFrame;
  let completed = false;
  globalThis.wx = { nextTick: callback => { nativeFrame = callback; } };
  globalThis.uni = { nextTick() { assert.fail('uni API proxy does not forward this native callback'); } };
  const pending = afterNativeRender().then(() => { completed = true; });
  await nextTick();
  assert.equal(completed, false);
  assert.equal(typeof nativeFrame, 'function');
  nativeFrame();
  await pending;
  assert.equal(completed, true);
});

test('browser rendering does not wait for a nonexistent native renderer', async context => {
  const previousWx = globalThis.wx;
  context.after(() => { globalThis.wx = previousWx; });
  globalThis.wx = undefined;
  await afterNativeRender();
});
