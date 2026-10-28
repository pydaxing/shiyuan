import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import postcss from 'postcss';
import { componentSource } from './helpers/sfc-setup.js';
import { NATIVE_UI_COLORS } from '../src/domain/ui-theme.js';

function setup(context, entries = [], overrides = {}) {
  const mutationStatus = Vue.ref({ pending: [], failures: entries });
  const modals = [];
  const retried = [];
  const dismissed = [];
  const scope = Vue.effectScope();
  context.after(() => scope.stop());
  const modules = { ...Vue, mutationStatus, sheetOpen: Vue.ref(false), NATIVE_UI_COLORS, retryMutation: async id => retried.push(id), dismissMutation: id => dismissed.push(id), ...overrides };
  const descriptor = parse(componentSource('MutationSyncStatus')).descriptor;
  const code = compileScript(descriptor, { id: 'mutation-status' }).content.replace(/import (\{[^}]+\}|\w+) from '[^']+';/g, (_, binding) => `const ${binding} = ${binding.startsWith('{') ? 'modules' : '{}'};`).replace('export default', 'return');
  const component = new Function('modules', 'uni', code)(modules, { showModal: options => modals.push(options) });
  const api = scope.run(() => component.setup({}, { expose() {} }));
  const script = compileScript(descriptor, { id: 'mutation-render' });
  const template = compileTemplate({ id: 'mutation-render', source: descriptor.template.content, filename: 'MutationSyncStatus.vue', compilerOptions: { bindingMetadata: script.bindings } });
  assert.deepEqual(template.errors, []);
  const renderCode = template.code.replace(/import \{([^}]+)\} from "vue"/g, (_, imports) => `const {${imports.replace(/ as /g, ': ')}} = Vue;`).replace('export function render', 'return function render');
  const render = new Function('Vue', renderCode)(Vue);
  return { api, mutationStatus, modals, retried, dismissed, render: () => render({}, [], {}, Vue.proxyRefs(api), {}, {}) };
}

function elements(node) {
  if (!node || typeof node !== 'object') return [];
  return [...(typeof node.type === 'string' ? [node] : []), ...(Array.isArray(node.children) ? node.children.flatMap(elements) : [])];
}

test('sync feedback uses native-compatible class selectors with full-sized action targets', () => {
  const descriptor = parse(componentSource('MutationSyncStatus')).descriptor;
  const styles = postcss.parse(descriptor.styles[0].content);
  styles.walkRules(rule => assert.match(rule.selector, /^\.[\w-]+$/));
  assert.equal((descriptor.template.content.match(/class="mutation-copy-line/g) || []).length, 2);
  assert.equal((descriptor.template.content.match(/class="text-button mutation-action/g) || []).length, 2);
  const actionRules = {};
  styles.walkRules('.mutation-action', rule => rule.walkDecls(declaration => { actionRules[declaration.prop] = declaration.value; }));
  assert.equal(actionRules['min-width'], '44px');
  assert.equal(actionRules['min-height'], '44px');
});

test('pending edits never render a progress banner or leave a placeholder, regardless of duration or count', async context => {
  const view = setup(context);
  assert.deepEqual(elements(view.render()), []);
  view.mutationStatus.value.pending = [{ id: 'first' }];
  await Vue.nextTick();
  assert.deepEqual(elements(view.render()), []);
  view.mutationStatus.value.pending.push({ id: 'second' });
  await Vue.nextTick();
  assert.deepEqual(elements(view.render()), []);
  view.mutationStatus.value.pending = [];
  await Vue.nextTick();
  assert.deepEqual(elements(view.render()), []);
  assert.doesNotMatch(componentSource('MutationSyncStatus'), /setTimeout|mutation-progress|正在同步修改|项修改正在同步/);
});

test('silent pending work still exposes a persistent failure with retry, and clears only after recovery', async context => {
  const view = setup(context);
  view.mutationStatus.value.pending = [{ id: 'first' }];
  view.mutationStatus.value.failures = [{ id: 'first', label: '调整本餐', status: 'failed', message: '网络不可用，修改已保留' }];
  await Vue.nextTick();
  const nodes = elements(view.render());
  assert.ok(nodes.some(node => node.props?.role === 'alert'));
  assert.ok(nodes.some(node => node.children === '网络不可用，修改已保留'));
  const button = nodes.find(node => node.type === 'button' && node.children === '重试');
  await button.props.onClick();
  assert.deepEqual(view.retried, ['first']);
  view.mutationStatus.value.failures = [];
  view.mutationStatus.value.pending = [];
  await Vue.nextTick();
  assert.deepEqual(elements(view.render()), []);
});

test('uncertain writes offer retry, never abandon or a new operation identity', async context => {
  const view = setup(context, [{ id: 'stable-id', label: '调整本餐', status: 'uncertain' }]);
  view.api.dismiss();
  assert.deepEqual(view.modals, []);
  await view.api.retry();
  assert.deepEqual(view.retried, ['stable-id']);
});

test('abandoning a definitively failed write requires confirmation for that exact operation', async context => {
  const view = setup(context, [{ id: 'failed', status: 'failed' }]);
  view.api.dismiss();
  assert.deepEqual(view.dismissed, []);
  view.mutationStatus.value.failures = [{ id: 'newer', status: 'failed' }];
  view.modals[0].success({ confirm: true });
  assert.deepEqual(view.dismissed, []);
  await Vue.nextTick();
  view.api.dismiss();
  view.modals[1].success({ confirm: true });
  assert.deepEqual(view.dismissed, ['newer']);
});

test('late errors do not replace a newer failed action message', async context => {
  let fail;
  const view = setup(context, [{ id: 'first', status: 'failed' }], { retryMutation: () => new Promise((resolve, reject) => { fail = reject; }) });
  const retry = view.api.retry();
  view.mutationStatus.value.failures = [{ id: 'second', status: 'failed' }];
  await Vue.nextTick();
  fail(new Error('旧请求失败'));
  await retry;
  assert.equal(view.api.localError.value, '');
});
