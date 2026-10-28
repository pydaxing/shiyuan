import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import { baseParse, compile } from '@vue/compiler-dom';
import * as Vue from 'vue';
import * as kitchen from '../src/domain/kitchen.js';
import * as presentation from '../src/domain/presentation.js';
import { createKitchenActions } from '../src/domain/actions.js';
import { createSeed } from '../src/data/seed.js';
import { makeShare, parseShare } from '../src/domain/sharing.js';
import { normalizeCommand } from '../server/validation.mjs';
import { NATIVE_UI_COLORS } from '../src/domain/ui-theme.js';
import { presentMutation } from '../src/services/mutation-feedback.js';

const today = '2026-09-10';
const textIngredient = (amountText = '适量', name = '盐') => ({ name, quantity: null, unit: '', amountText });
const recipe = (ingredients = [textIngredient()]) => ({ ...createSeed().recipes[0], ingredients });
const selection = (date = today) => ({ date, meal: '晚餐' });

function fixture(fridge = false) {
  let state = kitchen.normalizeSnapshot(createSeed());
  state.orders = [];
  state.purchases = [];
  state.family.features.fridge = fridge;
  let sequence = 0;
  const actions = createKitchenActions({ getState: () => state, commit: (next) => { state = kitchen.normalizeSnapshot(JSON.parse(JSON.stringify(next))); }, newId: (prefix) => `${prefix}-${++sequence}`, today: () => today });
  const requirements = () => kitchen.getShoppingRequirements(state, today);
  return { actions, requirements, get state() { return state; } };
}

function component(name, props = {}, bindings = {}) {
  const source = readFileSync(new URL(`../src/components/${name}.vue`, import.meta.url), 'utf8');
  let script = compileScript(parse(source).descriptor, { id: 'text-amounts' }).content;
  const modules = { ...Vue, ...kitchen, ...presentation, NATIVE_UI_COLORS, presentMutation, notify() {}, ...bindings };
  script = script.replace(/import (\{[^}]+\}|\w+) from '[^']+';/g, (_, binding) => `const ${binding} = ${binding.startsWith('{') ? 'modules' : '{}'};`);
  return new Function('modules', script.replace('export default', 'return'))(modules).setup(props, { expose() {}, emit() {} });
}

test('text recipe amounts survive validation and formatting without invented numbers', () => {
  for (const amountText of ['适量', '少许', '若干', '1～2个', '1块', '半茶匙', '按个人口味', '25一30克', '一'.repeat(60)]) {
    const ingredient = textIngredient(amountText);
    const dish = recipe([ingredient]);
    assert.doesNotThrow(() => kitchen.validateRecipe(dish));
    assert.deepEqual(normalizeCommand('saveRecipe', [dish])[0].ingredients, [ingredient]);
    assert.equal(kitchen.normalizedIngredient(ingredient).quantity, null);
    assert.equal(kitchen.formatAmount(ingredient.quantity, ingredient.unit, ingredient.amountText), amountText);
    assert.equal(normalizeCommand('saveRecipe', [dish])[0].ingredients[0].amountText, amountText);
  }
  assert.equal(kitchen.formatAmount(null, 'g'), '用量待确认');
  assert.equal(kitchen.formatAmount(undefined, ''), '用量待确认');
  assert.equal(kitchen.formatAmount(0.5, 'kg'), '500 g');
});

test('text quantities require explicit disjoint fields and do not relax numeric inventory', () => {
  for (const amountText of ['', ' ', null, 0, false, {}, [], '一'.repeat(61), '少\n许', '适\u0000量']) {
    assert.throws(() => kitchen.validateRecipe(recipe([textIngredient(amountText)])));
    assert.throws(() => normalizeCommand('saveRecipe', [recipe([textIngredient(amountText)])]));
  }
  for (const bad of [
    { name: '盐', quantity: null, unit: '' },
    { ...textIngredient(), quantity: 5 },
    { ...textIngredient(), quantity: undefined },
    { ...textIngredient(), unit: 'g' },
    { ...textIngredient(), unit: undefined },
  ]) assert.throws(() => kitchen.validateRecipe(recipe([bad])));
  for (const name of ['addStock', 'recordPurchase']) {
    assert.throws(() => normalizeCommand(name, [textIngredient()]));
    assert.throws(() => normalizeCommand(name, [{ ...textIngredient(), quantity: 5, unit: 'g' }]));
  }
  assert.throws(() => kitchen.validateIngredient(textIngredient()));
  assert.throws(() => kitchen.validatePurchase({ kind: 'confirmation', name: '盐', quantity: 5, unit: 'g' }));
});

test('editor switches between numeric and fixed text amounts, saves and reopens', async () => {
  const context = fixture();
  const dish = context.state.recipes[0];
  const form = component('RecipeEditor', { recipe: dish }, { saveRecipe: context.actions.saveRecipe });
  const ingredient = form.ingredients.value[0];
  form.changeIngredientUnit(ingredient, '少许');
  assert.deepEqual(ingredient, textIngredient('少许', dish.ingredients[0].name));
  await form.save();
  assert.equal(form.error.value, '');
  const saved = context.state.recipes.find((entry) => entry.id === dish.id);
  const reopened = component('RecipeEditor', { recipe: saved }, { saveRecipe: context.actions.saveRecipe });
  assert.equal(reopened.ingredients.value[0].amountText, '少许');
  assert.equal(reopened.ingredients.value[0].quantity, null);
  assert.equal(reopened.ingredientInput(reopened.ingredients.value[0]).unit, '少许');
  reopened.ingredients.value[0].amountText = ' ';
  await reopened.save();
  assert.match(reopened.fieldErrors.value['ingredients.0.amountText'], /用量/);
  assert.equal(context.state.recipes.find((entry) => entry.id === dish.id).ingredients[0].amountText, '少许');
  reopened.changeIngredientUnit(reopened.ingredients.value[0], 'g');
  assert.equal(kitchen.hasTextAmount(reopened.ingredients.value[0]), false);
  assert.equal(reopened.ingredients.value[0].quantity, '');
  reopened.ingredients.value[0].quantity = '500';
  await reopened.save();
  assert.deepEqual(context.state.recipes.find((entry) => entry.id === dish.id).ingredients[0], { name: dish.ingredients[0].name, quantity: 500, unit: 'g' });
});

function ingredientFields(form) {
  const template = parse(readFileSync(new URL('../src/components/RecipeEditor.vue', import.meta.url), 'utf8')).descriptor.template.content;
  const section = baseParse(template).children[0].children.find(node => node.type === 1 && node.props.some(prop => prop.name === 'class' && prop.value?.content === 'ingredient-editor'));
  const render = new Function('Vue', compile(section.loc.source, { mode: 'function' }).code)({ ...Vue, resolveComponent: name => name });
  const fields = [];
  function visit(node) {
    if (node?.type === 'FormField') fields.push(node.props['aria-label']);
    if (Array.isArray(node?.children)) node.children.forEach(visit);
    else if (node?.children?.default) node.children.default().forEach(visit);
  }
  visit(render(Vue.proxyRefs(form), []));
  return fields;
}

test('new ingredient offers fixed 适量 and 少许, with an amount input only for numeric units', async () => {
  const context = fixture();
  const form = component('RecipeEditor', {}, { saveRecipe: context.actions.saveRecipe });
  assert.deepEqual(form.ingredientUnitOptions, ['适量', '少许', ...kitchen.SELECTABLE_UNITS]);
  const ingredient = form.ingredients.value[0];
  assert.deepEqual(ingredient, textIngredient('适量', ''));
  assert.equal(form.ingredientInput(ingredient).unit, '适量');
  assert.deepEqual(ingredientFields(form), ['食材1名称']);
  form.title.value = '测试用量';
  form.steps.value[0].title = '调味拌匀';
  form.image.value = '/static/tomato.png';
  ingredient.name = '盐';
  await form.save();
  assert.deepEqual(context.state.recipes[0].ingredients, [textIngredient()]);
  form.changeIngredientUnit(ingredient, '少许');
  assert.deepEqual(ingredient, textIngredient('少许'));
  assert.deepEqual(ingredientFields(form), ['食材1名称']);
  await form.save();
  assert.equal(form.fieldErrors.value['ingredients.0.amountText'], undefined);
  assert.deepEqual(context.state.recipes[0].ingredients, [textIngredient('少许')]);
  form.changeIngredientUnit(ingredient, '少许');
  assert.equal(ingredient.amountText, '少许');
  for (const unit of ['g', '瓶', '汤匙']) {
    form.changeIngredientUnit(ingredient, unit);
    assert.deepEqual(ingredientFields(form), ['食材1名称', '食材1数量']);
    assert.equal(kitchen.hasTextAmount(ingredient), false);
    ingredient.quantity = '2';
  }
  form.changeIngredientUnit(ingredient, '适量');
  assert.deepEqual(ingredient, textIngredient());
  assert.deepEqual(ingredientFields(form), ['食材1名称']);
  form.changeIngredientUnit(ingredient, '少许');
  assert.deepEqual(ingredient, textIngredient('少许'));
  assert.deepEqual(ingredientFields(form), ['食材1名称']);
});

test('legacy amount and row identity survive deleting a preceding row and adding new rows', () => {
  const form = component('RecipeEditor', { recipe: recipe([textIngredient(), textIngredient('一小把', '葱')]) });
  const custom = form.ingredients.value[1];
  const identity = form.ingredientInput(custom).id;
  form.removeIngredient(0);
  assert.equal(form.ingredients.value[0], custom);
  assert.equal(form.ingredientInput(custom).id, identity);
  assert.equal(form.ingredientInput(custom).unit, '原用量');
  assert.equal(custom.amountText, '一小把');
  assert.deepEqual(ingredientFields(form), ['食材1名称']);
  form.removeIngredient(0);
  assert.equal(form.ingredients.value.length, 1);
  for (let index = 0; index < 35; index += 1) form.addIngredient();
  assert.equal(form.ingredients.value.length, 30);
  assert.equal(form.ingredientInputs.value.size, 30);
  assert.equal(new Set([...form.ingredientInputs.value.values()].map(input => input.id)).size, 30);
  assert.deepEqual(form.ingredients.value[29], textIngredient('适量', ''));
});

test('existing community numeric and text ingredients retain exact values through the editor and re-sharing', async () => {
  const ingredients = [
    textIngredient(), textIngredient('少许', '胡椒'), textIngredient('半茶匙', '盐'), textIngredient('1块', '姜'),
    textIngredient('1～2个', '番茄'), textIngredient('按个人口味', '糖'),
    { name: '鸡蛋', quantity: 2, unit: '个' }, { name: '啤酒', quantity: 0.5, unit: '瓶' },
  ];
  const context = fixture();
  const shared = parseShare(makeShare({ ...recipe(ingredients), id: 'community-amounts' }, [], '原作者', 'dish'));
  context.actions.addCollection(shared);
  const imported = context.state.recipes.find(entry => entry.sourceId === shared.recipes[0].id);
  const form = component('RecipeEditor', { recipe: imported }, { saveRecipe: context.actions.saveRecipe });
  assert.deepEqual(form.ingredients.value.map(item => form.ingredientInput(item).unit), ['适量', '少许', '原用量', '原用量', '原用量', '原用量', '个', '瓶']);
  await form.save();
  assert.equal(form.error.value, '');
  const saved = context.state.recipes.find(entry => entry.id === imported.id);
  assert.deepEqual(saved.ingredients, ingredients);
  assert.deepEqual(normalizeCommand('saveRecipe', [saved])[0].ingredients, ingredients);
  assert.deepEqual(parseShare(makeShare(saved, [], '我家', 'dish')).recipes[0].ingredients, ingredients);
});

test('removed custom and spoon choices cannot create an input or overwrite an ingredient', () => {
  const form = component('RecipeEditor');
  const ingredient = form.ingredients.value[0];
  for (const unsupported of ['自定义', '文字', '原用量', '一小把', '小勺', '大勺', '铲勺']) {
    form.changeIngredientUnit(ingredient, unsupported);
    assert.deepEqual(ingredient, textIngredient('适量', ''));
    assert.deepEqual(ingredientFields(form), ['食材1名称']);
  }
  const source = readFileSync(new URL('../src/components/RecipeEditor.vue', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /自定义用量|ingredient-text-input/);
  assert.match(source, /class="ingredient-original-amount"/);
});

test('retired spoon units remain intact when reopening and saving an existing recipe', async () => {
  for (const unit of ['小勺', '大勺', '铲勺']) {
    const original = recipe([{ name: '盐', quantity: 1, unit }]);
    const saves = [];
    const form = component('RecipeEditor', { recipe: original }, { saveRecipe: draft => saves.push(kitchen.clone(draft)) });
    const ingredient = form.ingredients.value[0];
    assert.equal(form.ingredientInput(ingredient).unit, unit);
    assert.equal(form.ingredientUnitOptions.includes(unit), false);
    assert.deepEqual(ingredientFields(form), ['食材1名称', '食材1数量']);
    await form.save();
    assert.equal(form.error.value, '');
    assert.equal(saves.length, 1);
    assert.deepEqual(saves[0].ingredients, original.ingredients);
    form.changeIngredientUnit(ingredient, '勺');
    assert.equal(ingredient.unit, '勺');
    assert.equal(ingredient.quantity, 1);
    assert.equal(original.ingredients[0].unit, unit);
  }
});

test('legacy amounts remain unchanged until an explicit replacement and never become numeric implicitly', () => {
  for (const original of ['半碗', '按个人口味', '一'.repeat(60), 'g', '  少许  ']) {
    const form = component('RecipeEditor', { recipe: recipe([textIngredient(original)]) });
    const ingredient = form.ingredients.value[0];
    assert.deepEqual(ingredient, textIngredient(original));
    assert.deepEqual(ingredientFields(form), ['食材1名称']);
    form.changeIngredientUnit(ingredient, 'g');
    assert.equal(kitchen.hasTextAmount(ingredient), false);
    assert.equal(ingredient.quantity, '');
    assert.equal(ingredient.unit, 'g');
    assert.deepEqual(ingredientFields(form), ['食材1名称', '食材1数量']);
    ingredient.quantity = '2';
    form.changeIngredientUnit(ingredient, '少许');
    assert.deepEqual(ingredient, textIngredient('少许'));
    assert.deepEqual(ingredientFields(form), ['食材1名称']);
  }
});

test('text amounts are preserved in snapshots, shares, sets and imported recipe edits', () => {
  const sender = fixture();
  sender.actions.saveRecipe(recipe());
  const dish = sender.state.recipes[0];
  sender.actions.saveMealSet({ title: '家常搭配', recipeIds: [dish.id, 'chicken'] });
  for (const kind of ['dish', 'set']) {
    const item = kind === 'dish' ? dish : sender.state.mealSets[0];
    const share = parseShare(makeShare(item, sender.state.recipes, '我家', kind));
    assert.deepEqual(share.recipes[0].ingredients, [textIngredient()]);
    const receiver = fixture();
    receiver.actions.addCollection(share);
    const imported = receiver.state.recipes.find((entry) => entry.sourceId === share.recipes[0].id);
    assert.deepEqual(imported.ingredients, [textIngredient()]);
    receiver.actions.saveRecipe({ ...imported, title: '我家改良版' }, imported.id);
    assert.deepEqual(receiver.state.recipes.find((entry) => entry.id === imported.id).ingredients, [textIngredient()]);
  }
});

test('aggregation scales only exact numbers, keeps aliases and distinct textual requirements', () => {
  const first = recipe([{ name: '盐', quantity: 5, unit: 'g' }, textIngredient(), textIngredient('少许')]);
  const second = { ...recipe([textIngredient(), { name: '盐', quantity: 0.001, unit: 'kg' }]), title: '第二道', id: 'second' };
  const rows = kitchen.aggregateItems([{ recipe: first, quantity: 2, scale: 3 }, { recipe: second, quantity: 1 }]);
  assert.equal(rows.length, 3);
  assert.equal(rows.find((row) => row.key === '盐|g').quantity, 31);
  assert.deepEqual(rows.find((row) => row.amountText === '适量').dishes, [first.title, second.title]);
  assert.equal(rows.find((row) => row.amountText === '适量').quantity, null);
  assert.equal(rows.find((row) => row.amountText === '少许').quantity, null);
  assert.equal(kitchen.normalizedIngredient(textIngredient('适量', '西红柿')).key, kitchen.normalizedIngredient(textIngredient('适量', '番茄')).key);
});

test('merged member choices do not multiply text amounts or drop them from order details', () => {
  const context = fixture();
  context.actions.saveRecipe(recipe());
  const dish = context.state.recipes[0];
  context.actions.submitOrder({ [dish.id]: 1 }, selection());
  context.actions.switchMember('partner');
  context.actions.submitOrder({ [dish.id]: 1 }, selection());
  assert.equal(context.state.orders[0].items.length, 1);
  assert.equal(context.state.orders[0].items[0].chosenBy.length, 2);
  assert.deepEqual(context.state.orders[0].items[0].recipe.ingredients, [textIngredient()]);
  const rows = kitchen.getRequirements(context.state.orders, context.state.inventory, selection(), today);
  assert.equal(rows[0].missing, null);
  assert.equal(rows[0].available, null);
  assert.equal(rows[0].needsConfirmation, true);
});

for (const fridge of [false, true]) {
  test(`unknown shopping requires manual confirmation, never invents stock (fridge=${fridge})`, () => {
    const context = fixture(fridge);
    context.actions.saveRecipe(recipe());
    const dish = context.state.recipes[0];
    context.actions.submitOrder({ [dish.id]: 1 }, selection());
    const stockBefore = kitchen.clone(context.state.inventory);
    const pending = context.requirements()[0];
    assert.equal(kitchen.needsShopping(pending), true);
    for (const field of ['quantity', 'missing', 'available', 'toBuy']) assert.equal(pending[field], null, field);
    context.actions.recordPurchase({ kind: 'confirmation', ...textIngredient() });
    context.actions.recordPurchase({ kind: 'confirmation', ...textIngredient() });
    assert.equal(context.state.purchases.length, 1);
    assert.equal(kitchen.needsShopping(context.requirements()[0]), false);
    assert.deepEqual(context.state.inventory, stockBefore);
    const orderId = context.state.orders[0].id;
    context.actions.updateOrder(orderId, 'accepted');
    context.actions.updateOrder(orderId, 'completed');
    assert.deepEqual(context.state.inventory, stockBefore);
    assert.deepEqual(context.state.purchases, []);
    assert.deepEqual(context.requirements(), []);
  });
}

test('exact and text requirements for the same ingredient remain independent', () => {
  const context = fixture(true);
  context.actions.saveRecipe(recipe([{ name: '盐', quantity: 5, unit: 'g' }, textIngredient()]));
  const dish = context.state.recipes[0];
  context.actions.submitOrder({ [dish.id]: 1 }, selection());
  const before = context.state.inventory.find((batch) => batch.name === '盐').quantity;
  context.actions.recordPurchase({ kind: 'confirmation', ...textIngredient() });
  assert.equal(context.requirements().length, 2);
  assert.equal(context.requirements().find((row) => row.key === '盐|g').quantity, 5);
  context.actions.updateOrder(context.state.orders[0].id, 'accepted');
  context.actions.updateOrder(context.state.orders[0].id, 'completed');
  assert.equal(context.state.inventory.find((batch) => batch.name === '盐').quantity, before);
});

test('new meals or additional dishes invalidate only the relevant text confirmation', () => {
  const context = fixture();
  context.actions.saveRecipe(recipe());
  const first = context.state.recipes[0];
  context.actions.submitOrder({ [first.id]: 1 }, selection());
  context.actions.recordPurchase({ kind: 'confirmation', ...textIngredient() });
  context.actions.switchMember('partner');
  context.actions.submitOrder({ [first.id]: 1 }, selection());
  assert.equal(kitchen.needsShopping(context.requirements()[0]), false);
  context.actions.saveRecipe({ ...recipe(), title: '另一道盐适量的菜' });
  const second = context.state.recipes[0];
  context.actions.submitOrder({ [first.id]: 1, [second.id]: 1 }, selection());
  assert.equal(kitchen.needsShopping(context.requirements()[0]), true);
  context.actions.recordPurchase({ kind: 'confirmation', ...textIngredient() });
  assert.equal(kitchen.needsShopping(context.requirements()[0]), false);
  context.actions.submitOrder({ [first.id]: 1 }, selection('2026-09-11'));
  assert.equal(kitchen.needsShopping(context.requirements()[0]), true);
  context.actions.recordPurchase({ kind: 'confirmation', ...textIngredient() });
  assert.equal(context.state.purchases.length, 2);
  context.actions.updateOrder(context.state.orders.find((order) => order.date === today).id, 'accepted');
  context.actions.updateOrder(context.state.orders.find((order) => order.date === today).id, 'completed');
  assert.equal(context.state.purchases.length, 1);
  assert.equal(kitchen.needsShopping(context.requirements()[0]), false);
});

test('cancellation and three day window remove manual shopping, invalid confirmations fail atomically', () => {
  const context = fixture();
  context.actions.saveRecipe(recipe());
  const dish = context.state.recipes[0];
  context.actions.submitOrder({ [dish.id]: 1 }, selection());
  const before = JSON.stringify(context.state);
  assert.throws(() => context.actions.recordPurchase({ kind: 'confirmation', ...textIngredient('少许') }), /已不在/);
  assert.equal(JSON.stringify(context.state), before);
  assert.deepEqual(kitchen.getShoppingRequirements(context.state, '2026-09-13'), []);
  context.actions.updateOrder(context.state.orders[0].id, 'cancelled');
  assert.deepEqual(context.requirements(), []);
  assert.throws(() => context.actions.recordPurchase({ kind: 'confirmation', ...textIngredient() }), /已不在/);
});

test('dish procurement displays original manual amounts without fabricating numeric requirements', async () => {
  const context = fixture();
  context.actions.saveRecipe(recipe());
  context.actions.submitOrder({ [context.state.recipes[0].id]: 1 }, selection());
  const { shoppingMeals } = await import('../src/domain/meal-preparation.js');
  const meals = shoppingMeals(context.state, today);
  const ingredients = meals[0].dishes[0].groups.flatMap(group => group.items);
  assert.equal(ingredients.find(item => item.name === '盐').amount, '适量');
  assert.doesNotMatch(JSON.stringify(ingredients), /NaN|0 g|null/);
  assert.equal(meals[0].preparedCount, 0);
  assert.equal(context.state.purchases.length, 0);
});
