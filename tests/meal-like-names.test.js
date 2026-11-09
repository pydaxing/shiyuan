import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as Vue from 'vue';
function setup(t) {
  const mounted = [], stopped = [], measurements = [];
  let resize;
  const uni = { createSelectorQuery: () => ({ in() { return this; }, select() { return this; }, boundingClientRect(fn) { measurements.push(fn); return this; }, exec() {} }), onWindowResize(fn) { resize = fn; }, offWindowResize(fn) { if (resize === fn) resize = null; } };
  const modules = { ...Vue, afterNativeRender: () => Promise.resolve(), getCurrentInstance: () => ({ proxy: {} }), onMounted: fn => mounted.push(fn), onUnmounted: fn => stopped.push(fn) };
  const source = readFileSync(new URL('../src/components/MealLikeNames.vue', import.meta.url), 'utf8');
  const code = compileScript(parse(source).descriptor, { id: 'likes' }).content.replace(/import \{([^}]+)\} from '[^']+';/g, 'const {$1} = modules;').replace('export default', 'return');
  const scope = Vue.effectScope();
  const props = Vue.reactive({ text: '昵称', resetKey: 'a' });
  const api = scope.run(() => new Function('modules', 'uni', code)(modules, uni).setup(props, { expose() {} }));
  mounted.forEach(fn => fn());
  t.after(() => { stopped.forEach(fn => fn()); scope.stop(); });
  return { api, props, measurements, resize: () => resize?.(), stop: () => stopped.forEach(fn => fn()) };
}
async function settle() { await Vue.nextTick(); await Promise.resolve(); }
test('likes fold only beyond five actual lines and recalculate after resize', async t => {
  const f = setup(t); await settle();
  f.measurements.shift()({ width: 250, height: 100 });
  assert.equal(f.api.overflowing.value, false);
  f.resize(); await settle();
  f.measurements.shift()({ width: 180, height: 120 });
  assert.equal(f.api.overflowing.value, true);
  f.api.expanded.value = true;
  f.props.text += '，新点赞'; await settle();
  f.measurements.shift()({ width: 180, height: 140 });
  assert.equal(f.api.expanded.value, true);
  f.resize(); await settle();
  f.measurements.shift()({ width: 350, height: 80 });
  assert.equal(f.api.expanded.value, false);
  assert.equal(f.api.overflowing.value, false);
});
test('recycled card resets expansion and ignores old or unmounted measurements', async t => {
  const f = setup(t); await settle();
  const old = f.measurements.shift();
  f.api.expanded.value = true;
  f.props.resetKey = 'b'; await settle();
  assert.equal(f.api.expanded.value, false);
  old({ width: 200, height: 200 });
  assert.equal(f.api.overflowing.value, false);
  f.stop();
  f.measurements.shift()({ width: 200, height: 200 });
  assert.equal(f.api.overflowing.value, false);
});
