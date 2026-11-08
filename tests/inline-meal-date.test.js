import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as Vue from 'vue';
function setup(value) {
  const source = readFileSync(new URL('../src/components/InlineMealDate.vue', import.meta.url), 'utf8');
  const compiled = compileScript(parse(source).descriptor, { id: 'date-test' }).content;
  const code = compiled.replace(/import (\{[^}]+\}|\w+) from '[^']+';/g, (_, binding) => `const ${binding} = ${binding.startsWith('{') ? 'modules' : '{}'};`).replace('export default', 'return');
  const props = Vue.reactive({ modelValue: value, disabled: false });
  const component = new Function('modules', code)({ ...Vue, localDate: () => '2026-11-07' });
  const api = component.setup(props, { expose() {}, emit: (_, date) => { props.modelValue = date; } });
  return { props, api, change: indices => api.change({ detail: { value: indices } }) };
}
test('wheel clamps a long month to leap and non-leap February', () => {
  const f = setup('2024-01-31');
  f.change([24, 1, 30]);
  assert.equal(f.props.modelValue, '2024-02-29');
  f.change([25, 1, 28]);
  assert.equal(f.props.modelValue, '2025-02-28');
  assert.equal(f.api.days.value.length, 28);
});
test('wheel restricts future dates and ignores changes while locked', () => {
  const f = setup('2025-12-31');
  f.change([26, 11, 30]);
  assert.equal(f.props.modelValue, '2026-11-07');
  assert.equal(f.api.months.value.length, 11);
  assert.equal(f.api.days.value.length, 7);
  f.props.disabled = true;
  f.change([24, 0, 0]);
  assert.equal(f.props.modelValue, '2026-11-07');
});
