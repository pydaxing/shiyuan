import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from '@vue/compiler-sfc';
import { baseParse } from '@vue/compiler-dom';
import { compile } from '@dcloudio/uni-mp-compiler';
import { syncNativeTaps } from '../scripts/sync-taps.mjs';

const runtime = readFileSync(new URL('../node_modules/@dcloudio/uni-mp-vue/dist/vue.runtime.esm.js', import.meta.url), 'utf8');
const invokerCode = runtime.slice(runtime.indexOf('function createInvoker('), runtime.indexOf('function patchMPEvent('));
const bindingCode = runtime.slice(runtime.indexOf('function vOn('), runtime.indexOf('function patchMPEvent('));

test('native event reuse can close a new editor when its opening tap reaches an old ancestor binding', () => {
  const instance = { $ei: 0, ctx: { $mpPlatform: 'mp-weixin', $scope: {} } };
  const bind = new Function('getCurrentInstance', 'isString', 'patchMPEvent', 'callWithAsyncErrorHandling', 'patchStopImmediatePropagation', bindingCode + '; return vOn;')(() => instance, value => typeof value === 'string', () => {}, (handler, instance, code, args) => handler(...args), (event, handler) => handler);
  for (const stopped of [false, true]) {
    let open = false;
    const render = () => {
      instance.$ei = 0;
      const launch = bind(() => { open = true; }, '8c');
      const close = open ? bind(() => { open = false; }, '98') : null;
      return { launch, close, outside: bind(() => {}, '98') };
    };
    const before = render();
    const event = { type: 'tap', target: { dataset: { eventsync: 'true' } } };
    instance.ctx.$scope[before.launch](event);
    const after = render();
    assert.equal(open, true);
    assert.equal(after.close, before.outside);
    if (!stopped) instance.ctx.$scope[before.outside](event);
    assert.equal(open, stopped);
  }
});

test('all family editor launch controls stop native taps before the page can rerender its ancestor binding', () => {
  const entries = [['components/PageHeader.vue', 'page-heading-edit'], ['components/FamilyView.vue', 'family-banner-edit'], ['components/FamilyView.vue', 'family-banner-main family-management-entry']];
  for (const [filename, className] of entries) {
    const template = parse(readFileSync(new URL(`../src/${filename}`, import.meta.url), 'utf8')).descriptor.template.content;
    const nodes = [];
    function collect(node) { if (node.type === 1) { nodes.push(node); node.children.forEach(collect); } }
    baseParse(template).children.forEach(collect);
    const button = nodes.find((node) => node.props.some((prop) => prop.name === 'class' && prop.value?.content === className));
    assert.ok(button.props.some((prop) => prop.name === 'on' && prop.arg?.content === 'click' && prop.modifiers.includes('stop')), `${filename}: opening tap must not reach the page's changing event table`);
  }
});

test('installed WeChat runtime dispatches sync targets immediately, once, without a delayed business callback', () => {
  const queue = [];
  const createInvoker = new Function('patchMPEvent', 'callWithAsyncErrorHandling', 'patchStopImmediatePropagation', 'setTimeout', `${invokerCode}; return createInvoker;`)(() => {}, (handler, instance, code, args) => handler(...args), (event, handler) => handler, (callback) => queue.push(callback));
  const calls = [];
  const tap = createInvoker(() => calls.push('tap'));
  tap({ type: 'tap', target: { dataset: {} } });
  assert.deepEqual(calls, []);
  assert.equal(queue.length, 1);
  queue.shift()();
  calls.length = 0;
  for (const eventsync of ['true', true]) {
    tap({ type: 'tap', target: { dataset: { eventsync } } });
    assert.equal(queue.length, 0);
  }
  assert.deepEqual(calls, ['tap', 'tap']);
});

test('WeChat compilation opts buttons and nested visual tap targets into synchronous dispatch', () => {
  let markup;
  compile('<button @click="choose" :disabled="busy"><view><image src="/static/tofu.png"/><text>菜品</text></view></button>', {
    filename: 'Tap.vue', nodeTransforms: [syncNativeTaps],
    miniProgram: { directive: 'wx:', class: { array: true }, event: { key: true }, emitFile: (file) => { markup = file.source; } },
  });
  let targets = 0;
  function walk(node) {
    if (node.type !== 1) return;
    assert.equal(node.props.find((prop) => prop.name === 'data-eventsync')?.value?.content, 'true');
    targets += 1;
    node.children.forEach(walk);
  }
  baseParse(markup).children.forEach(walk);
  assert.equal(targets, 4);
  assert.match(markup, /bindtap=/);
  assert.match(markup, /disabled=/);
  assert.doesNotMatch(markup, /(?:bind|catch)touch(?:start|end)/);
});

test('business taps have one action owner, with nested controls stopping synchronous bubbling', () => {
  const components = readdirSync(new URL('../src/components/', import.meta.url)).filter((file) => file.endsWith('.vue')).map((file) => `components/${file}`);
  for (const filename of [...components, 'pages/index/index.vue']) {
    const source = readFileSync(new URL(`../src/${filename}`, import.meta.url), 'utf8');
    function walk(node, insideAction = false) {
      if (node.type !== 1) return;
      const action = node.props.find((prop) => prop.name === 'on' && ['tap', 'click'].includes(prop.arg?.content) && prop.exp?.content && !['dismissFocusedKeyboard', 'surfaceGesture.end'].includes(prop.exp.content) && !(filename === 'components/HomeMenu.vue' && prop.exp.content === 'closeMenuActions'));
      if (action && insideAction) assert.ok(action.modifiers.includes('stop'), `${filename}: nested tap actions must stop native bubbling`);
      node.children.forEach((child) => walk(child, insideAction || Boolean(action)));
    }
    baseParse(parse(source).descriptor.template?.content || '').children.forEach((node) => walk(node));
    if (filename === 'components/HomeMenu.vue') assert.match(source, /function closeMenuActions\(\) \{ openedKey.value = ''; \}/);
  }
});

test('procurement controls use independent native taps without an interactive card ancestor', () => {
  const template = parse(readFileSync(new URL('../src/components/ShoppingView.vue', import.meta.url), 'utf8')).descriptor.template.content;
  let markup;
  compile(template, {
    filename: 'ShoppingView.vue', nodeTransforms: [syncNativeTaps],
    miniProgram: { directive: 'wx:', class: { array: true }, event: { key: true }, emitFile: file => { markup = file.source; } },
  });
  const nodes = [];
  function collect(node) { if (node.type === 1) { nodes.push(node); node.children.forEach(collect); } }
  baseParse(markup).children.forEach(collect);
  const card = nodes.find(node => node.tag === 'view' && node.props.some(prop => prop.name === 'class' && (prop.value?.content === 'shopping-package' || prop.value?.content.includes("'shopping-package'"))));
  assert.ok(card);
  assert.ok(!card.props.some(prop => ['bindtap', 'catchtap'].includes(prop.name)));
  const buttons = nodes.filter(node => node.tag === 'button');
  assert.equal(buttons.length, 8);
  for (const button of buttons) {
    assert.ok(button.props.some(prop => prop.name === 'bindtap'));
    assert.ok(!button.props.some(prop => prop.name === 'catchtap'));
    assert.equal(button.props.find(prop => prop.name === 'data-eventsync')?.value?.content, 'true');
  }
  assert.doesNotMatch(markup, /preparation-disclosure|preparation-chevron/);
});

test('native inputs and scroll surfaces dispatch touchstart before focus rather than on a delayed timer', () => {
  let markup;
  compile('<scroll-view @touchstart="interrupt"><input @focus="focus"/><textarea @focus="focus"/></scroll-view>', {
    filename: 'Input.vue', isNativeTag: () => true, nodeTransforms: [syncNativeTaps],
    miniProgram: { directive: 'wx:', class: { array: true }, event: { key: true }, emitFile: file => { markup = file.source; } },
  });
  const nodes = [];
  function walk(node) { if (node.type === 1) { nodes.push(node); node.children.forEach(walk); } }
  baseParse(markup).children.forEach(walk);
  const queue = [];
  const createInvoker = new Function('patchMPEvent', 'callWithAsyncErrorHandling', 'patchStopImmediatePropagation', 'setTimeout', `${invokerCode}; return createInvoker;`)(() => {}, (handler, instance, code, args) => handler(...args), (event, handler) => handler, callback => queue.push(callback));
  assert.deepEqual(nodes.map(node => node.tag), ['scroll-view', 'input', 'textarea']);
  for (const node of nodes) {
    const eventsync = node.props.find(prop => prop.name === 'data-eventsync')?.value?.content;
    assert.equal(eventsync, 'true');
    const calls = [];
    const target = { dataset: { eventsync } };
    createInvoker(() => calls.push('interrupt'))({ type: 'touchstart', target });
    createInvoker(() => calls.push('focus'))({ type: 'focus', target });
    assert.equal(queue.length, 0);
    assert.deepEqual(calls, ['interrupt', 'focus']);
  }
});
