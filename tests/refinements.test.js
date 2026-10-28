import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSeed } from '../src/data/seed.js';
import { makeOrder, mergeMealSelection, normalizeSnapshot, validateRecipe } from '../src/domain/kitchen.js';
import { mealDishRows, removeDishSelection, commentThreads } from '../src/domain/presentation.js';
import { makeShare, parseShare } from '../src/domain/sharing.js';

const recipes = createSeed().recipes;
const mealSets = [{ id: 'light', title: '轻食搭配', recipeIds: ['tomato', 'broccoli'] }, { id: 'dinner', title: '家常晚餐', recipeIds: ['tomato', 'chicken'] }];
const selection = { id: 'order', recipes, mealSets, member: { id: 'me', name: '我' }, date: '2026-09-08', meal: '晚餐' };

test('set and standalone selections render every unique dish and preserve overlapping group tags', () => {
  const order = makeOrder({ ...selection, cart: { 'set:light': 1, 'set:dinner': 1, tomato: 1, soup: 1 } });
  const rows = mealDishRows(order.items, order.entries);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.find((row) => row.recipe.id === 'tomato').groups.map((group) => group.title), ['轻食搭配', '家常晚餐']);
  assert.equal(rows.find((row) => row.recipe.id === 'soup').groups.length, 0);
  assert.equal(rows.find((row) => row.recipe.id === 'broccoli').groups[0].tone, 0);
  assert.equal(rows.find((row) => row.recipe.id === 'chicken').groups[0].tone, 1);
});
test('order grouping and votes survive changes or deletion in the family menu', () => {
  const first = makeOrder({ ...selection, cart: { 'set:light': 1 } });
  const other = makeOrder({ ...selection, member: { id: 'partner', name: '家人' }, cart: { tomato: 1 } });
  const merged = mergeMealSelection(first, other);
  const snapshot = normalizeSnapshot({ ...createSeed(), mealSets: [], orders: [merged] });
  const rows = mealDishRows(snapshot.orders[0].items, snapshot.orders[0].entries);
  assert.equal(rows[0].groups[0].title, '轻食搭配');
  assert.equal(rows[0].chosenBy.length, 2);
  assert.equal(rows[1].chosenBy.length, 1);
});
test('removing a dish from overlapping sets keeps all other dishes exactly once', () => {
  const cart = { 'set:light': 1, 'set:dinner': 1, tomato: 1, soup: 1 };
  const remaining = removeDishSelection(cart, mealSets, 'tomato');
  assert.deepEqual(remaining, { soup: 1, broccoli: 1, chicken: 1 });
  assert.equal(cart.tomato, 1);
  assert.equal(makeOrder({ ...selection, cart: remaining }).items.length, 3);
});
test('removing an unrelated standalone dish preserves chosen sets', () => {
  assert.deepEqual(removeDishSelection({ 'set:light': 1, soup: 1 }, mealSets, 'soup'), { 'set:light': 1 });
});
test('group metadata migrates for active old orders without touching completed history', () => {
  const order = makeOrder({ ...selection, cart: { 'set:light': 1 } });
  order.entries.forEach((entry) => { delete entry.recipeIds; });
  order.selections[0].entries.forEach((entry) => { delete entry.recipeIds; });
  const completed = { ...structuredClone(order), id: 'done', status: 'completed' };
  const next = normalizeSnapshot({ ...createSeed(), mealSets, orders: [order, completed] });
  assert.deepEqual(next.orders[0].entries[0].recipeIds, ['tomato', 'broccoli']);
  assert.deepEqual(next.orders[1], completed);
  assert.deepEqual(normalizeSnapshot(next), next);
});
test('nutrition is optional, validated and retained by sharing and parsing', () => {
  const recipe = { ...recipes[0], nutrition: '含蛋白质，可搭配蔬菜。' };
  assert.equal(parseShare(makeShare(recipe, recipes, '小家')).recipes[0].nutrition, recipe.nutrition);
  for (const nutrition of [undefined, '', ' ', '字'.repeat(500)]) assert.doesNotThrow(() => validateRecipe({ ...recipe, nutrition }));
  for (const nutrition of [null, 5, '字'.repeat(501)]) assert.throws(() => validateRecipe({ ...recipe, nutrition }), /营养疗效/);
});
test('comment threads keep replies and replies to replies together without duplication', () => {
  const threads = commentThreads([{ id: 'root', text: '好吃' }, { id: 'reply', parentId: 'root', text: '谢谢' }, { id: 'nested', parentId: 'root', replyToId: 'reply', text: '试试' }, { id: 'second', text: '再做一次' }]);
  assert.equal(threads.length, 2);
  assert.deepEqual(threads[0].replies.map((entry) => entry.id), ['reply', 'nested']);
  assert.equal(threads[1].replies.length, 0);
});
test('UI uses stable hero, icon selection, arrow-free fields and dish preparation cards', () => {
  const component = (name) => readFileSync(new URL(`../src/components/${name}.vue`, import.meta.url), 'utf8');
  const home = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8');
  assert.doesNotMatch(home, /v-if="menuMode === 'menu'" class="hero"|想吃 ＋/);
  assert.match(home, /<MealDishList\b[^>]*:rows="cartRows"/);
  assert.match(home, /<MealDishList :rows="orderRows\(order\)"/);
  for (const name of ['DateField', 'SelectField']) assert.doesNotMatch(component(name), /choice-arrow|⌄/);
  assert.doesNotMatch(component('MealDishList'), /chevron/);
  assert.match(component('InventoryView'), /name: '全部'/);
  assert.match(component('MealPreparationSheet'), /class="prep-card" :class="\{ 'is-prepared': dish.prepared, 'is-expanded': expanded.includes\(dish.recipe.id\) \}"/);
  assert.match(component('ShoppingView'), /shoppingCartMeals\(state.value, props.today\)/);
  assert.doesNotMatch(component('ShoppingView'), /买到了 ＋/);
});
