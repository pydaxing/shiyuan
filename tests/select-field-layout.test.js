import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import { baseParse } from '@vue/compiler-dom';
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue';
import postcss from 'postcss';
import { selectDropdownGeometry } from '../src/domain/select-dropdown.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const selectSource = read('../src/components/SelectField.vue');
const stylesheet = postcss.parse(read('../src/styles.css'));

function templateNodes(source) {
  const nodes = [];
  function walk(node) {
    if (node.type !== 1) return;
    nodes.push(node);
    node.children.forEach(walk);
  }
  baseParse(parse(source).descriptor.template.content).children.forEach(walk);
  return nodes;
}

const attribute = (node, name) => node.props.find(prop => prop.type === 6 && prop.name === name)?.value?.content;
const binding = (node, name) => node.props.find(prop => prop.type === 7 && prop.name === 'bind' && prop.arg?.content === name)?.exp?.content;

function selectFixture(context, properties) {
  const events = [];
  const unmounts = [];
  const resizeListeners = new Set();
  const pending = [];
  const layout = { anchor: { left: 100, bottom: 140 }, viewport: { windowWidth: 375, windowHeight: 667 }, defer: false };
  let keyboardDismissals = 0;
  let disposed = false;
  const modules = {
    computed, nextTick, ref, watch, selectDropdownGeometry,
    getCurrentInstance: () => ({ uid: 7, proxy: {} }),
    onUnmounted: callback => unmounts.push(callback),
    afterNativeRender: () => Promise.resolve(),
    dismissFocusedKeyboard() { keyboardDismissals += 1; },
  };
  const nativeRuntime = {
    getWindowInfo: () => layout.viewport,
    onWindowResize: callback => resizeListeners.add(callback),
    offWindowResize: callback => resizeListeners.delete(callback),
    createSelectorQuery() {
      let complete;
      return {
        in() { return this; },
        select(selector) { assert.equal(selector, '.choice-trigger'); return this; },
        boundingClientRect(callback) { complete = () => callback(layout.anchor); return this; },
        exec() { if (layout.defer) pending.push(complete); else complete(); },
      };
    },
  };
  let script = compileScript(parse(selectSource).descriptor, { id: 'select-field-layout' }).content;
  script = script.replace(/import (\{[^}]+\}|\w+) from '[^']+';/g, (_, imported) => `const ${imported} = ${imported.startsWith('{') ? 'modules' : '{}'};`);
  const component = new Function('modules', 'uni', script.replace('export default', 'return'))(modules, nativeRuntime);
  const scope = effectScope();
  const props = reactive(properties);
  const field = scope.run(() => component.setup(props, { expose() {}, emit: (...args) => events.push(args) }));
  function dispose() {
    if (disposed) return;
    disposed = true;
    unmounts.forEach(callback => callback());
    scope.stop();
  }
  context.after(dispose);
  return { field, props, events, layout, pending, resizeListeners, dispose, keyboardDismissals: () => keyboardDismissals };
}

function declarationsFor(selector, media = '') {
  const declarations = new Map();
  stylesheet.walkRules(rule => {
    const ruleMedia = rule.parent.type === 'atrule' ? rule.parent.params : '';
    if (ruleMedia === media && rule.selectors.includes(selector)) rule.walkDecls(declaration => declarations.set(declaration.prop, declaration.value));
  });
  return declarations;
}

test('ingredient units and recipe categories opt into their own shared compact grids', () => {
  const recipeSelectors = templateNodes(read('../src/components/RecipeEditor.vue')).filter(node => node.tag === 'SelectField');
  const units = recipeSelectors.find(node => binding(node, 'options') === 'ingredientUnitOptions');
  const categories = recipeSelectors.find(node => binding(node, 'options') === 'CATEGORIES');
  assert.equal(attribute(units, 'variant'), 'units');
  assert.equal(attribute(categories, 'variant'), 'categories');
  const stockUnits = templateNodes(read('../src/components/StockEditor.vue')).find(node => node.tag === 'SelectField');
  assert.equal(attribute(stockUnits, 'variant'), 'units');
  assert.equal(binding(stockUnits, 'disabled'), 'purchase');
  assert.equal(binding(stockUnits, 'options'), 'SELECTABLE_UNITS');
});

test('unit and category sheets size to compact content without changing the default selector height', () => {
  const nodes = templateNodes(selectSource);
  const sheet = nodes.find(node => node.tag === 'Sheet');
  const preferredHeight = new Function('variant', 'options', `return ${binding(sheet, 'preferred-height')}`);
  const options = Array.from({ length: 43 }, (_, index) => String(index));
  assert.equal(preferredHeight('units', options), 0);
  assert.equal(preferredHeight('categories', options.slice(0, 7)), 0);
  assert.equal(preferredHeight(undefined, options), 156 + 22 * 70);
  assert.equal(preferredHeight(undefined, options.slice(0, 4)), 296);
  const grid = nodes.find(node => attribute(node, 'class') === 'choice-options');
  const gridClasses = new Function('variant', `return ${binding(grid, 'class')}`);
  assert.deepEqual(gridClasses('units'), { 'choice-options-units': true, 'choice-options-categories': false });
  assert.deepEqual(gridClasses('categories'), { 'choice-options-units': false, 'choice-options-categories': true });
  assert.deepEqual(gridClasses(undefined), { 'choice-options-units': false, 'choice-options-categories': false });
  assert.equal(binding(sheet, 'fit-content'), undefined);
});

test('compact units use five mobile columns, four narrow columns and six desktop columns', () => {
  const selector = '.choice-options.choice-options-units';
  assert.equal(declarationsFor(selector).get('grid-template-columns'), 'repeat(5, minmax(0, 1fr))');
  assert.equal(declarationsFor(selector, '(max-width: 360px)').get('grid-template-columns'), 'repeat(4, minmax(0, 1fr))');
  assert.equal(declarationsFor(selector, '(min-width: 761px)').get('grid-template-columns'), 'repeat(6, minmax(0, 1fr))');
  assert.equal(declarationsFor(selector).get('gap'), '8px');
  assert.equal(declarationsFor('.choice-options').get('grid-template-columns'), 'repeat(2, minmax(0, 1fr))');
  const buttons = declarationsFor(`${selector} button`);
  assert.equal(buttons.get('min-height'), '44px');
  assert.equal(buttons.get('justify-content'), 'center');
  assert.equal(buttons.get('text-align'), 'center');
  assert.equal(buttons.get('font-size'), 'var(--type-control)');
  assert.equal(buttons.get('white-space'), 'nowrap');
});

test('the compact checkmark stays out of text flow and preserves the selected accessibility state', () => {
  const checkmark = declarationsFor('.choice-options.choice-options-units .app-icon');
  assert.equal(checkmark.get('position'), 'absolute');
  assert.equal(checkmark.get('width'), '12px');
  assert.equal(checkmark.get('height'), '12px');
  const nodes = templateNodes(selectSource);
  const option = nodes.find(node => node.tag === 'button' && node.props.some(prop => prop.name === 'for'));
  const pressed = new Function('modelValue', 'option', `return ${binding(option, 'aria-pressed')}`);
  assert.equal(pressed('少许', '少许'), true);
  assert.equal(pressed('荤菜', '荤菜'), true);
  assert.equal(pressed('荤菜', '素菜'), false);
  assert.equal(binding(option, 'class'), '{ selected: modelValue === option }');
  const feedOption = nodes.find(node => attribute(node, 'class') === 'select-dropdown-option');
  const selected = new Function('modelValue', 'option', 'active', `return ${binding(feedOption, 'aria-selected')}`);
  assert.equal(selected('荤菜', '荤菜', false), false);
  assert.equal(selected('荤菜', '荤菜', true), true);
  assert.equal(selected('荤菜', '素菜', true), false);
  assert.equal(binding(feedOption, 'class'), '{ selected: active && modelValue === option }');
  assert.equal(declarationsFor('.choice-options button.selected').get('background'), 'var(--control-accent)');
});

test('recipe categories use four columns with the same touch targets and checkmarks as units', () => {
  const categories = '.choice-options.choice-options-categories';
  const units = '.choice-options.choice-options-units';
  assert.equal(declarationsFor(categories).get('grid-template-columns'), 'repeat(4, minmax(0, 1fr))');
  assert.equal(declarationsFor(categories).get('gap'), '8px');
  for (const suffix of [' button', ' .app-icon']) {
    assert.deepEqual(declarationsFor(`${categories}${suffix}`), declarationsFor(`${units}${suffix}`));
  }
  for (const media of ['(max-width: 360px)', '(min-width: 761px)']) {
    assert.equal(declarationsFor(categories, media).has('grid-template-columns'), false);
  }
});

test('choosing a compact unit or category still emits the original value and closes the sheet', async context => {
  for (const [variant, options, nextValue] of [
    ['units', ['适量', '少许', 'g'], 'g'],
    ['categories', ['荤菜', '素菜', '汤羹'], '素菜'],
  ]) {
    const current = selectFixture(context, { variant, modelValue: options[0], options });
    const { field } = current;
    await field.show();
    assert.equal(field.open.value, true);
    field.choose(nextValue);
    assert.equal(field.open.value, false);
    assert.equal(current.keyboardDismissals(), 1);
    assert.deepEqual(current.events, [['update:modelValue', nextValue]]);
    assert.equal(current.resizeListeners.size, 0);
  }
});

test('food category selection holds the toolbar open and activates even the unchanged default category', async context => {
  const { field, events, resizeListeners } = selectFixture(context, { variant: 'feed', active: false, modelValue: '荤菜', options: ['荤菜', '套餐'] });
  await field.show();
  assert.deepEqual(field.dropdownLayout.value, { top: 144, left: 100, width: 176, height: 62 });
  assert.equal(resizeListeners.size, 1);
  field.choose('荤菜');
  assert.deepEqual(events, [['open-change', true], ['update:modelValue', '荤菜'], ['open-change', false]]);
  assert.equal(field.open.value, false);
  assert.equal(field.dropdownLayout.value, null);
  assert.equal(resizeListeners.size, 0);
});

test('feed uses an anchored portal while units keep the existing sheet and touch targets', () => {
  const nodes = templateNodes(selectSource);
  const sheet = nodes.find(node => node.tag === 'Sheet');
  assert.equal(sheet.props.find(prop => prop.name === 'if').exp.content, "open && variant !== 'feed'");
  const listbox = nodes.find(node => attribute(node, 'role') === 'listbox');
  assert.equal(listbox.tag, 'scroll-view');
  assert.equal(binding(listbox, 'bounces'), 'false');
  assert.match(selectSource, /<root-portal>/);
  assert.match(selectSource, /<Teleport to="body">/);
  assert.equal(declarationsFor('.select-dropdown-options').get('grid-template-columns'), 'repeat(2, minmax(0, 1fr))');
  assert.equal(declarationsFor('.select-dropdown-option').get('min-height'), '44px');
  assert.equal(declarationsFor('.select-dropdown-backdrop').get('background'), 'transparent');
});

test('closing a feed dropdown ignores delayed measurements and restores the trigger focus', async context => {
  const current = selectFixture(context, { variant: 'feed', modelValue: '荤菜', options: ['荤菜', '套餐'] });
  let focused = 0;
  current.field.triggerRef.value = { focus() { focused += 1; } };
  current.layout.defer = true;
  const opening = current.field.show();
  await nextTick();
  assert.equal(current.pending.length, 1);
  current.field.close();
  current.pending.shift()();
  await opening;
  assert.equal(current.field.open.value, false);
  assert.equal(current.field.dropdownLayout.value, null);
  assert.equal(current.resizeListeners.size, 0);
  assert.equal(focused, 1);
});

test('feed dropdown responds to disabling and disposes resize listeners on unmount', async context => {
  const current = selectFixture(context, { variant: 'feed', disabled: true, modelValue: '荤菜', options: ['荤菜', '套餐'] });
  await current.field.show();
  assert.equal(current.field.open.value, false);
  assert.deepEqual(current.events, []);
  current.props.disabled = false;
  await current.field.show();
  current.props.disabled = true;
  await nextTick();
  assert.equal(current.field.open.value, false);
  current.props.disabled = false;
  await current.field.show();
  current.dispose();
  assert.equal(current.resizeListeners.size, 0);
  assert.deepEqual(current.events.at(-1), ['open-change', false]);
});

test('keyboard navigation traverses two-column feed rows and Escape closes without selecting', async context => {
  const current = selectFixture(context, { variant: 'feed', active: true, modelValue: '荤菜', options: ['荤菜', '素菜', '汤羹', '主食', '小食', '饮品', '其他', '套餐'] });
  const key = value => ({ key: value, preventDefault() {} });
  await current.field.show();
  assert.equal(current.field.highlighted.value, 0);
  await current.field.onDropdownKey(key('ArrowDown'));
  assert.equal(current.field.highlighted.value, 2);
  await current.field.onDropdownKey(key('ArrowRight'));
  assert.equal(current.field.highlighted.value, 3);
  await current.field.onDropdownKey(key('ArrowUp'));
  assert.equal(current.field.highlighted.value, 1);
  await current.field.onDropdownKey(key('ArrowLeft'));
  assert.equal(current.field.highlighted.value, 0);
  await current.field.onDropdownKey(key('End'));
  assert.equal(current.field.highlighted.value, 7);
  await current.field.onDropdownKey(key('ArrowDown'));
  assert.equal(current.field.highlighted.value, 7);
  await current.field.onDropdownKey(key('Home'));
  assert.equal(current.field.highlighted.value, 0);
  await current.field.onDropdownKey(key('Escape'));
  assert.equal(current.field.open.value, false);
  assert.equal(current.events.some(event => event[0] === 'update:modelValue'), false);
});

test('active feed underline is centered under the label instead of the label and chevron together', () => {
  const label = declarationsFor('.choice-trigger.community-filter-trigger > .choice-label');
  assert.equal(label.get('position'), 'relative');
  assert.equal(label.get('flex'), '0 0 auto');
  assert.equal(label.get('height'), '100%');
  const underline = declarationsFor('.community-filter-trigger.active > .choice-label::before');
  assert.equal(underline.get('left'), 'calc(50% - 7px)');
  assert.equal(underline.get('width'), '14px');
  assert.equal(underline.get('bottom'), '4px');
  assert.equal(declarationsFor('.community-filter-trigger.active::before').size, 0);
  assert.equal(declarationsFor('.community-category-select .community-filter-trigger[disabled]').get('opacity'), '1');
});
