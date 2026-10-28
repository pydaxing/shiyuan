import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import * as kitchen from '../src/domain/kitchen.js';
import { presentMutation } from '../src/services/mutation-feedback.js';

const source = readFileSync(new URL('../src/components/StockEditor.vue', import.meta.url), 'utf8');
const descriptor = parse(source).descriptor;
const script = compileScript(descriptor, { id: 'stock-editor-validation-test' });
const setupCode = script.content.replace(/import (\{[^}]+\}|\w+) from '[^']+';/g, (_, binding) => `const ${binding} = ${binding.startsWith('{') ? 'modules' : '{}'};`).replace('export default', 'return');
const template = compileTemplate({ id: 'stock-editor-validation-test', source: descriptor.template.content, filename: 'StockEditor.vue', compilerOptions: { bindingMetadata: script.bindings } });
assert.deepEqual(template.errors, []);
const renderCode = template.code.replace(/import \{([^}]+)\} from "vue"/g, (_, imports) => `const {${imports.replace(/ as /g, ': ')}} = Vue;`).replace('export function render', 'return function render');
const renderTemplate = new Function('Vue', renderCode)({ ...Vue, resolveComponent: tag => tag });

function mount(context, overrides = {}, initialProps = {}) {
  const calls = [];
  const events = [];
  const notices = [];
  const props = { initial: {}, purchase: false, ...initialProps };
  const modules = {
    ...Vue,
    ...kitchen,
    presentMutation,
    state: Vue.ref({ family: { features: { fridge: true } } }),
    ingredientImage: name => `ingredient:${name}`,
    coverFrameStyle: () => ({ paddingTop: '61.8%' }),
    addStock: async draft => calls.push(['addStock', structuredClone(Vue.toRaw(draft))]),
    recordPurchase: async draft => calls.push(['recordPurchase', structuredClone(Vue.toRaw(draft))]),
    notify: message => notices.push(message),
    ...overrides,
  };
  const scope = Vue.effectScope();
  context.after(() => scope.stop());
  const component = new Function('modules', setupCode)(modules);
  const api = scope.run(() => component.setup(props, { expose() {}, emit: (...args) => events.push(args) }));
  function render() {
    const sheet = renderTemplate({ $image: value => value, $emit: api.emit }, [], props, Vue.proxyRefs(api), {}, {});
    return { sheet, body: nodes(sheet.children.default()), footer: nodes(sheet.children.footer()) };
  }
  return { api, calls, events, notices, render };
}

function nodes(node) {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== 'object') return [];
  return [node, ...(Array.isArray(node.children) ? node.children.flatMap(nodes) : [])];
}

test('an accepted stock operation closes immediately and stays silent after the cloud save', async context => {
  let finish;
  const operation = Object.assign(new Promise(resolve => { finish = resolve; }), { accepted: true });
  const view = mount(context, { addStock: () => operation }, { initial: { name: '番茄', toBuy: 2 } });
  const saving = view.api.save();
  assert.deepEqual(view.events, [['saved']]);
  assert.deepEqual(view.notices, []);
  finish();
  await saving;
  assert.deepEqual(view.events, [['saved']]);
  assert.deepEqual(view.notices, []);
});

test('an untouched stock form has no premature validation messages', context => {
  const { api, render, calls } = mount(context);
  assert.deepEqual(api.fieldErrors.value, {});
  assert.equal(api.error.value, '');
  assert.equal(api.submitted.value, false);
  assert.ok(!render().footer.some(node => node.props?.role === 'alert'));
  assert.deepEqual(calls, []);
});

test('empty fields are caught before a cloud command and the first invalid field is revealed', async context => {
  const { api, render, calls, events, notices } = mount(context);
  const revealed = [];
  api.fieldRefs.name = { reveal: () => revealed.push('name') };
  api.fieldRefs.quantity = { reveal: () => revealed.push('quantity') };
  await api.save();
  assert.deepEqual(calls, []);
  assert.deepEqual(events, []);
  assert.deepEqual(notices, []);
  assert.deepEqual(revealed, ['name']);
  assert.equal(api.saving.value, false);
  assert.ok(api.fieldErrors.value.name);
  assert.ok(api.fieldErrors.value.quantity);
  const { body, footer } = render();
  const name = body.find(node => node.type === api.FormField && node.props['aria-label'] === '食材名称');
  const quantity = body.find(node => node.type === api.FormField && node.props['aria-label'] === '库存数量');
  assert.equal(name.props.error, api.fieldErrors.value.name);
  assert.equal(quantity.props.error, api.fieldErrors.value.quantity);
  assert.equal(name.props['error-id'], 'stock-name-error');
  assert.equal(quantity.props['error-id'], 'stock-quantity-error');
  assert.ok(!footer.some(node => node.props?.role === 'alert'));
  assert.ok(!body.some(node => node.props?.role === 'alert'));
});

test('invalid quantities preserve the domain limits and never send a save request', async context => {
  for (const quantity of ['', '0', '-1', '不是数量', 'Infinity', '100001', '0.0005']) {
    const { api, calls } = mount(context, {}, { initial: { name: '胡萝卜' } });
    let revealed = 0;
    api.fieldRefs.quantity = { reveal: () => { revealed += 1; } };
    api.draft.value.quantity = quantity;
    await api.save();
    assert.equal(revealed, 1, quantity);
    assert.match(api.fieldErrors.value.quantity, /食材数量/);
    assert.deepEqual(calls, [], quantity);
    assert.throws(() => kitchen.validateIngredient(api.draft.value), { message: api.fieldErrors.value.quantity });
  }
});

test('invalid names and units use the existing ingredient validation rules', async context => {
  for (const changes of [{ name: '  ' }, { name: '菜'.repeat(31) }, { unit: '未知单位' }]) {
    const { api, calls } = mount(context, {}, { initial: { name: '胡萝卜', toBuy: 1 } });
    Object.assign(api.draft.value, changes);
    await api.save();
    assert.deepEqual(calls, []);
    assert.throws(() => kitchen.validateIngredient(api.draft.value), { message: Object.values(api.fieldErrors.value)[0] });
  }
});

test('correcting the fields immediately clears their errors and permits saving without losing input', async context => {
  const { api, render, calls, events } = mount(context);
  await api.save();
  api.draft.value.name = '胡萝卜';
  await Vue.nextTick();
  assert.equal(api.fieldErrors.value.name, undefined);
  assert.ok(api.fieldErrors.value.quantity);
  assert.equal(api.error.value, '');
  assert.ok(!render().footer.some(node => node.props?.role === 'alert'));
  api.draft.value.quantity = '0.5';
  await Vue.nextTick();
  assert.deepEqual(api.fieldErrors.value, {});
  assert.equal(api.error.value, '');
  assert.ok(!render().footer.some(node => node.props?.role === 'alert'));
  await api.save();
  assert.deepEqual(calls, [['addStock', { name: '胡萝卜', quantity: '0.5', unit: 'g', location: '冷藏', expiresOn: '', image: '' }]]);
  assert.deepEqual(events, [['saved']]);
});

test('stock still accepts fractional and boundary quantities with no photo or expiration date', async context => {
  for (const quantity of ['0.001', '0.5', '100000']) {
    const { api, calls, notices } = mount(context, {}, { initial: { name: '番茄', toBuy: quantity } });
    await api.save();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'addStock');
    assert.equal(calls[0][1].quantity, quantity);
    assert.equal(calls[0][1].image, '');
    assert.equal(calls[0][1].expiresOn, '');
    assert.deepEqual(notices, []);
  }
});

test('server failures stay above the save button and preserve the full draft for retry', async context => {
  const attempts = [];
  const { api, events, notices, render } = mount(context, {
    addStock: async draft => {
      attempts.push(structuredClone(Vue.toRaw(draft)));
      if (attempts.length === 1) throw new Error('网络连接失败，请重试');
    },
  }, { initial: { name: '胡萝卜', toBuy: 2, unit: '根', location: '常温' } });
  api.draft.value.image = 'cloud://saved-photo';
  api.draft.value.expiresOn = '2026-11-01';
  await Vue.nextTick();
  await api.save();
  assert.equal(api.saving.value, false);
  assert.equal(api.error.value, '网络连接失败，请重试');
  assert.deepEqual(events, []);
  assert.deepEqual(notices, []);
  assert.deepEqual(Vue.toRaw(api.draft.value), attempts[0]);
  const { footer, body } = render();
  assert.equal(footer.find(node => node.props?.role === 'alert').children, '网络连接失败，请重试');
  assert.ok(!body.some(node => node.children === '网络连接失败，请重试'));
  assert.equal(footer.find(node => node.type === 'button').props.disabled, false);
  await api.save();
  assert.deepEqual(attempts[1], attempts[0]);
  assert.equal(api.error.value, '');
  assert.deepEqual(events, [['saved']]);
  assert.deepEqual(notices, []);
});

test('editing after a server rejection removes the stale message without hiding current field errors', async context => {
  const { api } = mount(context, { addStock: async () => { throw new Error('保存失败，请重试'); } }, { initial: { name: '胡萝卜', toBuy: 2 } });
  await api.save();
  assert.equal(api.error.value, '保存失败，请重试');
  api.draft.value.quantity = '0';
  await Vue.nextTick();
  assert.equal(api.error.value, '');
  assert.ok(api.fieldErrors.value.quantity);
});

test('pending input updates cannot erase a synchronous save failure', async context => {
  const { api, render } = mount(context, { addStock: () => { throw new Error('保存失败，请重试'); } });
  api.draft.value.name = '胡萝卜';
  api.draft.value.quantity = '2';
  api.draft.value.expiresOn = '2026-11-30';
  await api.save();
  await Vue.nextTick();
  assert.equal(render().footer.find(node => node.props?.role === 'alert')?.children, '保存失败，请重试');
});

test('an impossible expiry date is revealed inline without contacting the cloud', async context => {
  const { api, calls, render } = mount(context, {}, { initial: { name: '胡萝卜', toBuy: 2 } });
  const revealed = [];
  api.fieldRefs.expiresOn = { reveal: () => revealed.push('expiresOn') };
  api.draft.value.expiresOn = '2026-02-30';
  await api.save();
  assert.deepEqual(calls, []);
  assert.deepEqual(revealed, ['expiresOn']);
  assert.equal(api.fieldErrors.value.expiresOn, '请填写正确的到期日期');
  assert.ok(render().body.some(node => node.type === api.FieldError && node.props.error === api.fieldErrors.value.expiresOn));
  assert.ok(!render().footer.some(node => node.props?.role === 'alert'));
});

test('a failure without an Error object still gives a visible retry message', async context => {
  const { api, render } = mount(context, { addStock: async () => { throw null; } }, { initial: { name: '胡萝卜', toBuy: 2 } });
  await api.save();
  assert.equal(render().footer.find(node => node.props?.role === 'alert').children, '保存失败，请重试');
  assert.equal(api.saving.value, false);
});

test('saving prevents duplicate requests and keeps the existing photo and submit guards', async context => {
  let finish;
  let requests = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  const { api, render, events } = mount(context, { addStock: () => { requests += 1; return pending; } }, { initial: { name: '胡萝卜', toBuy: 2 } });
  const firstSave = api.save();
  await api.save();
  assert.equal(requests, 1);
  assert.equal(api.saving.value, true);
  assert.equal(render().footer.find(node => node.type === 'button').props.disabled, true);
  assert.equal(render().body.find(node => node.type === api.ImagePicker).props.disabled, true);
  finish();
  await firstSave;
  assert.equal(api.saving.value, false);
  assert.deepEqual(events, [['saved']]);
});

test('uploading still blocks validation and saving until the photo is ready', async context => {
  const { api, calls, render } = mount(context);
  api.busy.value = true;
  await api.save();
  assert.deepEqual(calls, []);
  assert.equal(api.submitted.value, false);
  assert.equal(api.error.value, '');
  assert.equal(render().footer.find(node => node.type === 'button').props.disabled, true);
});

for (const fridge of [false, true]) {
  test(`purchase validation preserves its save route with fridge ${fridge ? 'enabled' : 'disabled'}`, async context => {
    const { api, calls, render, events, notices } = mount(context, { state: Vue.ref({ family: { features: { fridge } } }) }, { purchase: true, initial: { name: '胡萝卜', unit: '根' } });
    await api.save();
    assert.deepEqual(calls, []);
    assert.ok(api.fieldErrors.value.quantity);
    assert.ok(render().body.some(node => node.type === api.FormField && node.props.error === api.fieldErrors.value.quantity));
    assert.ok(!render().footer.some(node => node.props?.role === 'alert'));
    api.draft.value.quantity = '2';
    await Vue.nextTick();
    await api.save();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'recordPurchase');
    assert.deepEqual(events, [['saved']]);
    assert.deepEqual(notices, []);
    assert.equal(render().sheet.props.title, '胡萝卜');
    assert.equal(render().body.find(node => node.type === api.SelectField).props.disabled, true);
  });
}

test('native form inputs associate the inline error text and retain keyboard coordination', () => {
  const field = readFileSync(new URL('../src/components/FormField.vue', import.meta.url), 'utf8');
  for (const tag of ['input', 'textarea']) {
    const input = field.match(new RegExp(`<${tag}\\b[^>]+>`))[0];
    assert.match(input, /:aria-invalid="Boolean\(error\)"/);
    assert.match(input, /:aria-describedby="error \? errorElementId : undefined"/);
    assert.match(input, /@keyboardheightchange="keyboardChange"/);
    assert.match(input, /:adjust-position="!sheet"/);
  }
  assert.match(field, /<text v-if="error && !externalError" :id="errorElementId"[^>]*role="alert"/);
  assert.match(source, /<template #footer><text v-if="error"[^>]*role="alert"/);
  assert.match(descriptor.styles[0].content, /\.stock-save-error\s*\{[^}]*margin: 0 0 10px/);
});
