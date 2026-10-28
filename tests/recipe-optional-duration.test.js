import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import { baseParse, compile } from '@vue/compiler-dom';
import * as Vue from 'vue';
import { createSeed } from '../src/data/seed.js';
import * as kitchen from '../src/domain/kitchen.js';
import * as presentation from '../src/domain/presentation.js';
import { createKitchenActions } from '../src/domain/actions.js';
import { parseShare } from '../src/domain/sharing.js';
import { portableShare } from '../src/services/sharing.js';
import { normalizeCommand } from '../server/validation.mjs';
import { presentMutation } from '../src/services/mutation-feedback.js';

const recipe = (minutes = null) => ({ ...createSeed().recipes[0], minutes });
const invalidMinutes = [undefined, NaN, 0, '', ' \t ', -1, 601, 1.5, Infinity, -Infinity, '0', '601', '1.5', 'NaN', 'null'];
const componentSource = (name) => readFileSync(new URL(`../src/components/${name}.vue`, import.meta.url), 'utf8');

test('sheet-count ingredients preserve 张 and use existing quantity rounding', () => {
  for (const unit of ['g', 'kg', 'ml', 'L', '个', '根', '只', '盒', '袋', '张']) assert.ok(kitchen.UNITS.includes(unit));
  const ingredient = { name: '手抓饼', quantity: 2, unit: '张' };
  assert.doesNotThrow(() => kitchen.validateIngredient(ingredient));
  assert.doesNotThrow(() => kitchen.validateRecipe({ ...recipe(), ingredients: [ingredient] }));
  assert.deepEqual(kitchen.normalizedIngredient(ingredient), { name: '手抓饼', quantity: 2, unit: '张', factor: 1, key: '手抓饼|张' });
  assert.equal(kitchen.purchaseQuantity(0.5, '张'), 1);
  assert.equal(kitchen.normalizedIngredient({ ...ingredient, quantity: 0.1 + 0.2 }).quantity, 0.3);
  assert.equal(kitchen.purchaseQuantity(1.0000001, '张'), 1);
});

function fixture() {
  let state = kitchen.normalizeSnapshot(createSeed());
  let sequence = 0;
  const actions = createKitchenActions({ getState: () => state, commit: (next) => { kitchen.validateSnapshot(next); state = kitchen.normalizeSnapshot(JSON.parse(JSON.stringify(next))); }, newId: (prefix) => `${prefix}-${++sequence}`, today: () => '2026-09-09' });
  return { actions, get state() { return state; } };
}

function editor(dish, saveRecipe = () => {}) {
  let script = compileScript(parse(componentSource('RecipeEditor')).descriptor, { id: 'optional-duration' }).content;
  const modules = { ...Vue, ...kitchen, ...presentation, presentMutation, saveRecipe, notify() {} };
  script = script.replace(/import (\{[^}]+\}|\w+) from '[^']+';/g, (_, binding) => `const ${binding} = ${binding.startsWith('{') ? 'modules' : '{}'};`);
  return new Function('modules', script.replace('export default', 'return'))(modules).setup({ recipe: dish }, { expose() {}, emit() {} });
}

function templateNodes(name) {
  const nodes = [];
  function walk(node) {
    if (node.type !== 1) return;
    nodes.push(node);
    node.children.forEach(walk);
  }
  baseParse(parse(componentSource(name)).descriptor.template.content).children.forEach(walk);
  return nodes;
}

test('recipe duration accepts explicit null and preserves valid numeric boundaries', () => {
  for (const minutes of [null, 1, 20, 600, '1', '20', '600']) {
    const dish = recipe(minutes);
    assert.equal(kitchen.recipeFieldErrors(dish).minutes, undefined);
    assert.doesNotThrow(() => kitchen.validateRecipe(dish));
    assert.equal(dish.minutes, minutes);
  }
});

test('recipe duration still rejects missing, empty, nonfinite and out-of-range values', () => {
  for (const minutes of invalidMinutes) {
    const dish = { ...recipe(), minutes };
    assert.match(kitchen.recipeFieldErrors(dish).minutes, /耗时/);
    assert.throws(() => kitchen.validateRecipe(dish), /耗时/);
  }
  const dish = recipe();
  delete dish.minutes;
  assert.throws(() => kitchen.validateRecipe(dish), /耗时/);
});

test('saving and editing preserve null through command validation and persisted snapshots', () => {
  const context = fixture();
  context.actions.saveRecipe(...normalizeCommand('saveRecipe', [recipe()]));
  const saved = context.state.recipes[0];
  assert.equal(saved.minutes, null);
  for (const minutes of [null, '35', null]) {
    context.actions.saveRecipe(...normalizeCommand('saveRecipe', [{ ...saved, minutes, title: '编辑后的菜' }, saved.id]));
    assert.equal(context.state.recipes[0].minutes, minutes === null ? null : 35);
    assert.equal(context.state.recipes[0].id, saved.id);
  }
});

test('invalid duration saves fail without mutating persisted state', () => {
  const context = fixture();
  const before = JSON.stringify(context.state);
  for (const minutes of invalidMinutes) {
    assert.throws(() => context.actions.saveRecipe({ ...recipe(), minutes }), /耗时/);
    assert.equal(JSON.stringify(context.state), before);
  }
});

test('editor keeps the creation default but opens unknown duration as blank', () => {
  assert.equal(editor().minutes.value, '20');
  for (const minutes of [null, 1, 25, 600]) {
    const form = editor(recipe(minutes));
    assert.equal(form.minutes.value, minutes === null ? '' : String(minutes));
    assert.equal(form.draft.value.minutes, minutes === null ? null : String(minutes));
  }
});

test('editor saves blank duration as null, reopens blank and still validates entered minutes', async () => {
  const context = fixture();
  const dish = context.state.recipes[0];
  const form = editor(dish, context.actions.saveRecipe);
  for (const blank of ['', ' \t ']) {
    form.minutes.value = blank;
    assert.equal(form.draft.value.minutes, null);
    await form.save();
    assert.equal(form.error.value, '');
    assert.equal(context.state.recipes[0].minutes, null);
    assert.equal(editor(context.state.recipes[0]).minutes.value, '');
  }
  for (const minutes of ['0', '601', '1.5', 'NaN']) {
    form.minutes.value = minutes;
    const before = JSON.stringify(context.state);
    await form.save();
    assert.match(form.fieldErrors.value.minutes, /耗时/);
    assert.equal(JSON.stringify(context.state), before);
  }
  form.minutes.value = '45';
  await form.save();
  assert.equal(context.state.recipes[0].minutes, 45);
});

test('duration input is visibly and accessibly marked optional', () => {
  const label = templateNodes('RecipeEditor').find((node) => node.tag === 'view' && node.children.some((child) => child.tag === 'FormField' && child.props.some((prop) => prop.name === 'model' && prop.exp?.content === 'minutes')));
  assert.ok(label);
  assert.match(label.loc.source, /选填/);
  const field = label.children.find((node) => node.tag === 'FormField');
  assert.match(field.props.find((prop) => prop.name === 'aria-label').value.content, /选填/);
});

test('dish and set sharing, community publication and imports retain unknown duration', async () => {
  for (const kind of ['dish', 'set']) {
    const context = fixture();
    context.actions.saveRecipe(recipe());
    const dish = context.state.recipes[0];
    if (kind === 'set') context.actions.saveMealSet({ title: '双拼套餐', recipeIds: [dish.id, 'chicken'] });
    const item = kind === 'dish' ? dish : context.state.mealSets[0];
    const shared = parseShare(await portableShare(item, context.state.recipes, '我家', kind, {}));
    assert.equal(shared.recipes[0].minutes, null);
    if (kind === 'set') assert.equal(shared.recipes[1].minutes, 25);
    context.actions.publishToCommunity(item.id, kind);
    assert.equal(context.state.posts[0].recipes[0].minutes, null);
    const receiver = fixture();
    receiver.actions.addCollection(shared);
    const imported = receiver.state.recipes.find((entry) => entry.sourceId === shared.recipes[0].id);
    assert.equal(imported.minutes, null);
    receiver.actions.saveRecipe({ ...imported, title: '导入后编辑' }, imported.id);
    assert.equal(receiver.state.recipes.find((entry) => entry.id === imported.id).minutes, null);
  }
});

test('dish and set orders keep null through member merges, selection edits and completion', () => {
  for (const kind of ['dish', 'set']) {
    const context = fixture();
    const { actions } = context;
    actions.saveRecipe(recipe());
    const dish = context.state.recipes[0];
    if (kind === 'set') actions.saveMealSet({ title: '双拼套餐', recipeIds: [dish.id, 'chicken'] });
    const key = kind === 'dish' ? dish.id : `set:${context.state.mealSets[0].id}`;
    const selection = { date: '2026-09-09', meal: '晚餐' };
    function assertUnknown() {
      const order = context.state.orders[0];
      assert.equal(order.items.find((item) => item.recipe.id === dish.id).recipe.minutes, null);
      for (const entry of order.selections) assert.equal(entry.items.find((item) => item.recipe.id === dish.id).recipe.minutes, null);
    }
    actions.submitOrder({ [key]: 1 }, selection);
    assertUnknown();
    actions.switchMember('partner');
    actions.submitOrder({ [dish.id]: 1 }, selection);
    assert.equal(context.state.orders[0].selections.length, 2);
    assertUnknown();
    actions.submitOrder({ [dish.id]: 1 }, selection, '少盐');
    assertUnknown();
    actions.submitOrder({}, selection);
    assert.equal(context.state.orders[0].selections.length, 1);
    assertUnknown();
    actions.saveRecipe({ ...dish, minutes: '30' }, dish.id);
    assertUnknown();
    actions.updateOrder(context.state.orders[0].id, 'accepted');
    actions.updateOrder(context.state.orders[0].id, 'completed');
    assert.equal(context.state.orders[0].status, 'completed');
    assertUnknown();
  }
});

for (const name of ['RecipeContent']) {
  test(`${name} hides unknown duration while rendering known minutes unchanged`, () => {
    const nodes = templateNodes(name).filter((node) => node.tag === 'text' && node.children.some((child) => child.type === 5 && child.content.content === 'recipe.minutes'));
    assert.equal(nodes.length, 1);
    const render = new Function('Vue', compile(nodes[0].loc.source, { mode: 'function' }).code)(Vue);
    assert.equal(render({ recipe: recipe() }, []).type, Vue.Comment);
    for (const minutes of [1, 25, 600]) {
      const rendered = render({ recipe: recipe(minutes) }, []);
      assert.equal(rendered.type, 'text');
      assert.equal(rendered.children, `${minutes} 分钟`);
    }
  });
}

test('set rows reuse metadata that omits unknown minutes and always shows the category', () => {
  for (const name of ['SetSheet', 'CommunityView', 'SetEditor']) {
    const node = templateNodes(name).find(node => node.tag === 'RecipeListMeta');
    assert.ok(node, name);
    assert.ok(node.props.some(prop => prop.arg?.content === 'category' && prop.exp?.content === 'recipe.category'));
    assert.ok(node.props.some(prop => prop.arg?.content === 'minutes' && prop.exp?.content === 'recipe.minutes'));
  }
  const duration = templateNodes('RecipeListMeta').find(node => node.tag === 'view' && node.props.some(prop => prop.name === 'if'));
  const render = new Function('Vue', compile(duration.loc.source, { mode: 'function' }).code)(Vue);
  for (const minutes of [null, undefined]) assert.equal(render({ minutes }, []).type, Vue.Comment);
  for (const minutes of [1, 25, 600]) assert.equal(render({ minutes }, []).children.find(child => child.type === 'text').children, `${minutes} 分钟`);
});

test('cover tags omit unknown duration and preserve the exact known value', () => {
  const duration = templateNodes('RecipeCover').find(node => node.tag === 'view' && node.props.some(prop => prop.name === 'if' && prop.exp?.content === 'minutes != null'));
  const render = new Function('Vue', compile(duration.loc.source, { mode: 'function' }).code)(Vue);
  for (const minutes of [null, undefined]) assert.equal(render({ minutes }, []).type, Vue.Comment);
  for (const minutes of [1, 25, 600]) {
    const content = render({ minutes }, []);
    assert.equal(content.type, 'view');
    assert.equal(content.children.find(child => child.type === 'text').children, `${minutes} 分钟`);
  }
});

test('family menu metadata omits unknown minutes without changing set counts', () => {
  const source = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8');
  const declaration = source.match(/const menuEntries = computed\(\(\) => \[[\s\S]*?\n\]\);/)[0];
  const state = Vue.ref({ recipes: [recipe(), { ...recipe(25), id: 'known' }], mealSets: [{ id: 'pair', recipeIds: ['tomato', 'known', 'removed'] }] });
  const entries = new Function('computed', 'state', `${declaration} return menuEntries.value;`)(Vue.computed, state);
  const row = new Function('AppIcon', 'FoodThumbnail', 'foodMinutesLabel', componentSource('MenuSwipeRow').match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\s*$/gm, '').replace('export default', 'return'))({}, {}, presentation.foodMinutesLabel);
  const metadata = key => row.computed.secondaryMeta.call({ entry: entries.find(entry => entry.key === key) });
  assert.equal(metadata('tomato'), '');
  assert.equal(entries.find((entry) => entry.key === 'tomato').minutes, null);
  assert.equal(metadata('known'), '25 分钟');
  assert.equal(metadata('set:pair'), '2 道菜');
});
