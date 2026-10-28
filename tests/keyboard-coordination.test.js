import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import postcss from 'postcss';
import { createFieldReveal } from '../src/composables/fieldReveal.js';
import { focusKeyboardField, dismissFocusedKeyboard } from '../src/services/keyboard.js';
import { keyboardLayout, nativeKeyboardInset, visualKeyboardFrame, keyboardTransition } from '../src/domain/mobile.js';
import { registerSheet } from '../src/composables/sheetStack.js';
import { sheetContentHeight } from '../src/composables/useSheetSizing.js';

function fieldHarness() {
  const timers = new Map();
  const measurements = [];
  const viewports = [];
  const reveals = [];
  let active = true;
  let sequence = 0;
  let scrollVersion = 0;
  const fields = createFieldReveal({
    isActive: () => active,
    measureViewport: (callback) => viewports.push(callback),
    reveal: (...args) => reveals.push(args),
    cancelScroll() {},
    scrollVersion: () => scrollVersion,
    schedule(callback) { const token = ++sequence; timers.set(token, callback); return token; },
    unschedule: (token) => timers.delete(token),
  });
  const measure = (callback) => measurements.push(callback);
  const flush = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach((callback) => callback()); };
  return { fields, measure, measurements, viewports, reveals, timers, flush, cover: () => { active = false; }, scrolled: () => { scrollVersion += 1; } };
}

test('platform scrolling during measurement discards mixed-frame coordinates before revealing', () => {
  const harness = fieldHarness();
  harness.fields.focus('step', harness.measure);
  harness.flush();
  harness.measurements[0]({ top: 600, bottom: 730 });
  harness.scrolled();
  harness.viewports[0]({ top: 100, bottom: 400, scrollTop: 500 });
  assert.equal(harness.reveals.length, 0);
  harness.flush();
  harness.measurements[1]({ top: 300, bottom: 430 });
  harness.viewports[1]({ top: 100, bottom: 400, scrollTop: 500 });
  assert.equal(harness.reveals.length, 1);
  assert.equal(harness.reveals[0][0].top, 300);
});

test('native scroll settling after measurement retries current coordinates, but a user gesture cancels it', async () => {
  for (const interrupt of [false, true]) {
    const timers = [];
    let attempts = 0;
    const fields = createFieldReveal({
      isActive: () => true,
      measureViewport: callback => callback({ top: 100, bottom: 400 }),
      reveal: () => { attempts += 1; return Promise.resolve(attempts > 1); },
      cancelScroll() {},
      schedule: callback => { timers.push(callback); return callback; },
      unschedule: callback => { const index = timers.indexOf(callback); if (index >= 0) timers.splice(index, 1); },
    });
    fields.focus('nutrition', callback => callback({ top: 350, bottom: 480 }));
    timers.shift()();
    if (interrupt) fields.interrupt();
    await Promise.resolve();
    if (timers.length) timers.shift()();
    assert.equal(attempts, interrupt ? 1 : 2);
    fields.clear();
  }
});

test('field switches ignore a late blur and cancel stale selector results', () => {
  const harness = fieldHarness();
  harness.fields.focus('recipe', harness.measure);
  harness.flush();
  harness.fields.focus('step', harness.measure);
  harness.fields.blur('recipe');
  harness.measurements[0]({ top: 900 });
  assert.equal(harness.viewports.length, 0);
  harness.flush();
  harness.measurements[1]({ top: 600 });
  harness.viewports[0]({ bottom: 400 });
  assert.deepEqual(harness.reveals, [[{ top: 600 }, { bottom: 400 }]]);
});

test('a finger touch cancels pending selectors and subsequent keyboard animation cannot steal scrolling', () => {
  const harness = fieldHarness();
  harness.fields.focus('comment', harness.measure);
  harness.flush();
  harness.measurements[0]({ top: 600 });
  harness.fields.interrupt();
  harness.viewports[0]({ bottom: 400 });
  harness.fields.request();
  harness.flush();
  assert.equal(harness.reveals.length, 0);
  assert.equal(harness.measurements.length, 1);
  harness.fields.focus('reply', harness.measure);
  harness.flush();
  assert.equal(harness.measurements.length, 2);
});

test('closed or covered sheets cannot apply delayed input scrolling', () => {
  for (const action of ['clear', 'cover']) {
    const harness = fieldHarness();
    harness.fields.focus('family', harness.measure);
    harness.flush();
    harness.measurements[0]({ top: 600 });
    if (action === 'clear') harness.fields.clear(); else harness.cover();
    harness.viewports[0]({ bottom: 400 });
    assert.equal(harness.reveals.length, 0);
  }
});

test('keyboard frame accounts for overlay, partial resize, full resize and browser panning', () => {
  for (const height of [844, 744, 544]) {
    const layout = keyboardLayout(height, nativeKeyboardInset(844, height, 300), 68);
    assert.equal(layout.maxHeight, 476);
    assert.equal(height - layout.bottom, 544);
  }
  assert.deepEqual(visualKeyboardFrame(844, { height: 508, offsetTop: 40 }), { bottom: 296, maxHeight: 508 });
  assert.deepEqual(visualKeyboardFrame(508, { height: 508, offsetTop: 0 }), { bottom: 0, maxHeight: 484 });
  assert.deepEqual(visualKeyboardFrame(844, { height: 844, offsetTop: 0 }), { bottom: 0, maxHeight: 820 });
  assert.equal(keyboardLayout(300, 500, 70).maxHeight, 0);
  assert.deepEqual([undefined, -1, 0, 250, 900].map(keyboardTransition), [240, 240, 0, 250, 400]);
});

async function loadComponent(name, web = false) {
  const filename = new URL(`../src/components/${name}.vue`, import.meta.url);
  let source = readFileSync(filename, 'utf8');
  if (web) source = source.replace(/\/\/ #ifdef MP-WEIXIN[\s\S]*?\/\/ #endif/g, '');
  let script = compileScript(parse(source).descriptor, { id: 'keyboard-component' }).content;
  const modules = [];
  for (const match of script.matchAll(/import (\{[^}]+\}) from '([^']+)';/g)) {
    const imported = match[2] === 'vue' ? Vue : await import(new URL(match[2], filename));
    script = script.replace(match[0], `const ${match[1]} = modules[${modules.length}];`);
    modules.push(imported);
  }
  return new Function('modules', script.replace('export default', 'return'))(modules);
}

async function mountSheet(context, web = false, geometry = null, props = {}, sizeRegions = null) {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const handlers = {};
  const nativeFrames = [];
  let height = 844;
  let sizingReads = 0;
  const oldUni = globalThis.uni;
  const oldWx = globalThis.wx;
  const oldWindow = globalThis.window;
  globalThis.uni = {
    getWindowInfo: () => ({ windowHeight: height, windowWidth: 390, statusBarHeight: 20 }),
    getMenuButtonBoundingClientRect: () => ({ bottom: 56 }),
    hideKeyboard() { handlers.hidden = (handlers.hidden || 0) + 1; },
    onKeyboardHeightChange: (callback) => { handlers.keyboard = callback; },
    offKeyboardHeightChange: () => { delete handlers.keyboard; },
    onWindowResize: (callback) => { handlers.resize = callback; },
    offWindowResize: () => { delete handlers.resize; },
    createSelectorQuery() {
      let sizing = false;
      return {
        in() { return this; }, select() { return this; },
        fields(options) { assert.deepEqual(options, { rect: true, size: true, scrollOffset: true }); return this; },
        boundingClientRect() { sizing = true; return this; },
        exec(callback) {
          if (!sizing) { callback(typeof geometry === 'function' ? geometry() : geometry || [{ top: 140, bottom: 400, scrollTop: 0 }]); return; }
          sizingReads += 1;
          const regions = typeof sizeRegions === 'function' ? sizeRegions(callback) : sizeRegions;
          if (regions !== undefined) callback(regions);
        },
      };
    },
  };
  globalThis.wx = web ? undefined : { nextTick: callback => nativeFrames.push(callback) };
  const viewportListeners = new Map();
  const windowListeners = new Map();
  let frame;
  if (web) globalThis.window = {
    innerHeight: 844,
    visualViewport: { height: 844, offsetTop: 0, addEventListener: (name, callback) => viewportListeners.set(name, callback), removeEventListener: (name) => viewportListeners.delete(name) },
    addEventListener: (name, callback) => windowListeners.set(name, callback), removeEventListener: (name) => windowListeners.delete(name),
    requestAnimationFrame(callback) { frame = callback; return 1; }, cancelAnimationFrame() { frame = undefined; },
  };
  const renderer = Vue.createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode() {}, nextSibling() {} });
  const component = await loadComponent('Sheet', web);
  component.render = () => null;
  const app = renderer.createApp(component, { title: '输入测试', ...props });
  app.mount({});
  const state = app._instance.setupState;
  const fields = app._instance.provides.sheetKeyboard;
  let measures = 0;
  const focus = (token = 'field') => fields.focus(token, (callback) => { measures += 1; callback({ top: 700, bottom: 750 }); });
  const nativeRender = async () => {
    await Vue.nextTick();
    await Vue.nextTick();
    nativeFrames.splice(0).forEach(callback => callback());
    await Vue.nextTick();
    context.mock.timers.tick(0);
    await Vue.nextTick();
  };
  const settle = async () => { for (let frame = 0; frame < 4; frame += 1) await nativeRender(); };
  context.after(() => { if (app._instance) app.unmount(); globalThis.uni = oldUni; globalThis.wx = oldWx; globalThis.window = oldWindow; });
  return { state, fields, focus, handlers, app, renderer, viewportListeners, windowListeners, nativeRender, settle, measures: () => measures, sizingReads: () => sizingReads,
    resize(next) { height = next; handlers.resize({ size: { windowHeight: height } }); },
    viewport(nextHeight, offsetTop = 0) { Object.assign(window.visualViewport, { height: nextHeight, offsetTop }); viewportListeners.get('resize')(); frame?.(); },
  };
}

test('native layout is committed before measuring inputs and duplicate keyboard heights do not scroll again', async (context) => {
  const sheet = await mountSheet(context);
  sheet.focus();
  sheet.handlers.keyboard({ height: 300, duration: 240 });
  assert.equal(sheet.state.backdropStyle.paddingBottom, '300px');
  assert.equal(sheet.state.scrollTop, 0);
  await Vue.nextTick();
  assert.equal(sheet.measures(), 0);
  await sheet.settle();
  assert.equal(sheet.state.sheetStyle.height, '476px');
  assert.equal(sheet.state.backdropStyle.paddingBottom, '300px');
  context.mock.timers.tick(100);
  sheet.fields.keyboard({ height: 300, duration: 240 }, 'field');
  context.mock.timers.tick(180);
  await Vue.nextTick();
  assert.equal(sheet.measures(), 1);
  assert.equal(sheet.state.scrollTop, 370);
  sheet.handlers.keyboard({ height: 0, duration: 240 });
  context.mock.timers.tick(120);
  assert.equal(sheet.state.backdropStyle.paddingBottom, '0px');
  assert.equal(sheet.state.sheetStyle.height, '776px');
});

test('native resize arriving before or after keyboard height does not double-lift the sheet', async (context) => {
  const sheet = await mountSheet(context);
  for (const order of ['resize-first', 'keyboard-first']) {
    sheet.focus();
    if (order === 'resize-first') sheet.resize(544);
    sheet.handlers.keyboard({ height: 300, duration: 200 });
    sheet.resize(544);
    await sheet.settle();
    assert.equal(sheet.state.backdropStyle.paddingBottom, '0px');
    assert.equal(sheet.state.sheetStyle.height, '476px');
    sheet.fields.blur('field');
    sheet.handlers.keyboard({ height: 0 });
    context.mock.timers.tick(120);
    sheet.resize(844);
    assert.equal(sheet.state.sheetStyle.height, '776px');
  }
});

test('multiline reveal uses actual resized geometry, never projected old scroll offsets', async context => {
  let viewport = { top: 140, bottom: 740, scrollTop: 100 };
  const sheet = await mountSheet(context, false, () => [viewport]);
  sheet.focus('nutrition');
  sheet.handlers.keyboard({ height: 300 });
  await Vue.nextTick();
  assert.equal(sheet.measures(), 0);
  assert.equal(sheet.state.scrollTop, 0);
  viewport = { top: 140, bottom: 440, scrollTop: 120 };
  await sheet.settle();
  assert.equal(sheet.state.scrollTop, 450);
  assert.equal(sheet.measures(), 1);
});

test('compact settings expand upward to preserve usable input space instead of anchoring their old top', async context => {
  const sheet = await mountSheet(context, false, null, { preferredHeight: 660 });
  const sheetTop = () => sheet.state.availableHeight - parseFloat(sheet.state.backdropStyle.paddingBottom) - parseFloat(sheet.state.sheetStyle.height);
  assert.equal(sheetTop(), 184);
  sheet.focus('delete-name');
  for (const height of [300, 340, 280]) {
    sheet.handlers.keyboard({ height });
    await sheet.settle();
    assert.equal(sheetTop(), 68);
    assert.ok(parseFloat(sheet.state.sheetStyle.height) >= 436);
  }
  sheet.resize(564);
  await sheet.settle();
  assert.equal(sheetTop(), 68);
  sheet.fields.blur('delete-name');
  sheet.handlers.keyboard({ height: 0 });
  context.mock.timers.tick(80);
  sheet.resize(844);
  assert.equal(sheetTop(), 184);
});

test('keyboard layout never shrinks the fullscreen mask or reveals interactive background content', async context => {
  const sheet = await mountSheet(context);
  sheet.focus();
  for (const height of [300, 360, 0]) {
    sheet.handlers.keyboard({ height });
    context.mock.timers.tick(80);
    await sheet.settle();
    for (const property of ['bottom', 'top', 'height', 'maxHeight', 'transform']) assert.equal(sheet.state.backdropStyle[property], undefined);
    assert.equal(sheet.state.backdropStyle.paddingBottom, `${height}px`);
  }
  const css = postcss.parse(readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8'));
  for (const name of ['.sheet-mask', '.sheet-backdrop']) {
    const rule = css.nodes.find(node => node.type === 'rule' && node.selector === name);
    assert.equal(rule.nodes.find(node => node.prop === 'inset')?.value, '0');
  }
});

test('native blur restores the sheet even when iOS never sends zero keyboard height', async context => {
  const sheet = await mountSheet(context, false, null, { preferredHeight: 660 });
  sheet.focus('delete-name');
  sheet.handlers.keyboard({ height: 350 });
  await sheet.settle();
  sheet.fields.blur('delete-name');
  sheet.handlers.keyboard({ height: 350 });
  context.mock.timers.tick(80);
  await sheet.settle();
  assert.equal(sheet.state.keyboard, 0);
  assert.equal(sheet.state.sheetStyle.height, '660px');
  assert.equal(sheet.state.backdropStyle.paddingBottom, '0px');
  sheet.handlers.keyboard({ height: 350 });
  assert.equal(sheet.state.keyboard, 0, 'late positive events cannot reopen an unfocused sheet');
  assert.equal(sheet.handlers.hidden || 0, 0, 'native blur does not issue a second hideKeyboard');
});

test('explicit dismissal resets immediately even without a native blur or height callback', async context => {
  const sheet = await mountSheet(context);
  sheet.focus('stock-quantity');
  focusKeyboardField('stock-quantity', () => sheet.fields.dismiss('stock-quantity'));
  sheet.handlers.keyboard({ height: 320 });
  await sheet.settle();
  const measured = sheet.measures();
  assert.equal(dismissFocusedKeyboard(), true);
  assert.equal(sheet.state.keyboard, 0);
  assert.equal(sheet.state.backdropStyle.paddingBottom, '0px');
  sheet.handlers.keyboard({ height: 320 });
  await sheet.settle();
  assert.equal(sheet.state.keyboard, 0);
  assert.equal(sheet.handlers.hidden, 1);
  assert.equal(sheet.measures(), measured);
});

test('a new focus cannot cancel a real keyboard-close event and leave the panel permanently lifted', async context => {
  const sheet = await mountSheet(context);
  sheet.focus('old');
  sheet.handlers.keyboard({ height: 300 });
  await sheet.settle();
  sheet.fields.blur('old');
  sheet.handlers.keyboard({ height: 0 });
  sheet.focus('new');
  for (let count = 0; count < 5; count += 1) {
    context.mock.timers.tick(20);
    sheet.handlers.keyboard({ height: 0 });
  }
  assert.equal(sheet.state.keyboard, 0);
  assert.equal(sheet.state.fields.owns('new'), true, 'layout reset does not steal a hardware keyboard focus');
});

test('retargeted native touches after focus neither hide the keyboard nor cancel field visibility', async context => {
  const sheet = await mountSheet(context);
  sheet.focus('nutrition');
  focusKeyboardField('nutrition', () => sheet.fields.dismiss('nutrition'));
  sheet.handlers.keyboard({ height: 350 });
  const event = { target: { dataset: {} }, changedTouches: [{ clientX: 120, clientY: 620 }] };
  sheet.state.startSurfaceGesture(event);
  sheet.state.surfaceGesture.end(event);
  await sheet.settle();
  assert.equal(sheet.measures(), 1);
  assert.equal(sheet.handlers.hidden || 0, 0);
  assert.equal(sheet.state.keyboard, 350);
});

test('actual finger drags still cancel pending native field positioning', async context => {
  const sheet = await mountSheet(context);
  sheet.focus('nutrition');
  sheet.handlers.keyboard({ height: 350 });
  sheet.state.startSurfaceGesture({ touches: [{ clientX: 120, clientY: 620 }] });
  sheet.state.surfaceGesture.move({ touches: [{ clientX: 120, clientY: 560 }] });
  await sheet.settle();
  assert.equal(sheet.measures(), 0);
});

test('family, stock, recipe, set, checkout and profile fields share the same focus and dismissal lifecycle', async context => {
  const sheet = await mountSheet(context);
  const component = await loadComponent('FormField');
  component.render = () => null;
  const renderer = Vue.createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode() {}, nextSibling() {} });
  for (const multiline of [false, true]) {
    const app = renderer.createApp(component, { modelValue: '原有文字', multiline });
    app.provide('sheetKeyboard', sheet.fields);
    app.mount({});
    const field = app._instance.setupState;
    field.onFocus({ detail: { height: 320 } });
    assert.equal(sheet.state.keyboard, 320);
    assert.equal(dismissFocusedKeyboard(), true);
    assert.equal(sheet.state.keyboard, 0);
    field.keyboardChange({ detail: { height: 320 } });
    assert.equal(sheet.state.keyboard, 0);
    field.onFocus({ detail: { height: 320 } });
    field.onBlur({ detail: { value: '原有文字' } });
    context.mock.timers.tick(80);
    assert.equal(sheet.state.keyboard, 0);
    app.unmount();
  }
});

test('a section reset cannot dismiss a new field or reset its scroll after focus', async context => {
  const sheet = await mountSheet(context);
  sheet.state.onScroll({ detail: { scrollTop: 300 } });
  sheet.app._instance.exposed.resetScroll();
  sheet.focus('delete-name');
  await sheet.settle();
  assert.equal(sheet.state.fields.owns('delete-name'), true);
  assert.equal(sheet.handlers.hidden || 0, 0);
  assert.equal(sheet.state.scrollTop, 0);
});

test('search result resets preserve keyboard ownership and return the existing scroller to the top', async context => {
  const sheet = await mountSheet(context, false, null, { fitContent: false, preferredHeight: 640 });
  sheet.focus('search');
  sheet.state.onScroll({ detail: { scrollTop: 280 } });
  sheet.app._instance.exposed.resetScroll({ preserveFocus: true });
  await sheet.settle();
  assert.ok(Math.abs(sheet.state.scrollTop) <= .1);
  assert.equal(sheet.state.fields.owns('search'), true);
  assert.equal(sheet.handlers.hidden || 0, 0);
  sheet.fields.keyboard({ height: 300 }, 'search');
  await sheet.settle();
  assert.equal(sheet.state.keyboard, 300);
  assert.equal(sheet.state.sheetStyle.height, '476px');
  assert.equal(sheet.state.fields.owns('search'), true);
});

test('bounded add-dishes sheet never resizes on result changes or hardware-keyboard blur', async context => {
  const sheet = await mountSheet(context, false, null, { fitContent: false, preferredHeight: 640 });
  await sheet.settle();
  for (const contentHeight of [1050, 280, 460, 1050]) {
    sheet.focus('search');
    sheet.state.contentHeight = contentHeight;
    sheet.state.resizeContent();
    await sheet.settle();
    assert.equal(sheet.state.sheetStyle.height, '640px');
    sheet.fields.blur('search');
    context.mock.timers.tick(100);
    await sheet.settle();
    assert.equal(sheet.state.sheetStyle.height, '640px');
  }
  assert.equal(sheet.sizingReads(), 0);
  sheet.focus('search');
  sheet.fields.keyboard({ height: 300 }, 'search');
  await sheet.settle();
  assert.equal(sheet.state.sheetStyle.height, '476px');
  sheet.fields.blur('search');
  context.mock.timers.tick(100);
  await sheet.settle();
  assert.equal(sheet.state.sheetStyle.height, '640px');
});

test('native layout changes cannot scroll before the native renderer acknowledges them', async context => {
  const sheet = await mountSheet(context);
  sheet.focus('step');
  sheet.handlers.keyboard({ height: 300 });
  context.mock.timers.tick(1000);
  await Vue.nextTick();
  assert.equal(sheet.measures(), 0);
  assert.equal(sheet.state.scrollTop, 0);
  await sheet.settle();
  assert.equal(sheet.state.scrollTop, 370);
});

test('switching fields during native measurement reveals the new field and ignores the stale result', async context => {
  const sheet = await mountSheet(context);
  let finishOld;
  sheet.fields.focus('old', callback => { finishOld = callback; });
  sheet.handlers.keyboard({ height: 300 });
  await sheet.settle();
  sheet.fields.focus('delete-name', callback => callback({ top: 410, bottom: 460 }));
  finishOld({ top: 800, bottom: 950 });
  await sheet.settle();
  assert.equal(sheet.state.scrollTop, 80);
  assert.equal(sheet.state.backdropStyle.paddingBottom, '300px');
  assert.equal(sheet.fields.keyboard({ height: 300 }, 'old'), undefined);
});

test('real Sheet blur tokens and touch interruption prevent late automatic scrolling', async (context) => {
  const sheet = await mountSheet(context);
  sheet.focus('old');
  sheet.focus('new');
  sheet.fields.blur('old');
  sheet.handlers.keyboard({ height: 300 });
  await sheet.settle();
  sheet.state.cancelReveal();
  sheet.handlers.keyboard({ height: 330 });
  await sheet.settle();
  context.mock.timers.tick(1000);
  assert.equal(sheet.measures(), 1);
  sheet.focus('another');
  context.mock.timers.tick(60);
  assert.equal(sheet.measures(), 2);
});

test('focus with an already open keyboard reveals once without an artificial animation delay', async (context) => {
  const sheet = await mountSheet(context);
  sheet.focus('previous');
  sheet.handlers.keyboard({ height: 300, duration: 240 });
  await sheet.settle();
  const previousMeasures = sheet.measures();
  context.mock.timers.tick(20);
  sheet.focus();
  context.mock.timers.tick(100);
  assert.equal(sheet.measures(), previousMeasures + 1);
  context.mock.timers.tick(160);
  assert.equal(sheet.measures(), previousMeasures + 1);
  const field = readFileSync(new URL('../src/components/FormField.vue', import.meta.url), 'utf8');
  assert.match(field, /event.detail\?\.height > 0/);
  assert.match(field, /sheet\?\.keyboard\(event.detail, token\)/);
});

test('a slow keyboard opening never scrolls against the old viewport first', async (context) => {
  const sheet = await mountSheet(context);
  sheet.focus('step-description');
  context.mock.timers.tick(450);
  assert.equal(sheet.measures(), 0);
  sheet.handlers.keyboard({ height: 300, duration: 240 });
  await sheet.settle();
  context.mock.timers.tick(150);
  sheet.resize(544);
  context.mock.timers.tick(130);
  await sheet.settle();
  assert.equal(sheet.measures(), 2);
  assert.ok(Math.abs(sheet.state.scrollTop - 370) <= .1 + Number.EPSILON * 370);
});

test('focus with a hardware keyboard does not issue an unnecessary scroll command', async (context) => {
  const sheet = await mountSheet(context);
  sheet.focus('step-title');
  context.mock.timers.tick(1000);
  assert.equal(sheet.measures(), 0);
  assert.equal(sheet.state.scrollTop, 0);
});

test('web visual viewport follows keyboard frames without another animation and reveals once after settling', async (context) => {
  const sheet = await mountSheet(context, true);
  assert.equal(sheet.handlers.keyboard, undefined);
  sheet.focus();
  for (const height of [800, 760, 700, 640, 580, 508]) {
    sheet.viewport(height);
    context.mock.timers.tick(16);
  }
  assert.equal(sheet.state.backdropStyle.paddingBottom, '336px');
  assert.equal(sheet.state.sheetStyle.height, '484px');
  assert.equal(sheet.state.backdropStyle['--keyboard-duration'], undefined);
  assert.equal(sheet.measures(), 0);
  context.mock.timers.tick(100);
  assert.equal(sheet.measures(), 1);
  sheet.viewport(508, 40);
  assert.equal(sheet.state.backdropStyle.paddingBottom, '296px');
  assert.equal(sheet.state.sheetStyle.height, '508px');
  sheet.fields.blur('field');
  sheet.viewport(844);
  assert.equal(sheet.state.keyboard, 0);
  assert.equal(sheet.state.sheetStyle.height, '784px');
  sheet.app.unmount();
  assert.equal(sheet.viewportListeners.size, 0);
  assert.equal(sheet.windowListeners.size, 0);
});

test('family cover and management open the existing editor while bottom navigation remains synchronous', () => {
  const source = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8');
  const family = readFileSync(new URL('../src/components/FamilyView.vue', import.meta.url), 'utf8');
  assert.match(family, /<PageHeader :title="familyDisplay.name" \/>/);
  assert.match(family, /const familyDisplay = computed\(\(\) => familyAppearance\(state.value.family\)\);/);
  assert.match(source, /function editFamily\(initialTab = 'appearance'\) \{ dismissFocusedKeyboard\(\); tapFeedback\(\); familyEditorTab.value = initialTab; editingFamily.value = true;/);
  assert.match(source, /<FamilyView[^>]*@customize="editFamily\(\)"/);
  assert.doesNotMatch(source, /@manage="editFamily\('management'\)"/);
  assert.match(source, /@click="selectNavigation\(item\.id\)"/);
  assert.doesNotMatch(source, /async function selectNavigation/);
});

test('input focus never introduces CSS geometry or programmatic scroll animation', async (context) => {
  const sheet = await mountSheet(context);
  sheet.focus();
  sheet.handlers.keyboard({ height: 300, duration: 250 });
  assert.ok(!sheet.state.backdropStyle['--keyboard-duration'] || sheet.state.backdropStyle['--keyboard-duration'] === '0ms');
  const source = readFileSync(new URL('../src/components/Sheet.vue', import.meta.url), 'utf8');
  assert.match(source, /:scroll-with-animation="false"/);
  const css = postcss.parse(readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8'));
  css.walkRules((rule) => {
    if (!rule.selectors.some((selector) => /^\.sheet(?:$|-(?:backdrop|scroll|content|footer|header)$)/.test(selector))) return;
    rule.walkDecls((declaration) => {
      if (/^(?:transition|animation)/.test(declaration.prop)) assert.equal(declaration.value, 'none', rule.selector);
    });
  });
});

test('closing a non-input picker cannot send hideKeyboard after a parent field refocuses', async (context) => {
  const sheet = await mountSheet(context);
  sheet.app.unmount();
  assert.equal(sheet.handlers.hidden || 0, 0);
});

test('brief zero-height events while moving between fields do not collapse and reopen the sheet', async (context) => {
  const sheet = await mountSheet(context);
  sheet.focus('title');
  sheet.handlers.keyboard({ height: 300 });
  await sheet.settle();
  sheet.fields.blur('title');
  sheet.handlers.keyboard({ height: 0 });
  context.mock.timers.tick(30);
  assert.equal(sheet.state.backdropStyle.paddingBottom, '300px');
  sheet.focus('description');
  sheet.handlers.keyboard({ height: 300 });
  context.mock.timers.tick(1000);
  assert.equal(sheet.state.backdropStyle.paddingBottom, '300px');
  sheet.fields.blur('description');
  sheet.handlers.keyboard({ height: 0 });
  context.mock.timers.tick(160);
  assert.equal(sheet.state.backdropStyle.paddingBottom, '0px');
});

test('focus events only contribute positive keyboard heights and field teardown releases its own token', async () => {
  const calls = [];
  const component = await loadComponent('FormField');
  component.render = () => null;
  const renderer = Vue.createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode() {}, nextSibling() {} });
  const app = renderer.createApp(component, { modelValue: '原有文字' });
  app.provide('sheetKeyboard', { focus: (token) => calls.push(['focus', token]), blur: (token) => calls.push(['blur', token]), keyboard: (event, token) => calls.push(['keyboard', event.height, token]) });
  app.mount({});
  try {
    const field = app._instance.setupState;
    field.onFocus({ detail: { height: 0, value: '原有文字' } });
    assert.deepEqual(calls.map((call) => call[0]), ['focus']);
    field.onFocus({ detail: { height: 300 } });
    assert.deepEqual(calls.map((call) => call[0]), ['focus', 'focus', 'keyboard']);
    assert.equal(calls[2][2], calls[0][1]);
  } finally { app.unmount(); }
  assert.deepEqual(calls.at(-1), ['blur', calls[0][1]]);
});

test('closing an active input sheet dismisses its keyboard exactly once and cancels pending work', async (context) => {
  const sheet = await mountSheet(context);
  sheet.focus();
  sheet.handlers.keyboard({ height: 300 });
  sheet.handlers.keyboard({ height: 0 });
  sheet.app.unmount();
  context.mock.timers.tick(1000);
  assert.equal(sheet.handlers.hidden, 1);
  assert.equal(sheet.measures(), 0);
  await Vue.nextTick();
  assert.equal(sheet.state.scrollTop, 0);
  assert.equal(sheet.handlers.keyboard, undefined);
  assert.equal(sheet.handlers.resize, undefined);
});

test('form taps are excluded from surface keyboard dismissal and native labels cannot retarget them', () => {
  const field = readFileSync(new URL('../src/components/FormField.vue', import.meta.url), 'utf8');
  const sheet = readFileSync(new URL('../src/components/Sheet.vue', import.meta.url), 'utf8');
  assert.match(field, /data-keyboard-field="true"/);
  assert.doesNotMatch(field, /@(?:touchstart|touchend|mousedown)(?:\.|=|\s)/);
  assert.match(sheet, /enabled: \(\) => Boolean\(syncViewport\)/);
  assert.doesNotMatch(sheet, /function startSurfaceGesture\(event\) \{\s*if/);
  assert.match(sheet, /@touchend="surfaceGesture.end"/);
  assert.doesNotMatch(sheet, /@click.stop="dismissFocusedKeyboard"/);
  for (const name of ['RecipeEditor', 'SetEditor', 'FamilyEditor', 'FamilyManagement', 'ProfileFields', 'StockEditor', 'CloudConnection']) {
    const source = readFileSync(new URL(`../src/components/${name}.vue`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /<label\b/, name);
  }
});

test('sheet sizing includes measured header, body, footer and safe-area padding without fractional clipping', () => {
  assert.equal(sheetContentHeight([{ height: 61 }, { height: 184.2 }, { height: 107 }], true), 353);
  assert.equal(sheetContentHeight([{ height: 61 }, { height: 184.2 }, null], false), 246);
  for (const regions of [null, [], [null, { height: 20 }], [{ height: 61 }, { height: 0 }], [{ height: 61 }, { height: NaN }]]) {
    assert.equal(sheetContentHeight(regions, false), 0);
  }
  assert.equal(sheetContentHeight([{ height: 61 }, { height: 184 }], true), 0);
});

test('short sheets fit content before becoming visible and preferredHeight is only a ceiling', async (context) => {
  const sheet = await mountSheet(context, false, null, { preferredHeight: 660 }, [{ height: 60 }, { height: 200 }, { height: 74 }]);
  sheet.app._instance.slots.footer = () => [];
  assert.equal(sheet.state.sheetStyle.visibility, 'hidden');
  assert.equal(sheet.sizingReads(), 0);
  await sheet.settle();
  assert.equal(sheet.state.sheetStyle.height, '334px');
  assert.equal(sheet.state.sheetStyle.visibility, 'visible');
  sheet.app._instance.props.footerVisible = false;
  await sheet.settle();
  assert.equal(sheet.state.sheetStyle.height, '260px');
});

test('long sheets keep a bounded scroll viewport and can shrink again after content changes', async (context) => {
  let content = 1800;
  const sheet = await mountSheet(context, false, null, {}, () => [{ height: 60 }, { height: content }]);
  await sheet.settle();
  assert.equal(sheet.state.contentHeight, 1860);
  assert.equal(sheet.state.sheetStyle.height, '776px');
  content = 220;
  sheet.app._instance.provides.sheetContentResize();
  await sheet.settle();
  assert.equal(sheet.state.sheetStyle.height, '280px');
  sheet.app._instance.props.preferredHeight = 240;
  await sheet.settle();
  assert.equal(sheet.state.sheetStyle.height, '240px');
});

test('content fitting never runs while a field is focused or changes the existing keyboard frame', async (context) => {
  let content = 220;
  const sheet = await mountSheet(context, false, null, {}, () => [{ height: 60 }, { height: content }]);
  await sheet.settle();
  const baseline = sheet.sizingReads();
  sheet.focus();
  sheet.state.resizeContent();
  await sheet.settle();
  assert.equal(sheet.sizingReads(), baseline);
  sheet.handlers.keyboard({ height: 300 });
  content = 340;
  sheet.state.resizeContent();
  await sheet.settle();
  assert.equal(sheet.state.sheetStyle.height, '476px');
  assert.equal(sheet.sizingReads(), baseline);
  sheet.fields.dismiss('field');
  assert.equal(sheet.state.sheetStyle.height, '280px');
  await sheet.settle();
  assert.equal(sheet.state.sheetStyle.height, '400px');
});

test('scrolling does not query sheet dimensions and resize notifications are coalesced', async (context) => {
  const sheet = await mountSheet(context, false, null, {}, [{ height: 60 }, { height: 900 }]);
  await sheet.settle();
  const baseline = sheet.sizingReads();
  for (let offset = 0; offset < 40; offset += 1) sheet.state.onScroll({ detail: { scrollTop: offset * 5 } });
  await sheet.settle();
  assert.equal(sheet.sizingReads(), baseline);
  for (let notification = 0; notification < 10; notification += 1) sheet.state.resizeContent();
  await sheet.settle();
  assert.equal(sheet.sizingReads(), baseline + 1);
});

test('a newer content measurement supersedes stale native selector callbacks', async (context) => {
  const pending = [];
  const sheet = await mountSheet(context, false, null, {}, callback => { pending.push(callback); });
  await sheet.settle();
  sheet.state.resizeContent();
  await sheet.settle();
  pending[1]([{ height: 60 }, { height: 250 }]);
  pending[0]([{ height: 60 }, { height: 900 }]);
  assert.equal(sheet.state.sheetStyle.height, '310px');
});

test('covered sheets ignore late sizes and remeasure when their child sheet closes', async (context) => {
  const pending = [];
  const sheet = await mountSheet(context, false, null, {}, callback => { pending.push(callback); });
  await sheet.settle();
  const child = sheet.renderer.createApp({ setup() { const layer = registerSheet(); Vue.onUnmounted(layer.close); return () => null; } });
  child.mount({});
  context.after(() => { if (child._instance) child.unmount(); });
  pending[0]([{ height: 60 }, { height: 800 }]);
  await sheet.settle();
  assert.equal(sheet.state.contentHeight, 0);
  child.unmount();
  await sheet.settle();
  pending.at(-1)([{ height: 60 }, { height: 220 }]);
  assert.equal(sheet.state.sheetStyle.height, '280px');
});

test('unmounted sheets discard pending sizing work and do not resurrect the dialog', async (context) => {
  const pending = [];
  const sheet = await mountSheet(context, false, null, {}, callback => { pending.push(callback); });
  await sheet.settle();
  sheet.app.unmount();
  pending[0]([{ height: 60 }, { height: 220 }]);
  context.mock.timers.tick(200);
  assert.equal(sheet.state.contentHeight, 0);
  assert.equal(sheet.state.sizeReady, false);
});

test('unavailable measurement cannot leave a sheet hidden or collapse it to zero height', async (context) => {
  const sheet = await mountSheet(context, false, null, { preferredHeight: 660 }, () => undefined);
  await sheet.settle();
  context.mock.timers.tick(160);
  assert.equal(sheet.state.sheetStyle.visibility, 'visible');
  assert.equal(sheet.state.sheetStyle.height, '660px');
});

test('image cropper can opt out of content sizing to keep its drag coordinates stable', async (context) => {
  const sheet = await mountSheet(context, false, null, { preferredHeight: 700, fitContent: false }, [{ height: 60 }, { height: 220 }]);
  await sheet.settle();
  assert.equal(sheet.sizingReads(), 0);
  assert.equal(sheet.state.sheetStyle.visibility, 'visible');
  assert.equal(sheet.state.sheetStyle.height, '700px');
  const cropper = readFileSync(new URL('../src/components/ImageCropper.vue', import.meta.url), 'utf8');
  assert.match(cropper, /:fit-content="false"/);
});

test('share confirmation has one full-width publish action and retains its error and duplicate-submit guards', () => {
  const share = readFileSync(new URL('../src/components/ShareSheet.vue', import.meta.url), 'utf8');
  assert.doesNotMatch(share, /重新选择|先不分享|secondary-button|detail-actions/);
  assert.match(share, /<button v-if="confirming" role="button" class="primary-button full"[^>]*@click="publish"/);
  assert.match(share, /:disabled="busy \|\| !canPublish"/);
  assert.match(share, /if \(busy.value \|\| !canPublish.value\) return/);
  assert.match(share, /catch \(failure\) \{ if \(!disposed\) error.value = failure.message; \}/);
  assert.match(share, /role="alert"/);
  assert.match(share, /share-preview-cover/);
});

test('nested async panels and natural image loads notify the shared size owner', () => {
  for (const name of ['FamilyManagement', 'ImagePicker', 'StepImagePicker', 'RecipeContent']) {
    const source = readFileSync(new URL(`../src/components/${name}.vue`, import.meta.url), 'utf8');
    assert.match(source, /useSheetContentResize\(\)/, name);
  }
  const image = readFileSync(new URL('../src/components/LazyImage.vue', import.meta.url), 'utf8');
  assert.match(image, /useSheetContentResize\(\(\) => props.mode === 'widthFix'\)/);
  assert.match(image, /@load="imageLoaded"/);
  assert.match(image, /const imageLoaded = computed\([\s\S]*?resizeSheet\(\);/);
});

for (const web of [false, true]) {
  test(`search results keep the focused sheet stable, then shrink after blur (web=${web})`, async context => {
    let content = 800;
    const sheet = await mountSheet(context, web, null, { preferredHeight: 640 }, () => [{ height: 60 }, { height: content }]);
    await sheet.settle();
    assert.equal(sheet.state.sheetStyle.height, '640px');
    sheet.focus('search');
    content = 150;
    sheet.state.resizeContent();
    await sheet.settle();
    assert.equal(sheet.state.sheetStyle.height, '640px');
    sheet.fields.blur('search');
    context.mock.timers.tick(100);
    await sheet.settle();
    assert.equal(sheet.state.sheetStyle.height, '210px');
  });
}
