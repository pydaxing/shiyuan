import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import * as kitchen from '../src/domain/kitchen.js';
import * as family from '../src/domain/family.js';
import { componentSource } from './helpers/sfc-setup.js';
import { presentMutation } from '../src/services/mutation-feedback.js';

let instanceSequence = 0;

test('material quantity clearing restores a visible zero without changing other fields or IME input', context => {
  const field = mount(context, 'FormField', { modelValue: 0, emptyValue: 0, variant: 'material', fieldClass: 'input preparation-material-input quantity-zero' }, { focusKeyboardField() {} });
  for (const raw of ['', '', ' ']) {
    assert.equal(field.api.onInput({ detail: { value: raw } }), '0');
    assert.deepEqual(field.events.at(-1), ['update:modelValue', 0]);
  }
  field.api.onInput({ detail: { value: '12.5' } });
  assert.deepEqual(field.events.at(-1), ['update:modelValue', '12.5']);
  field.api.onFocus({});
  assert.match(field.render().props.class, /form-field-material.*is-focused/);
  field.api.onBlur({ detail: { value: '' } });
  assert.deepEqual(field.events.at(-2), ['update:modelValue', 0]);
  assert.equal(field.api.focused.value, false);
  field.api.onInput({ detail: { value: '', isComposing: true } });
  assert.deepEqual(field.events.at(-1), ['update:modelValue', '']);
  const ordinary = mount(context, 'FormField', {});
  ordinary.api.onInput({ detail: { value: '' } });
  assert.deepEqual(ordinary.events, [['update:modelValue', '']]);
});

test('an accepted set update returns immediately and stays silent after cloud confirmation', async context => {
  let finish;
  const operation = Object.assign(new Promise(resolve => { finish = resolve; }), { accepted: true });
  const view = mount(context, 'SetEditor', {}, { saveMealSet: () => operation });
  view.api.title.value = '家常菜';
  view.api.selected.value = ['first', 'second'];
  const saving = view.api.save();
  assert.deepEqual(view.events, [['saved']]);
  assert.deepEqual(view.notices, []);
  finish();
  await saving;
  assert.deepEqual(view.events, [['saved']]);
  assert.deepEqual(view.notices, []);
});
function mount(context, name, initialProps = {}, overrides = {}, platform = {}) {
  const props = Vue.reactive(initialProps);
  const calls = [];
  const events = [];
  const notices = [];
  const scope = Vue.effectScope();
  context.after(() => scope.stop());
  const modules = {
    ...Vue, ...kitchen, ...family, presentMutation,
    state: Vue.ref({ recipes: [{ id: 'first', title: '第一道菜' }, { id: 'second', title: '第二道菜' }] }),
    getCurrentInstance: () => ({ uid: ++instanceSequence, proxy: {} }),
    inject: () => null,
    onUnmounted: callback => context.after(callback),
    blurKeyboardField() {},
    saveMealSet: async (...args) => calls.push(kitchen.clone(args)),
    notify: message => notices.push(message),
    ...overrides,
  };
  const descriptor = parse(componentSource(name)).descriptor;
  const script = compileScript(descriptor, { id: `inline-${name}` });
  const code = script.content.replace(/import (\{[^}]+\}|\w+) from '[^']+';/g, (_, binding) => `const ${binding} = ${binding.startsWith('{') ? 'modules' : '{}'};`).replace('export default', 'return');
  const component = new Function('modules', 'uni', code)(modules, platform);
  const api = scope.run(() => component.setup(props, { expose() {}, emit: (...args) => events.push(args) }));
  const template = compileTemplate({ source: descriptor.template.content, filename: `${name}.vue`, id: `inline-${name}`, compilerOptions: { bindingMetadata: script.bindings } });
  assert.deepEqual(template.errors, []);
  const renderCode = template.code.replace(/import \{([^}]+)\} from "vue"/g, (_, imports) => `const {${imports.replace(/ as /g, ': ')}} = Vue;`).replace('export function render', 'return function render');
  const render = new Function('Vue', renderCode)({ ...Vue, resolveComponent: name => name });
  return { api, props, calls, events, notices, modules, render: () => render({}, [], props, Vue.proxyRefs(api), {}, {}) };
}

function nodes(node) {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== 'object') return [];
  return [node, ...(Array.isArray(node.children) ? nodes(node.children) : [])];
}

test('a set without a name reveals the name control rather than a hidden page-bottom error', async context => {
  const view = mount(context, 'SetEditor');
  view.api.selected.value = ['first', 'second'];
  const reveals = [];
  view.api.fieldRefs.title = { reveal: () => reveals.push('title') };
  await view.api.save();
  assert.deepEqual(reveals, ['title']);
  assert.deepEqual(view.calls, []);
  assert.deepEqual(view.events, []);
  assert.deepEqual(view.notices, []);
  const sheet = view.render();
  const field = nodes(sheet.children.default()).find(node => node.type === view.api.FormField);
  assert.equal(field.props.error, view.api.fieldErrors.value.title);
  assert.match(field.props.error, /名称/);
  assert.equal(view.api.error.value, '');
  assert.ok(!nodes(sheet.children.footer()).some(node => node.props?.role === 'alert'));
  view.api.title.value = '两人晚餐';
  await view.api.save();
  assert.equal(view.calls.length, 1);
  assert.equal(view.calls[0][0].title, '两人晚餐');
  assert.deepEqual(view.events, [['saved']]);
});

test('set selection errors belong to the selection group and preserve the typed name', async context => {
  const view = mount(context, 'SetEditor');
  view.api.title.value = '两人晚餐';
  view.api.selected.value = ['first'];
  const reveals = [];
  view.api.fieldRefs.recipeIds = { reveal: () => reveals.push('recipes') };
  await view.api.save();
  assert.deepEqual(reveals, ['recipes']);
  assert.equal(view.api.fieldErrors.value.title, undefined);
  const field = nodes(view.render().children.default()).find(node => node.type === view.api.FieldError);
  assert.equal(field.props.error, view.api.fieldErrors.value.recipeIds);
  assert.ok(field.props.error);
  assert.equal(view.api.title.value, '两人晚餐');
  assert.deepEqual(view.calls, []);
});

test('set selection that references a removed recipe is blocked inline', async context => {
  const view = mount(context, 'SetEditor');
  view.api.title.value = '保留的套餐';
  view.api.selected.value = ['first', 'missing'];
  await view.api.save();
  assert.ok(view.api.fieldErrors.value.recipeIds);
  assert.deepEqual(view.calls, []);
});

test('set saving is single-submit and preserves the form for server-error retry', async context => {
  let reject;
  let requests = 0;
  const view = mount(context, 'SetEditor', {}, { saveMealSet: () => { requests += 1; return new Promise((resolve, fail) => { reject = fail; }); } });
  view.api.title.value = '周末套餐';
  view.api.selected.value = ['first', 'second'];
  const saving = view.api.save();
  await view.api.save();
  assert.equal(requests, 1);
  reject(new Error('保存失败，请重试'));
  await saving;
  assert.equal(view.api.saving.value, false);
  assert.equal(view.api.title.value, '周末套餐');
  const error = nodes(view.render().children.footer()).find(node => node.props?.role === 'alert');
  assert.equal(error.children, '保存失败，请重试');
  assert.deepEqual(view.events, []);
});

for (const multiline of [false, true]) {
  test(`shared ${multiline ? 'textarea' : 'input'} renders an associated error immediately after the control`, context => {
    const view = mount(context, 'FormField', { modelValue: '', multiline, error: '请填写名称', fieldClass: 'input' });
    const rendered = nodes(view.render());
    const control = rendered.find(node => node.type === (multiline ? 'textarea' : 'input'));
    const error = rendered.find(node => node.props?.role === 'alert');
    assert.ok(error);
    assert.equal(control.props['aria-invalid'], true);
    assert.equal(control.props['aria-describedby'], error.props.id);
    assert.equal(error.children, '请填写名称');
    assert.ok(rendered.indexOf(error) > rendered.indexOf(control));
    view.props.error = '';
    const corrected = nodes(view.render());
    assert.equal(corrected.some(node => node.props?.role === 'alert'), false);
    assert.equal(corrected.find(node => node.type === control.type).props['aria-invalid'], false);
  });
}

test('generated error ids remain unique across concurrently open fields and honor explicit ids', context => {
  const first = mount(context, 'FormField', { error: '错误一' });
  const second = mount(context, 'FormField', { error: '错误二' });
  const explicit = mount(context, 'FormField', { error: '错误三', errorId: 'custom-field-error' });
  assert.notEqual(first.api.errorElementId.value, second.api.errorElementId.value);
  assert.equal(explicit.api.errorElementId.value, 'custom-field-error');
});

test('input composition flags bracket raw edits and blur releases a missing composition-end event', context => {
  const field = mount(context, 'FormField');
  field.api.onInput({ detail: { value: 'wo', isComposing: true } });
  field.api.onInput({ detail: { value: '莴笋' }, isComposing: false });
  assert.deepEqual(field.events.map(event => event[0]), ['compositionstart', 'update:modelValue', 'update:modelValue', 'compositionend']);
  assert.equal(field.events[2][1], '莴笋');
  field.api.onCompositionStart({});
  field.api.onBlur({});
  assert.deepEqual(field.events.slice(-3).map(event => event[0]), ['compositionstart', 'compositionend', 'blur']);
});

test('compact row controls can link to a full-width row error without duplicating the message', context => {
  const field = mount(context, 'FormField', { modelValue: '', error: '请填写数量', errorId: 'material-quantity-error', externalError: true });
  const error = mount(context, 'FieldError', { error: '请填写数量', errorId: 'material-quantity-error' });
  const rendered = nodes(field.render());
  const control = rendered.find(node => node.type === 'input');
  const message = nodes(error.render()).find(node => node.props?.role === 'alert');
  assert.equal(control.props['aria-invalid'], true);
  assert.equal(control.props['aria-describedby'], message.props.id);
  assert.equal(rendered.some(node => node.props?.role === 'alert'), false);
  assert.equal(message.children, '请填写数量');
});

test('field reveal uses the existing sheet controller instead of scrolling the obscured background', context => {
  const reveals = [];
  const sheet = { reveal: (...args) => reveals.push(args), blur() {} };
  const view = mount(context, 'FormField', { error: '请填写名称' }, { inject: () => sheet }, { pageScrollTo: () => assert.fail('must not scroll behind the sheet') });
  view.api.reveal();
  assert.equal(reveals.length, 1);
  assert.equal(typeof reveals[0][0], 'symbol');
  assert.equal(typeof reveals[0][1], 'function');
});

test('page forms reveal the invalid control with the existing page heading offset', context => {
  const scrolls = [];
  const selectors = [];
  const query = {
    in() { return this; },
    select(selector) { selectors.push(selector); return this; },
    boundingClientRect() { return this; },
    selectViewport() { return this; },
    scrollOffset() { return this; },
    exec(callback) { callback([{ top: 430 }, { scrollTop: 250 }]); },
  };
  const view = mount(context, 'FormField', { error: '请填写名称' }, {}, { createSelectorQuery: () => query, pageScrollTo: options => scrolls.push(options) });
  view.api.reveal();
  assert.deepEqual(selectors, ['.form-field']);
  assert.deepEqual(scrolls, [{ scrollTop: 580, duration: 180 }]);
});
