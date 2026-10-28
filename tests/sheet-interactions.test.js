import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@vue/compiler-sfc';
import { baseParse } from '@vue/compiler-dom';
import { compile } from '@dcloudio/uni-mp-compiler';
import { createKeyboardDismissGesture, focusKeyboardField, blurKeyboardField, dismissFocusedKeyboard } from '../src/services/keyboard.js';

const source = readFileSync(new URL('../src/components/Sheet.vue', import.meta.url), 'utf8');
const template = parse(source).descriptor.template.content;

function compileSheet(content = template, footerVisible = true, scrollAnchor = '') {
  let markup = '';
  const compiled = compile(content, {
    filename: 'Sheet.vue',
    mode: 'function',
    isNativeTag: () => true,
    miniProgram: {
      directive: 'wx:',
      class: { array: true },
      event: { key: true },
      slot: { dynamicSlotNames: true },
      emitFile: (file) => { markup = file.source; },
    },
  });
  const events = [];
  const keyboardDismissals = [];
  const gesture = createKeyboardDismissGesture();
  const surfaceGesture = Object.fromEntries(Object.entries(gesture).map(([name, handler]) => [name, event => {
    const previous = globalThis.uni;
    globalThis.uni = { hideKeyboard: () => keyboardDismissals.push('hide') };
    try { handler(event); } finally { globalThis.uni = previous; }
  }]));
  const render = new Function('Vue', compiled.code)({ o: (handler) => handler, t: String, e: Object.assign, s: (style) => style, n: (value) => typeof value === 'object' ? Object.keys(value).filter((key) => value[key]).join(' ') : value });
const bindings = render({ title: '创建菜品', eyebrow: '', immersive: false, variant: '', focused: false, keyboard: 0, footerVisible, backdropStyle: {}, sheetStyle: {}, scrollTop: 0, scrollAnchor, multiline: false, fieldClass: 'input', modelValue: '', placeholder: '', ariaLabel: '菜名', maxlength: 30, disabled: false, focus: false, type: 'text', error: '', sheet: {}, onInput() {}, onCompositionStart() {}, onCompositionEnd() {}, onFocus() {}, onBlur() {}, keyboardChange() {}, handleScroll() {}, cancelReveal() {}, touchField() {}, dismissKeyboard() {}, surfaceGesture, startSurfaceGesture: surfaceGesture.begin, $slots: { footer: true }, $emit: (event) => events.push(event) }, []);
  const nodes = [];
  function collect(node, parent = null) {
    if (node.type !== 1) return;
    node.parent = parent;
    node.bindings = bindings;
    nodes.push(node);
    node.children.forEach((child) => collect(child, node));
  }
  baseParse(markup).children.forEach((node) => collect(node));
  const byClass = (name) => nodes.find((node) => node.props.some((prop) => prop.name === 'class' && (prop.value?.content.split(' ').includes(name) || prop.value?.content.includes(`'${name}'`))));
  return { markup, events, keyboardDismissals, nodes, byClass, root: byClass('sheet-backdrop') };
}

function dispatch(target, type, coordinates = { clientX: 120, clientY: 200 }) {
  for (let current = target; current; current = current.parent) {
    const event = current.props.find((prop) => [`bind${type}`, `catch${type}`].includes(prop.name));
    if (!event) continue;
    const binding = event.value.content.slice(2, -2);
    const dataset = target.props.find(prop => prop.name === 'data-keyboard-field') ? { keyboardField: 'true' } : {};
    current.bindings[binding]({ target: { ...target, dataset }, currentTarget: current, type, changedTouches: [coordinates] });
    if (event.name === `catch${type}`) break;
  }
}
function tap(target) { dispatch(target, 'tap'); }
function touch(target) { dispatch(target, 'touchstart'); dispatch(target, 'touchend'); tap(target); }

function tapSlottedControl(sheet, tag) {
  tap({ tag, props: [], parent: sheet.byClass('sheet-content') });
}

test('regression fixture reproduces dismissal when WeChat drops the self modifier', () => {
  const legacy = compileSheet('<view class="sheet-backdrop" @click.self="$emit(\'close\')"><view class="sheet-content"><slot /></view></view>');
  tapSlottedControl(legacy, 'input');
  assert.deepEqual(legacy.events, ['close']);
});

test('WeChat sheet isolates content taps from its separate dismiss mask', () => {
  const sheet = compileSheet();
  assert.equal(sheet.byClass('sheet-mask').parent, sheet.root);
  assert.equal(sheet.byClass('sheet').parent, sheet.root);
  assert.ok(sheet.byClass('sheet').props.some(prop => prop.name === 'catchtap'));
  assert.doesNotMatch(source, /@(?:click|tap)\.self/);
  for (const tag of ['input', 'textarea', 'button', 'image']) tapSlottedControl(sheet, tag);
  for (const name of ['sheet', 'sheet-header', 'sheet-content', 'sheet-footer']) tap(sheet.byClass(name));
  assert.deepEqual(sheet.events, []);
});

test('WeChat compilation retains the root portal around the entire sheet', () => {
  const sheet = compileSheet();
  assert.equal(sheet.root.parent.parent.tag, 'root-portal');
  assert.match(sheet.markup, /<root-portal>/);
});

test('WeChat scroll-view receives and clears the selected recipe anchor', () => {
  for (const anchor of ['recipe-accordion-1-2', '']) {
    const sheet = compileSheet(template, true, anchor);
    const scroller = sheet.nodes.find(node => node.tag === 'scroll-view');
    const attribute = scroller.props.find(prop => prop.name === 'scroll-into-view');
    const binding = attribute.value.content.match(/^\{\{([^}]+)\}\}$/)[1].trim();
    assert.equal(scroller.bindings[binding], anchor);
  }
});

test('WeChat can remove an empty settings footer while preserving bottom scroll safety', () => {
  const sheet = compileSheet(template, false);
  for (const [name, expected] of [['sheet-footer', false], ['sheet-safe-space', true]]) {
    const node = sheet.byClass(name);
    const condition = node.props.find(prop => prop.name === 'wx:if').value.content.slice(2, -2);
    assert.equal(Boolean(node.bindings[condition]), expected);
  }
});

test('portaled WeChat sheets retain the app ancestor required by scoped global styles', () => {
  const sheet = compileSheet();
  for (const name of ['sheet-backdrop', 'sheet-mask', 'sheet', 'sheet-scroll', 'sheet-content', 'sheet-footer', 'icon-button']) {
    let ancestor = sheet.byClass(name).parent;
    let scoped = false;
    while (ancestor && ancestor.tag !== 'root-portal') {
      scoped ||= ancestor.props.some((prop) => prop.name === 'class' && prop.value?.content.split(' ').includes('app-shell'));
      ancestor = ancestor.parent;
    }
    assert.equal(scoped, true, `${name} must inherit app styles within its portal`);
    assert.equal(ancestor?.tag, 'root-portal');
  }
});

test('only the mask and explicit close button dismiss a sheet, once per tap', () => {
  const sheet = compileSheet();
  tap(sheet.byClass('sheet-mask'));
  assert.deepEqual(sheet.events, ['close']);
  tap(sheet.byClass('icon-button'));
  assert.deepEqual(sheet.events, ['close', 'close']);
});

test('nested category and date sheets do not dismiss the containing editor', () => {
  const editor = compileSheet();
  const picker = compileSheet();
  picker.root.parent = editor.byClass('sheet-content');
  tapSlottedControl(picker, 'button');
  assert.deepEqual(picker.events, []);
  tap(picker.byClass('sheet-mask'));
  assert.deepEqual(picker.events, ['close']);
  tap(picker.byClass('icon-button'));
  assert.deepEqual(picker.events, ['close', 'close']);
  assert.deepEqual(editor.events, []);
});

test('WeChat sheet backdrop consumes taps instead of passing them to underlying actions', () => {
  const sheet = compileSheet();
  let tapsBehindSheet = 0;
  sheet.root.parent = { props: [{ name: 'bindtap', value: { content: '{{behind}}' } }], bindings: { behind: () => { tapsBehindSheet += 1; } } };
  tap(sheet.root);
  tapSlottedControl(sheet, 'textarea');
  tap(sheet.byClass('sheet-mask'));
  assert.equal(tapsBehindSheet, 0);
  assert.deepEqual(sheet.events, ['close']);
});

test('blank taps dismiss the keyboard once without closing the sheet; field taps never dismiss it', () => {
  const sheet = compileSheet();
  const field = compileSheet(parse(readFileSync(new URL('../src/components/FormField.vue', import.meta.url), 'utf8')).descriptor.template.content);
  field.nodes[0].parent = sheet.byClass('sheet-content');
  const token = Symbol('typing');
  focusKeyboardField(token);
  for (const tag of ['input', 'textarea']) touch(field.nodes.find((node) => node.tag === tag));
  assert.deepEqual(sheet.keyboardDismissals, []);
  assert.doesNotMatch(field.markup, /catch(?:touchstart|touchend|mousedown)=/);
  touch(sheet.byClass('sheet-header'));
  focusKeyboardField(token);
  touch(sheet.byClass('sheet-content'));
  assert.deepEqual(sheet.keyboardDismissals, ['hide', 'hide']);
  assert.deepEqual(sheet.events, []);
});

test('field taps cannot reach page dismissal even when a component boundary retargets them', () => {
  const field = compileSheet(parse(readFileSync(new URL('../src/components/FormField.vue', import.meta.url), 'utf8')).descriptor.template.content);
  const token = Symbol('search');
  const previous = globalThis.uni;
  let hides = 0;
  let taps = 0;
  globalThis.uni = { hideKeyboard: () => { hides += 1; } };
  field.nodes[0].parent = { props: [{ name: 'bindtap', value: { content: '{{outside}}' } }], bindings: { outside(event) { taps += 1; dismissFocusedKeyboard(event); } } };
  try {
    for (const tag of ['input', 'textarea']) {
      focusKeyboardField(token);
      touch(field.nodes.find(node => node.tag === tag));
      assert.equal(hides, 0);
    }
    assert.equal(taps, 0);
    assert.equal(dismissFocusedKeyboard(), true);
    assert.equal(hides, 1);
  } finally { blurKeyboardField(token); globalThis.uni = previous; }
});

test('ordinary buttons execute once and dismiss the keyboard in the same single touch', () => {
  const sheet = compileSheet();
  const actions = [];
  focusKeyboardField(Symbol('typing'));
  touch({ tag: 'button', props: [{ name: 'bindtap', value: { content: '{{action}}' } }], bindings: { action: () => actions.push('save') }, parent: sheet.byClass('sheet-content') });
  assert.deepEqual(actions, ['save']);
  assert.deepEqual(sheet.keyboardDismissals, ['hide']);
  assert.deepEqual(sheet.events, []);
});

test('synthetic clicks and scroll gestures cannot dismiss a newly focused field', () => {
  const sheet = compileSheet();
  const content = sheet.byClass('sheet-content');
  const first = Symbol('previous field');
  const second = Symbol('delete family confirmation');
  focusKeyboardField(first);
  dispatch(content, 'touchstart');
  focusKeyboardField(second);
  dispatch(content, 'touchend');
  tap(content);
  dispatch(content, 'touchstart');
  dispatch(content, 'touchmove', { clientX: 120, clientY: 300 });
  dispatch(content, 'touchend', { clientX: 120, clientY: 300 });
  tap(content);
  assert.deepEqual(sheet.keyboardDismissals, []);
  blurKeyboardField(second);
});

test('reply focus stops taps and field containers cannot retarget native label focus', () => {
  const comment = readFileSync(new URL('../src/components/CommentItem.vue', import.meta.url), 'utf8');
  assert.match(comment, /@click\.stop="\$emit\('reply', entry\)"/);
  for (const name of ['FamilyEditor', 'RecipeEditor', 'StockEditor', 'SetEditor']) {
    const editor = readFileSync(new URL(`../src/components/${name}.vue`, import.meta.url), 'utf8');
    assert.doesNotMatch(editor, /<label\b/);
  }
});
