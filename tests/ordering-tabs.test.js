import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@vue/compiler-sfc';
import { parse as parseScript } from '@babel/parser';
import { ref, computed, nextTick } from 'vue';
import { checkoutPresentation } from '../src/domain/checkout.js';
import { useMealDraft } from '../src/composables/useMealDraft.js';

const page = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8');
const source = parse(page).descriptor.scriptSetup.content;
const declarations = parseScript(source, { sourceType: 'module' }).program.body;
function functions(names, bindings) {
  const parts = names.map(name => declarations.find(node => node.type === 'FunctionDeclaration' && node.id.name === name));
  assert.ok(parts.every(Boolean));
  return new Function(...Object.keys(bindings), `${parts.map(node => source.slice(node.start, node.end)).join('\n')}\nreturn { ${names.join(',')} };`)(...Object.values(bindings));
}
function fixture(action = 'submit') {
  const state = ref({ family: { id: 'family-a' }, activeMemberId: 'member-a' });
  const mealDraft = useMealDraft(ref('member-a'), ref(null), ref([{ key: 'tomato' }]));
  mealDraft.cart.value = { tomato: 1 }; mealDraft.note.value = '少盐';
  const calls = [];
  const bindings = {
    state, mealDraft, meal: ref('晚餐'), mealRequired: ref(false), cart: mealDraft.cart, note: mealDraft.note,
    tab: ref('menu'), cartOpen: ref(true),
    submitting: ref(false), submitRevision: 0, submitError: ref(''),
    checkout: ref({ action }), selection: ref({ date: '2026-11-05', meal: '晚餐' }), currentOrder: ref(null),
    refreshDay() {}, dismissFocusedKeyboard() {}, tapFeedback() {},
    kitchenFocus: { focus: id => calls.push(['focus', id]) },
    submitOrder: async (cart, slot, note) => { calls.push(['submit', { ...cart }, slot, note]); bindings.currentOrder.value = { id: 'new-order' }; },
    presentMutation: async (pending, saved) => { await pending; saved(); },
  };
  return { bindings, calls, ...functions(['submit', 'revealOrder', 'showMenu', 'selectNavigation'], bindings) };
}

test('entering the merged meals navigation always opens menu and retains the unfinished selection', () => {
  const f = fixture();
  for (const previous of ['activity', 'community', 'square', 'family', 'menu']) {
    f.bindings.tab.value = previous;
    f.selectNavigation('menu');
    assert.equal(f.bindings.tab.value, 'menu');
    assert.deepEqual(f.bindings.cart.value, { tomato: 1 });
    assert.equal(f.bindings.note.value, '少盐');
  }
  f.selectNavigation('activity');
  assert.equal(f.bindings.tab.value, 'activity');
  assert.deepEqual(f.bindings.cart.value, { tomato: 1 });
  assert.deepEqual(f.calls, []);
});

test('successful checkout clears selected dishes and goes to the full meal list', async () => {
  const f = fixture(); await f.submit();
  assert.equal(f.bindings.tab.value, 'activity');
  assert.equal(f.bindings.cartOpen.value, false);
  assert.deepEqual(f.bindings.cart.value, {});
  assert.equal(f.bindings.note.value, '');
  assert.deepEqual(f.calls.at(-1), ['focus', 'new-order']);
});

test('failed checkout retains menu selections and retry context', async () => {
  const f = fixture();
  f.bindings.presentMutation = async () => { throw new Error('暂未保存'); };
  const model = functions(['submit', 'revealOrder', 'showMenu'], f.bindings);
  await model.submit();
  assert.equal(f.bindings.tab.value, 'menu');
  assert.equal(f.bindings.cartOpen.value, true);
  assert.deepEqual(f.bindings.cart.value, { tomato: 1 });
  assert.equal(f.bindings.note.value, '少盐');
  assert.equal(f.bindings.submitting.value, false);
  assert.equal(f.bindings.submitError.value, '暂未保存');
  assert.equal(f.calls.some(call => call[0] === 'focus'), false);
});

test('an existing meal confirmation is inert and preserves the open draft', async () => {
  const f = fixture(checkoutPresentation({ hasOrder: true, dishCount: 1 }).action);
  f.bindings.currentOrder.value = { id: 'existing' };
  await f.submit();
  assert.deepEqual(f.calls, []);
  assert.equal(f.bindings.cartOpen.value, true);
  assert.equal(f.bindings.note.value, '少盐');
  assert.equal(f.bindings.submitting.value, false);
  assert.deepEqual(f.bindings.cart.value, { tomato: 1 });
});

test('a late successful checkout from a previous workspace does not navigate or clear the new draft', async () => {
  const f = fixture(); let finish;
  f.bindings.presentMutation = async (request, saved) => { await request; await new Promise(resolve => { finish = () => { saved(); resolve(); }; }); };
  const model = functions(['submit', 'revealOrder', 'showMenu'], f.bindings);
  const pending = model.submit(); await nextTick();
  f.bindings.state.value.family.id = 'family-b';
  finish(); await pending;
  assert.equal(f.bindings.tab.value, 'menu');
  assert.deepEqual(f.bindings.cart.value, { tomato: 1 });
  assert.equal(f.calls.some(call => call[0] === 'focus'), false);
});

test('menu activity and selection dock follow the home tab without clearing a draft', () => {
  const f = fixture();
  const declaration = declarations.find(node => node.type === 'VariableDeclaration' && node.declarations[0].id.name === 'menuActive');
  const active = new Function('computed', 'tab', `${source.slice(declaration.start, declaration.end)} return menuActive;`)(computed, f.bindings.tab);
  const condition = page.match(/v-if="([^"]+)" class="selection-dock"/)[1];
  const dock = new Function('dishCount', 'menuActive', `return ${condition};`);
  for (const [tab, visible] of [['menu', true], ['activity', false], ['square', false], ['community', false], ['family', false]]) {
    f.bindings.tab.value = tab;
    assert.equal(active.value, visible); assert.equal(dock(1, active.value), visible);
    assert.deepEqual(f.bindings.cart.value, { tomato: 1 });
  }
});

test('saving a recipe from another page opens the menu and restores its category', async () => {
  const calls = [], tab = ref('community');
  const bindings = { tab, editingRecipe: ref(true), editingSet: ref(false), recipeDraft: ref(null), creationCategory: ref('荤菜'), search: ref('旧搜索'), homeMenu: ref({ reset: category => calls.push(category) }), nextTick };
  const model = functions(['saved', 'showMenu'], bindings);
  await model.saved({ category: '素菜' });
  assert.equal(tab.value, 'menu');
  assert.equal(bindings.editingRecipe.value, false); assert.equal(bindings.search.value, '');
  assert.deepEqual(calls, ['素菜']);
});


test('record meal retains its solid first-paint surface while pending IDs become confirmed', () => {
  const button = page.match(/<button[^>]+class="primary-button meal-record-button"[^>]*>/)[0];
  const evaluate = (name, order, busy = false) => new Function('order', 'today', 'orderActionBusy', 'isPendingRecord', `return (${button.match(new RegExp(':' + name + '=\\"([^\\"]+)\\"'))[1]});`)(order, '2026-11-06', busy, id => id.startsWith('pending-'));
  const order = { id: 'pending-new', date: '2026-11-06', items: [{}] };
  assert.equal(evaluate('disabled', order), true);
  assert.equal(evaluate('aria-busy', order), true);
  assert.deepEqual(evaluate('class', order), { 'is-unavailable': false });
  order.id = 'confirmed';
  assert.equal(evaluate('disabled', order), false);
  assert.deepEqual(evaluate('class', order), { 'is-unavailable': false });
  assert.equal(evaluate('disabled', order, true), true);
  order.date = '2026-11-07';
  assert.equal(evaluate('disabled', order), true);
  assert.deepEqual(evaluate('class', order), { 'is-unavailable': true });
  const rule = page.match(/\.order-progress-actions \.primary-button\.meal-record-button \{([^}]+)\}/)[1];
  for (const declaration of ['background: var(--green)', 'color: var(--white)', 'opacity: 1', 'transition: none']) assert.ok(rule.includes(declaration));
});

 test('missing meal highlights the field without submitting or clearing dishes', async () => {
  const f = fixture('validate');
  f.bindings.meal.value = '';
  await f.submit();
  assert.equal(f.bindings.mealRequired.value, true);
  assert.equal(f.bindings.cartOpen.value, true);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.bindings.cart.value, { tomato: 1 });
});


test('clearing a draft resets the meal before choosing dishes and reopening checkout', () => {
  const f = fixture();
  f.bindings.cartOpen.value = false;
  f.bindings.mealRequired.value = true;
  f.bindings.submitError.value = '旧提示';
  const model = functions(['clearSelection', 'openCart', 'resetDraft'], f.bindings);
  model.clearSelection();
  assert.equal(f.bindings.meal.value, '');
  assert.equal(f.bindings.mealRequired.value, false);
  assert.equal(f.bindings.submitError.value, '');
  assert.deepEqual(f.bindings.cart.value, {});
  assert.equal(f.bindings.note.value, '');
  f.bindings.cart.value = { tomato: 1 };
  model.openCart();
  assert.equal(f.bindings.meal.value, '');
  assert.equal(f.bindings.cartOpen.value, true);
  f.bindings.meal.value = '午餐';
  model.resetDraft();
  assert.equal(f.bindings.meal.value, '');
  assert.equal(f.bindings.cartOpen.value, false);
});


test('occupied meal link opens arrangements and focuses that meal while retaining the draft', () => {
  const f = fixture('occupied');
  f.revealOrder('existing-meal');
  assert.equal(f.bindings.tab.value, 'activity');
  assert.equal(f.bindings.cartOpen.value, false);
  assert.deepEqual(f.calls, [['focus', 'existing-meal']]);
  assert.deepEqual(f.bindings.cart.value, { tomato: 1 });
  assert.equal(f.bindings.note.value, '少盐');
});
