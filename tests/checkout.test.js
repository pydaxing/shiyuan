import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ref, nextTick } from 'vue';
import { parse } from '@vue/compiler-sfc';
import { baseParse } from '@vue/compiler-dom';
import { useMealDraft } from '../src/composables/useMealDraft.js';
import { checkoutPresentation } from '../src/domain/checkout.js';

function setup(selection = null) {
  const memberId = ref('me');
  const currentSelection = ref(selection);
  const menuEntries = ref(['tomato', 'chicken', 'soup', 'set:light'].map((key) => ({ key })));
  return { memberId, currentSelection, menuEntries, ...useMealDraft(memberId, currentSelection, menuEntries) };
}

test('choosing another date or meal preserves selected dishes, sets and notes', () => {
  const draft = setup();
  draft.cart.value = { tomato: 1, 'set:light': 1 };
  draft.note.value = '少辣';
  for (const target of [null, { entries: [{ id: 'chicken' }], note: '之前的备注' }, null]) {
    draft.retain();
    draft.currentSelection.value = target;
    assert.deepEqual(draft.cart.value, { tomato: 1, 'set:light': 1 });
    assert.equal(draft.note.value, '少辣');
    assert.equal(draft.dirty.value, true);
  }
});

test('changing the destination also preserves an unchanged previously submitted selection', () => {
  const draft = setup({ entries: [{ id: 'tomato' }], note: '少盐' });
  assert.equal(draft.dirty.value, false);
  draft.retain();
  draft.currentSelection.value = null;
  assert.deepEqual(draft.cart.value, { tomato: 1 });
  assert.equal(draft.note.value, '少盐');
  assert.equal(draft.dirty.value, true);
});

test('empty selection stays empty when choosing a meal with previous picks', () => {
  const draft = setup({ entries: [{ id: 'tomato' }], note: '' });
  draft.cart.value = {};
  draft.retain();
  draft.currentSelection.value = { entries: [{ id: 'soup' }], note: '' };
  assert.deepEqual(draft.cart.value, {});
  assert.equal(draft.dirty.value, true);
});

test('clear-selection empties dishes, sets and notes without restoring or changing a saved order', () => {
  const selection = { entries: [{ id: 'tomato' }], note: '少盐' };
  const draft = setup(selection);
  draft.cart.value = { tomato: 1, 'set:light': 1 };
  draft.note.value = '新备注';
  draft.empty();
  assert.deepEqual(draft.cart.value, {});
  assert.equal(draft.note.value, '');
  assert.equal(draft.dirty.value, true);
  assert.deepEqual(selection, { entries: [{ id: 'tomato' }], note: '少盐' });
  draft.cart.value = { chicken: 1 };
  assert.deepEqual(draft.cart.value, { chicken: 1 });
});

test('clear-selection affects only the current member and stays empty across destination changes', () => {
  const draft = setup();
  draft.cart.value = { tomato: 1 };
  draft.memberId.value = 'partner';
  draft.cart.value = { 'set:light': 1 };
  draft.empty();
  draft.retain();
  draft.currentSelection.value = { entries: [{ id: 'soup' }], note: '已点餐备注' };
  assert.deepEqual(draft.cart.value, {});
  assert.equal(draft.note.value, '');
  draft.memberId.value = 'me';
  assert.deepEqual(draft.cart.value, { tomato: 1 });
});

test('selection dock reflects remaining dishes without a hidden edit mode and keeps stable actions', () => {
  const source = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8');
  const nodes = [];
  function walk(node) { if (node.type === 1) { nodes.push(node); node.children.forEach(walk); } }
  baseParse(parse(source).descriptor.template.content).children.forEach(walk);
  const dock = nodes.find((node) => node.props.some((prop) => prop.name === 'class' && prop.value?.content === 'selection-dock'));
  const condition = dock.props.find((prop) => prop.name === 'if').exp.content;
  const visible = new Function('dishCount', 'tab', 'menuMode', 'currentSelection', `return ${condition}`);
  for (const saved of [null, { entries: [{ id: 'tomato' }] }]) {
    assert.equal(visible(0, 'menu', 'menu', saved), false);
    assert.equal(visible(1, 'menu', 'menu', saved), true);
    assert.equal(visible(1, 'kitchen', 'orders', saved), false);
    assert.equal(visible(1, 'community', 'menu', saved), false);
  }
  const hasClass = (node, name) => node.props?.some(prop => prop.name === 'class' && prop.value?.content.split(' ').includes(name));
  const overview = dock.children.find(node => hasClass(node, 'selection-overview'));
  const summary = overview.children.find(node => hasClass(node, 'selection-summary'));
  const clear = overview.children.find(node => hasClass(node, 'selection-clear'));
  const submit = dock.children.find(node => hasClass(node, 'selection-submit'));
  const submitIcon = submit.children.find(node => node.tag === 'AppIcon');
  assert.equal(submitIcon.props.find(prop => prop.name === 'name').value.content, 'menu-inverse');
  assert.equal(submitIcon.props.find(prop => prop.name === 'bind' && prop.arg?.content === 'size').exp.content, '18');
  assert.ok(summary.props.some(prop => prop.name === 'on' && prop.exp.content === 'openCart'));
  assert.ok(clear.props.some(prop => prop.name === 'on' && prop.exp.content === 'clearSelection'));
  assert.ok(submit.props.some(prop => prop.name === 'on' && prop.exp.content === 'openCart'));
  assert.match(summary.loc.source, /<text>已选 {{ dishCount }} 道菜<\/text>/);
  assert.ok(clear.children.some(node => node.tag === 'text' && node.children[0].content === '清空'));
  assert.match(clear.loc.source, /<AppIcon name="trash-danger" :size="16" \/><text>清空<\/text>/);
  assert.ok(submit.children.some(node => node.tag === 'text' && node.children[0].content === '点餐'));
  assert.doesNotMatch(dock.loc.source, /selection-actions|selection-total/);
  assert.doesNotMatch(summary.loc.source, /AppIcon/);
  assert.equal(submit.children.filter(node => node.tag === 'AppIcon').length, 1);
});

test('successful submission clears only the current member draft', () => {
  const draft = setup();
  draft.cart.value = { tomato: 1 };
  draft.memberId.value = 'partner';
  draft.cart.value = { chicken: 1 };
  draft.clear();
  assert.deepEqual(draft.cart.value, {});
  draft.memberId.value = 'me';
  assert.deepEqual(draft.cart.value, { tomato: 1 });
  draft.currentSelection.value = { entries: [{ id: 'tomato' }], note: '' };
  draft.clear();
  assert.equal(draft.dirty.value, false);
});

test('removing menu items prunes draft entries without clearing notes or surviving dishes', async () => {
  const draft = setup();
  draft.cart.value = { tomato: 1, 'set:light': 1 };
  draft.note.value = '保留备注';
  draft.menuEntries.value = [{ key: 'tomato' }];
  await nextTick();
  assert.deepEqual(draft.cart.value, { tomato: 1 });
  assert.equal(draft.note.value, '保留备注');
  draft.reset();
  assert.deepEqual(draft.cart.value, {});
  assert.equal(draft.note.value, '');
});

test('meal selectors live only in checkout, never in kitchen or dish browsing headers', () => {
  const source = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8');
  const template = parse(source).descriptor.template.content;
  const selectors = [];
  function walk(node, ancestors = []) {
    if (node.type !== 1) return;
    if (node.tag === 'MealBar') selectors.push(ancestors);
    node.children.forEach((child) => walk(child, [...ancestors, node]));
  }
  baseParse(template).children.forEach((node) => walk(node));
  assert.equal(selectors.length, 1);
  assert.equal(selectors.filter((ancestors) => ancestors.some((node) => node.tag === 'Sheet' && node.props.some((prop) => prop.name === 'if' && prop.exp?.content === 'cartOpen'))).length, 1);
  assert.equal(selectors.filter((ancestors) => ancestors.some((node) => node.props.some((prop) => prop.name === 'class' && prop.value?.content === 'orders-view'))).length, 0);
  assert.match(source, /mealDateLabel\(order.date, today\)/);
  assert.doesNotMatch(source, /class="selection-meal"/);
});

test('checkout actions distinguish new meals, family additions, edits and unchanged selections', () => {
  const fresh = { closed: false, hasSelection: false, hasOrder: false, dirty: true, dishCount: 2 };
  assert.deepEqual(checkoutPresentation(fresh), { action: 'submit', label: '送到厨房', tip: '' });
  assert.match(checkoutPresentation({ ...fresh, hasOrder: true }).tip, /合并到同一单/);
  const saved = { ...fresh, hasOrder: true, hasSelection: true, dirty: false };
  assert.equal(checkoutPresentation(saved).action, 'view');
  assert.equal(checkoutPresentation(saved).label, '去加菜');
  assert.match(checkoutPresentation(saved).tip, /已经安排好.*备菜中也可以/);
  assert.equal(checkoutPresentation({ ...saved, dirty: true }).action, 'update');
  assert.match(checkoutPresentation({ ...saved, dirty: true }).tip, /不影响家人/);
});

test('empty, withdrawn and completed meal states always explain the available action', () => {
  assert.equal(checkoutPresentation({ dishCount: 0 }).action, 'choose');
  const withdrawn = { hasSelection: true, dirty: true, dishCount: 0 };
  assert.equal(checkoutPresentation(withdrawn).action, 'withdraw');
  assert.equal(checkoutPresentation(withdrawn).label, '撤回我的选菜');
  for (const props of [withdrawn, { hasSelection: true, dirty: false, dishCount: 3 }, { dishCount: 1 }]) {
    const closed = checkoutPresentation({ ...props, closed: true });
    assert.equal(closed.action, 'blocked');
    assert.equal(closed.label, '请先更换餐次');
    assert.match(closed.tip, /已做好.*日期或餐次/);
  }
});

test('note-only changes enable an update and changing back restores the view-order action', () => {
  const draft = setup({ entries: [{ id: 'tomato' }], note: '少盐' });
  const presentation = () => checkoutPresentation({ hasSelection: Boolean(draft.currentSelection.value), dirty: draft.dirty.value, dishCount: Object.keys(draft.cart.value).length });
  assert.equal(presentation().action, 'view');
  draft.note.value = '不放辣椒';
  assert.equal(presentation().action, 'update');
  draft.note.value = ' 少盐 ';
  assert.equal(presentation().action, 'view');
  draft.cart.value = { tomato: 1, chicken: 1 };
  assert.equal(presentation().action, 'update');
  draft.retain();
  draft.currentSelection.value = null;
  assert.equal(presentation().action, 'submit');
  assert.equal(Object.keys(draft.cart.value).length, 2);
});

test('checkout uses three spaced cards without detached hints or silent no-change disabling', () => {
  const source = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8');
  const checkout = source.slice(source.indexOf('<Sheet v-if="cartOpen"'), source.indexOf('<RecipeSheet v-if="orderRecipe"'));
  assert.equal((checkout.match(/class="checkout-card /g) || []).length, 3);
  assert.match(checkout, /class="checkout-tip"/);
  assert.match(checkout, /class="checkout-tip warning checkout-submit-error" role="alert"/);
  assert.doesNotMatch(checkout, /class="hint"|class="error-message"|重复菜品只做一道|:disabled="[^"]*cartDirty/);
  assert.match(checkout, /继续选菜/);
  assert.match(source, /if \(action === 'view' \|\| action === 'choose'\)/);
});
