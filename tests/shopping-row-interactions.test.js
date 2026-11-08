import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computed, effectScope, nextTick, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { parse } from '@vue/compiler-sfc';
import { baseParse } from '@vue/compiler-dom';
import postcss from 'postcss';
import { createSeed } from '../src/data/seed.js';
import { makeOrder, normalizeSnapshot, formatAmount, formatQuantity, hasTextAmount, localDate, mealDateLabel } from '../src/domain/kitchen.js';
import { createKitchenActions } from '../src/domain/actions.js';
import { ingredientListGroups, preparationKey, preparationMeals, shoppingOrderAnchor } from '../src/domain/meal-preparation.js';
import { normalizeShoppingDraft, shoppingCartMeals, shoppingEditSignature, shoppingSourceIngredients, wholeDishShoppingDraft } from '../src/domain/meal-shopping.js';
import { NATIVE_UI_COLORS } from '../src/domain/ui-theme.js';
import { componentSource, setupSource } from './helpers/sfc-setup.js';
import { createPreparationAutosave } from '../src/composables/preparation-autosave.js';
import { presentMutation } from '../src/services/mutation-feedback.js';

const today = '2026-10-26';
const tick = async () => { for (let index = 0; index < 8; index += 1) await nextTick(); };
const elements = node => [...(node.type === 1 ? [node] : []), ...(node.children || []).flatMap(elements)];
const nodes = name => baseParse(parse(componentSource(name)).descriptor.template.content).children.flatMap(elements);
const cartDishCount = view => view.meals.value.reduce((count, meal) => count + meal.dishes.length, 0);
const hasClass = (node, name) => node.props.some(prop => prop.type === 6 && prop.name === 'class' && prop.value?.content.split(/\s+/).includes(name));
const directive = (node, name, argument) => node.props.find(prop => prop.type === 7 && prop.name === name && prop.arg?.content === argument);
function declarations(name, selector) {
  const values = {};
  postcss.parse(parse(componentSource(name)).descriptor.styles[0].content).walkRules(selector, rule => { if (rule.parent.type !== 'atrule') rule.walkDecls(declaration => { values[declaration.prop] = declaration.value; }); });
  return values;
}
function shoppingView({ wait = async () => {}, initialCart = false } = {}) {
  const state = ref(normalizeSnapshot(createSeed()));
  state.value.family.features = { fridge: false, shopping: false };
  state.value.orders = [makeOrder({ id: 'dinner', recipes: state.value.recipes, cart: { tomato: 1, broccoli: 1 }, member: state.value.family.members[0], date: today, meal: '晚餐' })];
  const actions = createKitchenActions({ getState: () => state.value, commit: next => { state.value = next; }, today: () => today });
  const modals = []; const writes = []; const messages = []; const events = [];
  const cloudStatus = ref({ busy: false });
  const props = ref({ embedded: true, active: true, today, focusOrder: { id: 'dinner' }, orderId: 'dinner' });
  const focusedId = ref('');
  const scope = effectScope();
  const autosave = createPreparationAutosave({
    getState: () => state.value, getScope: () => `${state.value.family.id || ''}:${state.value.activeMemberId}`, isBusy: () => cloudStatus.value.busy,
    send: async (...args) => { writes.push(['preparation', ...args]); await wait(); return actions.saveDishPreparation(...args); },
  });
  const stop = scope.stop.bind(scope);
  scope.stop = () => { stop(); autosave.dispose(); };
  const bindings = {
    computed, ref, shallowRef, watch, onScopeDispose, formatAmount, formatQuantity, hasTextAmount, localDate, mealDateLabel, ingredientListGroups, preparationKey, preparationMeals, shoppingCartMeals, shoppingOrderAnchor, normalizeShoppingDraft, shoppingEditSignature, wholeDishShoppingDraft, NATIVE_UI_COLORS, state, cloudStatus, presentMutation,
    usePreparationAutosave: () => autosave,
    getCurrentInstance: () => ({ proxy: { id: 'shopping-component' } }),
    defineEmits: () => (...event) => events.push(event),
    defineProps: () => props.value,
    useKitchenFocus: () => ({ focusedId, focus: id => { focusedId.value = id; }, cancel: () => { focusedId.value = ''; } }),
    sheetOpen: ref(false),
    dismissFocusedKeyboard: () => {},
    uni: { showModal: options => modals.push(options) },
    notify: message => messages.push(message),
    setDishPrepared: async (...args) => { writes.push(['prepared', ...args]); await wait(); actions.setDishPrepared(...args); },
    removeShoppingDraft: async (...args) => { writes.push(['remove', ...args]); await wait(); actions.removeShoppingDraft(...args); },
    saveShoppingDraft: async (...args) => { writes.push(['package', ...args]); await wait(); actions.saveShoppingDraft(...args); },
  };
  const behavior = readFileSync(new URL('../src/composables/usePreparationActions.js', import.meta.url), 'utf8').replace(/^import .*;\s*$/gm, '').replace('export function', 'function');
  bindings.usePreparationActions = new Function(...Object.keys(bindings), `${behavior}\nreturn usePreparationActions;`)(...Object.values(bindings));
  const packageBehavior = readFileSync(new URL('../src/composables/useDishPackageActions.js', import.meta.url), 'utf8').replace(/^import .*;\s*$/gm, '').replace('export function', 'function');
  bindings.useDishPackageActions = new Function(...Object.keys(bindings), `${packageBehavior}\nreturn useDishPackageActions;`)(...Object.values(bindings));
  const add = (recipeId = 'tomato') => {
    const dish = preparationMeals(state.value, today)[0].dishes.find(entry => entry.recipe.id === recipeId);
    actions.saveShoppingDraft('dinner', recipeId, { ingredients: shoppingSourceIngredients(dish.ingredients).slice(0, 1) }, shoppingEditSignature(state.value.orders[0], recipeId));
  };
  if (initialCart) add();
  const current = scope.run(() => setupSource('ShoppingView', bindings, ['meals', 'busy', 'remove', 'removing', 'removeError', 'expanded', 'toggleIngredients', 'hasExpandedTail']));
  const prep = scope.run(() => setupSource('MealPreparationSheet', bindings, ['meal', 'ingredients']));
  // Legacy queue handlers remain supported for old clients. Exercise them directly;
  // the current meal quantity sheet intentionally has no purchase/ready actions.
  const ready = scope.run(() => bindings.usePreparationActions());
  const packages = scope.run(() => bindings.useDishPackageActions());
  prep.togglePrepared = ready.togglePrepared;
  prep.cartCount = computed(() => current.meals.value.find(meal => meal.id === props.value.orderId)?.dishes.length || 0);
  prep.inCart = dish => Boolean(state.value.orders.find(order => order.id === props.value.orderId)?.shoppingDrafts?.some(item => item.recipeId === dish.recipe.id));
  prep.purchaseDish = dish => prep.meal.value ? packages.togglePackage(props.value.orderId, dish.recipe.id) : undefined;
  prep.markPrepared = dish => prep.meal.value ? ready.togglePrepared(prep.meal.value, dish) : undefined;
  prep.actionError = dish => autosave.peek(props.value.orderId, dish.recipe.id)?.actionError?.message || '';
  prep.busy = computed(() => autosave.entries().some(entry => entry.actionBusy));
  prep.failure = computed(() => autosave.entries().find(entry => entry.actionError?.kind === 'prepared')?.actionError || null);
  prep.purchaseFailure = computed(() => autosave.entries().find(entry => entry.actionError?.kind === 'package')?.actionError || null);
  return { ...current, prep, autosave, add, state, props, actions, cloudStatus, scope, focusedId, modals, writes, messages, events, togglePrepared: prep.togglePrepared, failure: prep.failure, busy: computed(() => current.busy.value || prep.busy.value) };
}

test('kitchen preparation and purchasing use distinct sources and dish-level controls', () => {
  const preparation = componentSource('MealPreparationSheet');
  const shopping = componentSource('ShoppingView');
  assert.match(preparation, /preparationMeals\(state.value, props.today\)/);
  assert.match(shopping, /shoppingCartMeals\(state.value, props.today\)/);
  assert.doesNotMatch(shopping, /StockEditor|getShoppingRequirements|recordPurchase|查看做法|preparation-dish/);
  assert.doesNotMatch(preparation, /dish\.note|冰箱记录|>查看做法</);
  const card = nodes('MealPreparationSheet').find(node => hasClass(node, 'prep-card'));
  assert.ok(card);
  assert.equal(directive(card, 'on', 'click'), undefined, 'container never steals nested control taps');
  const open = elements(card).find(node => hasClass(node, 'prep-dish-open'));
  assert.equal(directive(open, 'on', 'click').exp.content, "$emit('open', dish.recipe)");
});

test('meal quantity sheet removes purchase and readiness controls while keeping recipe access', () => {
  const source = componentSource('MealPreparationSheet');
  assert.doesNotMatch(source, /DishReadyButton|purchaseDish|markPrepared|prep-cart-button|openShopping/);
  const sheet = nodes('MealPreparationSheet').find(node => node.tag === 'Sheet');
  assert.equal(sheet.props.find(prop => prop.type === 6 && prop.name === 'title').value.content, '备菜清单');
  const open = nodes('MealPreparationSheet').find(node => hasClass(node, 'prep-dish-open'));
  assert.equal(directive(open, 'on', 'click').exp.content, "$emit('open', dish.recipe)");
  assert.doesNotMatch(source, /<DishPreparationEditor|按需调整/);
  assert.match(componentSource('IngredientTable'), /formatAmount\(ingredient.quantity, ingredient.unit, ingredient.amountText\)/);
});

test('meal quantity sheet has no procurement footer or misleading stock counts', () => {
  assert.doesNotMatch(componentSource('MealPreparationSheet'), /prep-cart-count|prep-footer-button|cartCount|已备齐/);
  assert.equal(declarations('MealPreparationSheet', '.prep-dish-open')['min-height'], '44px');
});

test('preparation shows all recipe ingredients without disclosure or editing', () => {
  const card = nodes('MealPreparationSheet').find(node => hasClass(node, 'prep-card'));
  const table = elements(card).find(node => node.tag === 'IngredientTable');
  assert.equal(directive(table, 'bind', 'collapsed-count').exp.content, 'ingredients(dish).length');
  assert.match(componentSource('IngredientTable'), /展开全部/);
  assert.equal(elements(card).some(node => hasClass(node, 'prep-disclosure')), false);
  assert.doesNotMatch(componentSource('MealPreparationSheet'), /usePreparationAutosave|DishPreparationEditor|按需调整/);
});

test('ingredient disclosure keeps three preparation rows, a faded continuation and all original amounts after expansion', async context => {
  const ingredients = Array.from({ length: 8 }, (_, index) => ({ name: `食材${index + 1}`, quantity: index + 1, unit: 'g' }));
  const props = ref({ ingredients, resetKey: 'dish-a', collapsedCount: 3 });
  const scope = effectScope();
  context.after(() => scope.stop());
  const table = scope.run(() => setupSource('IngredientTable', {
    ref, computed, watch, defineProps: () => props.value, useSheetContentResize() {},
  }, ['visibleIngredients', 'expanded', 'canExpand']));
  assert.equal(table.canExpand.value, true);
  assert.deepEqual(table.visibleIngredients.value, ingredients.slice(0, 5), 'three complete rows plus two faded continuation rows');
  table.expanded.value = true;
  assert.deepEqual(table.visibleIngredients.value, ingredients, 'expansion retains every amount and original order');
  props.value.resetKey = 'dish-b';
  await nextTick();
  assert.equal(table.expanded.value, false, 'another dish starts folded');
  props.value.ingredients = ingredients.slice(0, 4);
  assert.equal(table.canExpand.value, true, 'the fourth item alone still requires expansion');
  props.value.ingredients = ingredients.slice(0, 3);
  assert.equal(table.canExpand.value, false, 'three or fewer items need no disclosure');
  props.value.ingredients = ingredients;
  props.value.collapsedCount = 5;
  assert.equal(table.visibleIngredients.value.length, 7, 'recipe detail keeps its five-row default plus continuation');
});

test('procurement uses a white page surface and compact material rows instead of one large inset', () => {
  assert.equal(declarations('ShoppingView', '.shopping-view.has-packages').background, 'var(--white)');
  assert.equal(declarations('ShoppingView', '.shopping-package').background, 'var(--white)');
  assert.equal(declarations('ShoppingView', '.shopping-package-ingredients').background, undefined);
  assert.equal(declarations('ShoppingView', '.shopping-package-ingredients').padding, '0');
  assert.match(componentSource('ShoppingView'), /<MealIngredientList :ingredients="dish.purchaseIngredients"/);
  assert.equal(declarations('ShoppingView', '.shopping-package').border, '0');
});

test('preparation groups each dish and its ingredients on a white card over a light sheet', () => {
  const styles = postcss.parse(readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8'));
  for (const selector of ['.sheet.is-preparation', '.sheet.is-preparation .sheet-header', '.sheet.is-preparation .sheet-footer']) {
    const values = {};
    styles.walkRules(selector, rule => rule.walkDecls(declaration => { values[declaration.prop] = declaration.value; }));
    assert.equal(values.background, 'var(--paper)');
  }
  const card = declarations('MealPreparationSheet', '.prep-card');
  assert.equal(card.background, 'var(--white)');
  assert.equal(card.border, '0');
  assert.equal(card['border-bottom'], undefined);
  assert.equal(card.padding, '12px 14px 4px');
  assert.equal(card['box-shadow'], 'none');
  assert.equal(card['margin-bottom'], '10px');
  assert.equal(declarations('IngredientTable', '.is-preparation-table .ingredient-list').background, 'var(--white)');
  assert.equal(declarations('MealPreparationSheet', '.prep-ingredients').background, undefined);
  assert.equal(declarations('DishPreparationEditor', '.preparation-inline-editor').background, undefined);
});

test('preparation and procurement use one continuous material list without section labels or section gaps', () => {
  for (const name of ['DishPreparationEditor', 'MealIngredientList']) {
    const source = componentSource(name);
    const lists = nodes(name).filter(node => hasClass(node, 'meal-material-items'));
    assert.equal(lists.length, 1);
    assert.equal(lists[0].props.find(prop => prop.name === 'role').value.content, 'list');
    assert.match(lists[0].props.find(prop => prop.name === 'aria-label').value.content, /食材和配料/);
    assert.doesNotMatch(source, /meal-material-group|meal-material-label|in group\.items/);
  }
  assert.match(componentSource('DishPreparationEditor'), /v-for="\{ ingredient, index \} in rows"/);
  assert.match(componentSource('MealIngredientList'), /v-for="entry in entries"/);
  const add = nodes('DishPreparationEditor').filter(node => hasClass(node, 'preparation-add'));
  assert.equal(add.length, 1);
  assert.match(add[0].loc.source, /aria-label="添加食材或配料"/);
  assert.match(add[0].loc.source, /<text>添加食材\/配料<\/text>/);
});

test('material lists have column headings and fine separators without row backgrounds', () => {
  for (const name of ['DishPreparationEditor', 'MealIngredientList']) {
    const header = nodes(name).find(node => hasClass(node, 'meal-material-header'));
    assert.ok(header);
    assert.match(header.loc.source, />食材 \/ 配料</);
    assert.match(header.loc.source, />用量</);
    assert.equal(Boolean(header.loc.source.match(/>操作</)), name === 'DishPreparationEditor');
    assert.ok(directive(header, 'if'));
  }
  const stylesheet = postcss.parse(readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8'));
  const values = selector => {
    const result = {};
    stylesheet.walkRules(rule => {
      if (rule.selectors.includes(selector)) rule.walkDecls(declaration => { result[declaration.prop] = declaration.value; });
    });
    return result;
  };
  assert.equal(values('.meal-material-items').gap, '0');
  assert.equal(values('.meal-material-item').background, 'transparent');
  assert.equal(values('.meal-material-item')['border-radius'], '0');
  assert.equal(values('.meal-material-item')['border-bottom'], '1px solid var(--line)');
  assert.equal(values('.meal-material-item:last-child')['border-bottom'], '0');
  assert.equal(values('.meal-material-header')['border-bottom'], '1px solid var(--line)');
  assert.equal(values('.meal-material-header')['font-size'], 'var(--type-caption)');
  assert.equal(values('.meal-material-item')['min-height'], '44px');
});

test('procurement materials align with dish content without a checkout selection column', () => {
  const layout = declarations('ShoppingView', '.shopping-view');
  assert.equal(layout['--shopping-selection-width'], undefined);
  assert.equal(layout['--shopping-column-gap'], '10px');
  assert.equal(declarations('ShoppingView', '.shopping-package-heading').gap, 'var(--shopping-column-gap)');
  const materials = declarations('ShoppingView', '.shopping-package-ingredients');
  assert.equal(materials['margin-left'], '0');
  assert.equal(materials['margin-top'], '10px');
  assert.equal(materials['min-width'], '0');
  assert.equal(materials.padding, '0');
  for (const property of ['width', 'margin-right', 'background', 'border', 'box-shadow']) assert.equal(materials[property], undefined);
  assert.equal(nodes('ShoppingView').some(node => node.props.some(prop => prop.name === 'role' && prop.value?.content === 'checkbox')), false);
  const stylesheet = postcss.parse(readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8'));
  for (const selector of ['.meal-material-name', '.meal-material-amount']) {
    const properties = {};
    stylesheet.walkRules(selector, rule => rule.walkDecls(declaration => { properties[declaration.prop] = declaration.value; }));
    assert.equal(properties['overflow-wrap'], 'anywhere');
  }
});

test('only the final expanded shopping package removes redundant bottom padding', () => {
  const card = nodes('ShoppingView').find(node => hasClass(node, 'shopping-package'));
  assert.equal(directive(card, 'bind', 'class').exp.content, "{ 'is-expanded': expanded.includes(preparationKey(order.id, dish.recipe.id)) }");
  assert.deepEqual(declarations('ShoppingView', '.shopping-package.is-expanded:last-child'), { 'padding-bottom': '0' });
  assert.equal(declarations('ShoppingView', '.shopping-package').padding, '8px 0');
  assert.equal(declarations('ShoppingView', '.shopping-package-ingredients').padding, '0');
  assert.equal(declarations('ShoppingView', '.shopping-meal').padding, undefined);
});

test('expanded material cards share compact bottom padding without shrinking rows or editor actions', () => {
  const styles = postcss.parse(readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8'));
  const bottomPadding = [];
  styles.walkDecls('--material-card-bottom-padding', declaration => bottomPadding.push(declaration.value));
  assert.deepEqual(bottomPadding, ['4px']);
  assert.deepEqual(declarations('ShoppingView', '.shopping-meal.has-expanded-tail'), { 'padding-bottom': 'var(--material-card-bottom-padding)' });
  assert.equal(declarations('MealPreparationSheet', '.prep-card')['padding'], '12px 14px 4px');
  const shoppingCard = nodes('ShoppingView').find(node => hasClass(node, 'shopping-meal'));
  assert.equal(directive(shoppingCard, 'bind', 'class').exp.content, "{ 'has-expanded-tail': hasExpandedTail(order) }");
  const prepCard = nodes('MealPreparationSheet').find(node => hasClass(node, 'prep-card'));
  assert.equal(directive(prepCard, 'bind', 'class'), undefined);
  for (const selector of ['.preparation-edit-actions', '.preparation-add', '.preparation-reset']) {
    assert.equal(declarations('DishPreparationEditor', selector)['min-height'], '44px');
  }
  const compact = postcss.parse(parse(componentSource('MealPreparationSheet')).descriptor.styles[0].content);
  compact.walkAtRules('media', rule => {
    if (rule.params !== '(max-width: 360px)') return;
    rule.walkRules('.prep-card', card => card.walkDecls('padding', declaration => assert.equal(declaration.value, '12px 10px')));
  });
});

test('shopping meal bottom follows its own final dish disclosure and restores on collapse', async () => {
  const view = shoppingView();
  view.add('tomato'); view.add('broccoli');
  await nextTick();
  const order = view.meals.value[0];
  const firstDish = order.dishes[0];
  const lastDish = order.dishes[1];
  assert.equal(view.hasExpandedTail(order), false);
  assert.equal(view.hasExpandedTail({ id: 'empty', dishes: [] }), false);
  view.toggleIngredients(order, firstDish);
  assert.equal(view.hasExpandedTail(order), false);
  view.toggleIngredients(order, lastDish);
  assert.equal(view.hasExpandedTail(order), true);
  assert.equal(view.hasExpandedTail({ ...order, id: 'another-meal' }), false);
  view.toggleIngredients(order, lastDish);
  assert.equal(view.hasExpandedTail(order), false);
  assert.equal(view.expanded.value.includes(preparationKey(order.id, firstDish.recipe.id)), true);
  assert.deepEqual(view.writes, []);
  view.scope.stop();
});

test('new procurement has no automatic meal, no checkout or logistics, and a discover-food empty action', () => {
  const view = shoppingView();
  assert.equal(view.meals.value.length, 0);
  assert.equal(view.prep.meal.value.dishes.length, 2);
  const empty = nodes('ShoppingView').find(node => hasClass(node, 'shopping-empty'));
  assert.match(empty.loc.source, /aria-label="没有待买食材"/);
  assert.doesNotMatch(empty.loc.source, />没有待买食材<|shopping-empty-title/);
  assert.match(empty.loc.source, /看看美食/);
  assert.equal(elements(empty).filter(node => node.tag === 'button').length, 1);
  assert.equal(directive(elements(empty).find(node => node.tag === 'button'), 'on', 'click').exp.content, "$emit('discover')");
  assert.equal(declarations('ShoppingView', '.shopping-empty-button')['border-radius'], 'var(--radius-control)');
  assert.equal(declarations('ShoppingView', '.shopping-empty-button').margin, '0');
  assert.equal(view.purchase, undefined);
  view.scope.stop();
});

test('existing partial drafts opt into a whole dish package without mutating saved data on read', async () => {
  const view = shoppingView(); view.add();
  await nextTick();
  assert.equal(view.meals.value.length, 1);
  assert.equal(cartDishCount(view), 1);
  assert.equal(view.prep.cartCount.value, 1);
  assert.equal(view.meals.value[0].dishes[0].purchaseIngredients.length, view.prep.meal.value.dishes[0].ingredients.length);
  assert.equal(view.state.value.orders[0].shoppingDrafts[0].ingredients.length, 1);
  assert.equal(view.prep.meal.value.dishes.length, 2);
  view.scope.stop();
});

test('a hidden legacy package with no enabled materials can still be cancelled from preparation', async () => {
  const view = shoppingView({ initialCart: true });
  const dish = view.prep.meal.value.dishes[0];
  view.actions.saveDishPreparation('dinner', dish.recipe.id, { ingredients: dish.ingredients.map(ingredient => ({ ...ingredient, enabled: false })), note: '' }, dish.editSignature);
  await nextTick();
  const updated = view.prep.meal.value.dishes[0];
  assert.equal(view.meals.value.length, 0);
  assert.equal(view.prep.inCart(updated), true);
  await view.prep.purchaseDish(updated);
  assert.equal(view.prep.inCart(view.prep.meal.value.dishes[0]), false);
  assert.equal(view.state.value.orders[0].shoppingDrafts.length, 0);
  assert.equal(view.writes[0][0], 'remove');
  assert.deepEqual(view.modals, []);
  view.scope.stop();
});

test('reading preparation ingredients preserves scaled amounts and changes no saved data', () => {
  const view = shoppingView();
  const before = JSON.stringify(view.state.value);
  for (const dish of view.prep.meal.value.dishes) {
    const ingredients = view.prep.ingredients(dish);
    assert.equal(ingredients.length, dish.ingredients.filter(item => item.enabled !== false).length);
    for (const ingredient of ingredients) {
      assert.deepEqual(ingredient, dish.ingredients.find(item => item === ingredient));
    }
  }
  assert.equal(JSON.stringify(view.state.value), before);
  assert.deepEqual(view.writes, []);
  view.scope.stop();
});

test('procurement defaults to collapsed packages with separate recipe and ingredient taps', () => {
  const view = shoppingView({ initialCart: true });
  assert.deepEqual(view.expanded.value, []);
  const card = nodes('ShoppingView').find(node => hasClass(node, 'shopping-package'));
  const disclosure = elements(card).find(node => hasClass(node, 'shopping-package-disclosure'));
  const ingredients = elements(card).find(node => hasClass(node, 'shopping-package-ingredients'));
  assert.equal(directive(disclosure, 'on', 'click').exp.content, 'toggleIngredients(order, dish)');
  assert.equal(directive(disclosure, 'bind', 'aria-expanded').exp.content, 'expanded.includes(preparationKey(order.id, dish.recipe.id))');
  assert.equal(directive(disclosure, 'bind', 'aria-controls').exp.content, directive(ingredients, 'bind', 'id').exp.content);
  assert.equal(directive(ingredients, 'if').exp.content, directive(disclosure, 'bind', 'aria-expanded').exp.content);
  for (const entry of ['shopping-dish-image', 'shopping-dish-open']) {
    assert.equal(directive(elements(card).find(node => hasClass(node, entry)), 'on', 'click').exp.content, "$emit('open', dish.recipe)");
  }
  view.toggleIngredients(view.meals.value[0], view.meals.value[0].dishes[0]);
  assert.deepEqual(view.expanded.value, ['dinner:tomato']);
  view.toggleIngredients(view.meals.value[0], view.meals.value[0].dishes[0]);
  assert.deepEqual(view.expanded.value, []);
  assert.deepEqual(view.writes, []);
  assert.deepEqual(view.events, []);
  view.scope.stop();
});

test('procurement disclosure is scoped by meal and resets for removed dishes, navigation and family', async () => {
  const view = shoppingView({ initialCart: true });
  const lunch = makeOrder({ id: 'lunch', recipes: view.state.value.recipes, cart: { tomato: 1 }, member: view.state.value.family.members[0], date: today, meal: '午餐' });
  view.state.value.orders.push(lunch);
  const lunchDish = preparationMeals(view.state.value, today).find(order => order.id === 'lunch').dishes[0];
  view.actions.saveShoppingDraft('lunch', 'tomato', wholeDishShoppingDraft(lunchDish), shoppingEditSignature(lunch, 'tomato'));
  await nextTick();
  const dinner = view.meals.value.find(order => order.id === 'dinner');
  const lunchCart = view.meals.value.find(order => order.id === 'lunch');
  view.toggleIngredients(dinner, dinner.dishes[0]);
  assert.deepEqual(view.expanded.value, ['dinner:tomato']);
  view.toggleIngredients(lunchCart, lunchCart.dishes[0]);
  assert.deepEqual(view.expanded.value, ['dinner:tomato', 'lunch:tomato']);
  assert.equal(view.prep.cartCount.value, 1, 'footer counts only this meal, not all procurement packages');
  view.actions.removeShoppingDraft('dinner', 'tomato', dinner.dishes[0].shoppingSignature);
  await nextTick();
  assert.deepEqual(view.expanded.value, ['lunch:tomato']);
  assert.equal(view.prep.cartCount.value, 0);
  view.props.value.active = false;
  await nextTick();
  view.props.value.active = true;
  await nextTick();
  assert.deepEqual(view.expanded.value, []);
  view.toggleIngredients(lunchCart, lunchCart.dishes[0]);
  view.state.value.family.id = 'another-family';
  await nextTick();
  assert.deepEqual(view.expanded.value, []);
  assert.deepEqual(view.writes, []);
  view.scope.stop();
});

test('one preparation add saves the whole dish once, stays in preparation and updates the footer', async () => {
  let finish;
  const view = shoppingView({ wait: () => new Promise(resolve => { finish = resolve; }) });
  const dish = view.prep.meal.value.dishes[0];
  const operation = view.prep.purchaseDish(dish);
  await view.prep.purchaseDish(dish);
  await tick();
  assert.equal(view.writes.length, 1);
  assert.equal(view.writes[0][0], 'package');
  assert.deepEqual(view.writes[0][3], wholeDishShoppingDraft(dish));
  assert.equal(view.prep.busy.value, true);
  assert.equal(view.prep.cartCount.value, 0);
  assert.deepEqual(view.modals, []);
  assert.deepEqual(view.events, []);
  finish(); await operation;
  assert.deepEqual(view.events, []);
  assert.equal(view.prep.cartCount.value, 1);
  assert.equal(view.prep.meal.value.preparedCount, 0);
  assert.equal(view.state.value.orders[0].status, 'accepted');
  assert.equal(view.state.value.orders[0].shoppingDrafts[0].ingredients.length, dish.ingredients.length);
  assert.equal(view.prep.busy.value, false);
  assert.deepEqual(view.events, []);
  view.scope.stop();
});

test('tapping an added package removes it and repeated add-cancel cycles keep one package without popups or navigation', async () => {
  const view = shoppingView();
  const dish = view.prep.meal.value.dishes[0];
  view.actions.saveShoppingDraft('dinner', dish.recipe.id, wholeDishShoppingDraft(dish), shoppingEditSignature(view.state.value.orders[0], dish.recipe.id));
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await view.prep.purchaseDish(view.prep.meal.value.dishes[0]);
    assert.equal(view.prep.cartCount.value, 0);
    assert.equal(view.prep.inCart(dish), false);
    assert.equal(view.prep.meal.value.preparedCount, 0);
    await view.prep.purchaseDish(view.prep.meal.value.dishes[0]);
    assert.equal(view.prep.cartCount.value, 1);
    assert.equal(view.prep.inCart(dish), true);
  }
  assert.deepEqual(view.writes.map(entry => entry[0]), ['remove', 'package', 'remove', 'package', 'remove', 'package']);
  assert.deepEqual(view.modals, []);
  assert.deepEqual(view.events, []);
  assert.equal(view.prep.cartCount.value, 1);
  view.scope.stop();
});

test('a failed whole-package save keeps preparation open with a local error and can retry', async () => {
  let fail = true;
  const view = shoppingView({ wait: async () => { if (fail) throw new Error('网络未连接'); } });
  const dish = view.prep.meal.value.dishes[0];
  await view.prep.purchaseDish(dish);
  assert.deepEqual(view.events, []);
  assert.equal(view.prep.purchaseFailure.value.key, 'dinner:tomato');
  assert.equal(view.prep.purchaseFailure.value.message, '网络未连接');
  assert.equal(view.prep.busy.value, false);
  assert.equal(view.prep.cartCount.value, 0);
  fail = false;
  await view.prep.purchaseDish(dish);
  assert.deepEqual(view.events, []);
  assert.equal(view.prep.cartCount.value, 1);
  assert.equal(view.prep.purchaseFailure.value, null);
  view.scope.stop();
});

test('successive dish adds and removal update the count without affecting the other dish', async () => {
  const view = shoppingView();
  for (const dish of view.prep.meal.value.dishes) await view.prep.purchaseDish(dish);
  assert.equal(view.writes.length, 2);
  assert.equal(view.prep.cartCount.value, 2);
  assert.deepEqual(view.events, []);
  await view.prep.purchaseDish(view.prep.meal.value.dishes[0]);
  assert.equal(view.writes.length, 3);
  assert.equal(view.writes[2][0], 'remove');
  assert.equal(view.prep.cartCount.value, 1);
  assert.equal(view.state.value.orders[0].shoppingDrafts[0].recipeId, 'broccoli');
  view.state.value.orders[0].status = 'completed';
  assert.equal(view.prep.cartCount.value, 0);
  view.scope.stop();
});

test('prepared, ended or missing-material dishes cannot create a package or navigate away', async () => {
  const view = shoppingView();
  let dish = view.prep.meal.value.dishes[0];
  view.actions.setDishPrepared('dinner', dish.recipe.id, true, dish.signature);
  await view.prep.purchaseDish(dish);
  assert.match(view.prep.purchaseFailure.value.message, /已备齐/);
  view.actions.setDishPrepared('dinner', dish.recipe.id, false, dish.signature);
  view.state.value.orders[0].items[0].recipe.ingredients = [];
  dish = view.prep.meal.value.dishes[0];
  await view.prep.purchaseDish(dish);
  assert.match(view.prep.purchaseFailure.value.message, /补充食材/);
  view.state.value.orders[0].status = 'completed';
  await view.prep.purchaseDish(dish);
  assert.deepEqual(view.writes, []);
  assert.deepEqual(view.events, []);
  view.scope.stop();
});

test('invalid target drafts retain collapsed input without locking other dishes or navigation', async () => {
  const view = shoppingView();
  const dish = view.prep.meal.value.dishes[0];
  const entry = view.autosave.edit('dinner', dish.recipe.id);
  entry.ingredients[0].quantity = '';
  await view.prep.purchaseDish(dish);
  await view.prep.markPrepared(dish);
  assert.deepEqual(view.writes, []);
  assert.match(view.prep.actionError(dish), /补全/);
  await view.prep.purchaseDish(view.prep.meal.value.dishes[1]);
  assert.equal(view.writes[0][0], 'package');
  assert.equal(view.writes[0][2], 'broccoli');
  assert.deepEqual(view.events, []);
  assert.deepEqual(view.modals, []);
  assert.equal(view.autosave.edit('dinner', dish.recipe.id).ingredients[0].quantity, '');
  view.scope.stop();
});

test('a late package response after a family switch does not navigate or announce success', async () => {
  let finish;
  const view = shoppingView({ wait: () => new Promise(resolve => { finish = resolve; }) });
  const operation = view.prep.purchaseDish(view.prep.meal.value.dishes[0]);
  await tick();
  view.state.value.family.id = 'another-family'; await nextTick();
  finish(); await operation;
  assert.deepEqual(view.events, [['close']]);
  assert.deepEqual(view.messages, []);
  view.scope.stop();
});

test('preparation can toggle without purchasing and changes no meal status or inventory', async () => {
  const view = shoppingView();
  const meal = view.prep.meal.value; const dish = meal.dishes[0];
  const inventory = structuredClone(JSON.parse(JSON.stringify(view.state.value.inventory)));
  await view.prep.togglePrepared(meal, dish);
  assert.equal(view.prep.meal.value.preparedCount, 1);
  assert.equal(view.state.value.orders[0].status, 'accepted');
  assert.deepEqual(view.state.value.inventory, inventory);
  assert.equal(view.meals.value.length, 0);
  await view.prep.togglePrepared(view.prep.meal.value, view.prep.meal.value.dishes[0]);
  assert.equal(view.prep.meal.value.preparedCount, 0);
  view.scope.stop();
});

test('ready and undo behave identically before purchasing and after every add-ready cycle without confirmations', async () => {
  const view = shoppingView({ initialCart: true });
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await view.prep.markPrepared(view.prep.meal.value.dishes[0]);
    assert.equal(view.prep.meal.value.preparedCount, 1);
    assert.equal(view.prep.cartCount.value, 0);
    await view.prep.markPrepared(view.prep.meal.value.dishes[0]);
    assert.equal(view.prep.meal.value.preparedCount, 0);
    assert.equal(view.prep.cartCount.value, 0, 'undo must not reconstruct the old shopping intent');
    await view.prep.markPrepared(view.prep.meal.value.dishes[0]);
    assert.equal(view.prep.meal.value.preparedCount, 1);
    await view.prep.markPrepared(view.prep.meal.value.dishes[0]);
    await view.prep.purchaseDish(view.prep.meal.value.dishes[0]);
    assert.equal(view.prep.cartCount.value, 1);
  }
  assert.deepEqual(view.modals, []);
  assert.deepEqual(view.messages, []);
  assert.equal(view.busy.value, false);
  view.scope.stop();
});

test('ready saves exactly one dish signature and empties procurement without confirming or serving', async () => {
  const view = shoppingView({ initialCart: true });
  const meal = view.meals.value[0]; const dish = meal.dishes[0];
  await view.togglePrepared(meal, dish);
  assert.deepEqual(view.modals, []);
  assert.deepEqual(view.writes, [['prepared', 'dinner', 'tomato', true, dish.signature]]);
  assert.equal(cartDishCount(view), 0);
  assert.equal(view.prep.cartCount.value, 0);
  assert.equal(view.prep.meal.value.preparedCount, 1);
  assert.equal(view.state.value.orders[0].status, 'accepted');
  view.scope.stop();
});

test('failed ready saves retain their package and show a dish-scoped retry error', async () => {
  let fail = true;
  const view = shoppingView({ initialCart: true, wait: async () => { if (fail) throw new Error('网络未连接'); } });
  const meal = view.meals.value[0]; const dish = meal.dishes[0];
  await view.togglePrepared(meal, dish);
  assert.equal(view.failure.value.key, 'dinner:tomato');
  assert.equal(view.failure.value.message, '网络未连接');
  assert.equal(cartDishCount(view), 1);
  assert.deepEqual(view.messages, []);
  fail = false;
  await view.togglePrepared(meal, dish);
  assert.deepEqual(view.modals, []);
  assert.equal(cartDishCount(view), 0);
  view.scope.stop();
});

test('duplicate ready taps are blocked and completion stays silent after the state changes', async () => {
  let resolve;
  const view = shoppingView({ wait: () => new Promise(done => { resolve = done; }) });
  const meal = view.prep.meal.value; const dish = meal.dishes[0];
  const operation = view.prep.togglePrepared(meal, dish);
  await view.prep.togglePrepared(meal, dish);
  await tick();
  assert.equal(view.writes.length, 1);
  assert.deepEqual(view.messages, []);
  resolve(); await operation;
  assert.deepEqual(view.messages, []);
  assert.equal(view.prep.meal.value.preparedCount, 1);
  view.scope.stop();
});

test('package removal is confirmed separately from readiness and changes only that package', async () => {
  const view = shoppingView({ initialCart: true }); view.add('broccoli');
  const meal = view.meals.value[0]; const dish = meal.dishes.find(entry => entry.recipe.id === 'tomato');
  const operation = view.remove(meal, dish);
  assert.match(view.modals[0].content, /不会标记已备齐/);
  view.modals[0].success({ confirm: true }); await operation;
  assert.equal(cartDishCount(view), 1);
  assert.equal(view.prep.meal.value.preparedCount, 0);
  assert.equal(view.prep.meal.value.dishes.length, 2);
  assert.deepEqual(view.writes, [['remove', 'dinner', 'tomato', dish.shoppingSignature]]);
  assert.deepEqual(view.messages, []);
  view.scope.stop();
});

test('removal failure retains the package, unlocks the actions and supports retry', async () => {
  const view = shoppingView({ initialCart: true, wait: async () => { throw new Error('删除未保存'); } });
  const operation = view.remove(view.meals.value[0], view.meals.value[0].dishes[0]);
  view.modals[0].success({ confirm: true }); await operation;
  assert.equal(view.removeError.value.message, '删除未保存');
  assert.equal(cartDishCount(view), 1);
  assert.equal(view.busy.value, false);
  view.scope.stop();
});

test('procurement has no fake checkout action or unused selection state', () => {
  const view = shoppingView({ initialCart: true });
  const source = componentSource('ShoppingView');
  assert.equal(view.purchase, undefined);
  assert.doesNotMatch(source, /接入中|敬请期待|shopping-purchase|shopping-dish-select|shopping-meal-select|selectedCount|selectedMeals|unselected/);
  assert.doesNotMatch(source, />下单</);
  assert.equal(cartDishCount(view), 1);
  assert.equal(view.prep.meal.value.preparedCount, 0);
  assert.deepEqual(view.writes, []);
  view.scope.stop();
});

test('procurement keeps meal dish counts without checkout selectors', () => {
  const mealCount = nodes('ShoppingView').find(node => hasClass(node, 'shopping-meal-count'));
  assert.match(mealCount.loc.source, /\{\{ order.dishes.length \}\}道菜</);
  assert.equal(nodes('ShoppingView').some(node => hasClass(node, 'shopping-purchase')), false);
});

test('switching family closes the read-only preparation sheet and clears legacy procurement focus', async () => {
  const view = shoppingView({ initialCart: true });
  assert.equal(view.focusedId.value, 'dinner');
  view.state.value.family.id = 'new-family'; await nextTick();
  assert.equal(view.focusedId.value, '');
  assert.deepEqual(view.events, [['close']]);
  view.scope.stop();
});

test('late confirmation after a family switch cannot write to a new family', async () => {
  const view = shoppingView({ initialCart: true });
  const operation = view.remove(view.meals.value[0], view.meals.value[0].dishes[0]);
  view.state.value.family.id = 'different'; await nextTick();
  view.modals[0].success({ confirm: true }); await operation;
  assert.deepEqual(view.writes, []);
  view.scope.stop();
});

test('serving or cancelling removes its packages immediately without waiting for a tab revisit', async () => {
  const view = shoppingView({ initialCart: true });
  view.state.value.orders[0].status = 'completed'; await nextTick();
  assert.equal(view.meals.value.length, 0);
  assert.equal(view.prep.meal.value, undefined);
  view.scope.stop();
});

test('ready and purchasing controls keep shared title truncation and small-screen geometry', () => {
  for (const component of ['MealPreparationSheet', 'ShoppingView', 'ShoppingDraftEditor']) assert.match(componentSource(component), /class="meal-ingredient-title food-list-title"/);
  assert.equal(declarations('MealPreparationSheet', '.prep-dish-copy')['min-width'], '0');
  assert.equal(declarations('ShoppingView', '.shopping-dish-copy')['min-width'], '0');
  assert.equal(declarations('MealPreparationSheet', '.prep-dish-open')['min-width'], '0');
  assert.match(componentSource('ShoppingView'), /@media \(max-width: 360px\)/);
});
