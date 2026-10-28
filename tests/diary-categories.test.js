import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSeed, communityPosts } from '../src/data/seed.js';
import { CATEGORIES, validateRecipe, importCollection, makeOrder, completeOrder } from '../src/domain/kitchen.js';
import { filterPosts, matchesMenuFilter } from '../src/domain/presentation.js';
import { cookingMonth, shiftDiaryMonth } from '../src/domain/cooking-diary.js';
import { makeShare, parseShare } from '../src/domain/sharing.js';

const seed = createSeed();
const recipes = seed.recipes;
function order(date, meal, status, cart = { tomato: 1 }) {
  return { ...makeOrder({ id: `${date}-${meal}`, date, meal, recipes, cart, member: seed.family.members[0] }), status };
}

test('other dish category validates, shares and imports with the same classification', () => {
  assert.deepEqual(CATEGORIES, ['荤菜', '素菜', '汤羹', '主食', '小食', '饮品', '其他']);
  const drink = { ...recipes[0], id: 'lemonade', title: '柠檬水', category: '其他' };
  assert.doesNotThrow(() => validateRecipe(drink));
  const post = parseShare(makeShare(drink, [drink], '我家'));
  const imported = importCollection([], post);
  assert.equal(imported[0].category, '其他');
  assert.equal(filterPosts([post], '菜品', '其他').length, 1);
  assert.equal(matchesMenuFilter({ kind: 'dish', recipes: imported }, '菜品', '其他'), true);
  assert.equal(filterPosts([post], '菜品', '荤菜').length, 0);
});
test('all seven canonical categories survive recipe sharing, import and menu filtering', () => {
  for (const category of CATEGORIES) {
    const recipe = { ...recipes[0], category };
    const post = parseShare(makeShare(recipe, [recipe], '我家'));
    const imported = importCollection([], post);
    assert.equal(imported[0].category, category);
    assert.equal(filterPosts([post], '菜品', category).length, 1);
    assert.equal(matchesMenuFilter({ kind: 'dish', recipes: imported }, '菜品', category), true);
  }
});
test('home and community match categories by recipe, never stale post tags or set ingredients', () => {
  for (const post of communityPosts) {
    const home = { kind: post.kind === 'menu' ? 'set' : 'dish', recipes: post.recipes };
    for (const type of ['全部', '菜品', '套餐']) {
      for (const category of ['全部', ...CATEGORIES]) {
        assert.equal(filterPosts([{ ...post, categories: ['不相关标签'] }], type, category).length > 0, matchesMenuFilter(home, type, category));
        if (type === '全部' && category !== '全部' && post.kind === 'menu') assert.equal(matchesMenuFilter(home, type, category), false);
      }
    }
  }
});
test('cooking diary counts only completed meals and days, deduplicating old split orders', () => {
  const orders = [order('2026-09-08', '晚餐', 'completed'), order('2026-09-08', '早餐', 'completed'), order('2026-09-08', '晚餐', 'completed', { tomato: 1, chicken: 1 }), order('2026-09-09', '午餐', 'accepted'), order('2026-09-09', '晚餐', 'cancelled'), order('2026-09-10', '午餐', 'pending'), order('2026-09-11', '午餐', 'completed'), order('2026-08-31', '晚餐', 'completed')];
  const before = structuredClone(orders);
  const month = cookingMonth(orders, '2026-09');
  assert.equal(month.cookedDays, 2);
  assert.equal(month.cookedMeals, 3);
  const day = month.days.find((entry) => entry.date === '2026-09-08');
  assert.deepEqual(day.meals.map((meal) => meal.name), ['早餐', '晚餐']);
  assert.equal(day.meals[1].recipes.length, 2);
  assert.equal(month.days.find((entry) => entry.date === '2026-09-09').meals.length, 0);
  assert.deepEqual(orders, before);
});
test('calendar uses Monday first and handles leap years, blank cells and month boundaries', () => {
  assert.equal(cookingMonth([], '2024-02').days.length, 29);
  assert.equal(cookingMonth([], '2025-02').days.length, 28);
  assert.equal(cookingMonth([], '2026-09').cells[0].day, null);
  assert.equal(cookingMonth([], '2026-09').cells[1].day, 1);
  assert.equal(cookingMonth([], '2026-03').cells.length, 42);
  assert.equal(shiftDiaryMonth('2026-01', -1), '2025-12');
  assert.equal(shiftDiaryMonth('2026-12', 1), '2027-01');
  assert.throws(() => cookingMonth([], '2026-13'), /有效月份/);
  assert.throws(() => shiftDiaryMonth('invalid', 1), /有效月份/);
});
test('cooking diary reflects completion, keeps recipe snapshots and uses meal date', () => {
  const state = { ...seed, family: { ...seed.family, features: { fridge: false, shopping: false } }, orders: [order('2026-09-07', '晚餐', 'accepted')] };
  assert.equal(cookingMonth(state.orders, '2026-09').cookedDays, 0);
  const completed = completeOrder(state, state.orders[0].id, '2026-09-07');
  completed.recipes = [];
  const diary = cookingMonth(completed.orders, '2026-09');
  assert.equal(diary.cookedDays, 1);
  assert.equal(diary.days[6].meals[0].recipes[0].title, '番茄炒蛋');
  assert.equal(diary.days[6].meals[0].recipes[0].steps.length, recipes[0].steps.length);
});
test('UI places zone add buttons outside filter buttons and uses noninteractive members', () => {
  const component = (name) => readFileSync(new URL(`../src/components/${name}.vue`, import.meta.url), 'utf8');
  const inventory = component('InventoryView');
  assert.match(inventory, /<PageHeader v-if="!embedded" title="冰箱" \/>/);
  assert.match(inventory, /<\/button>\s*<button role="button" class="zone-add"/);
  assert.match(inventory, /:initial="initialStock"/);
  assert.match(component('StockEditor'), /STOCK_LOCATIONS.includes\(props.initial.location\)/);
  const shopping = component('ShoppingView');
  assert.match(shopping, /<PageHeader v-if="!embedded" title="采购" \/>/);
  assert.match(shopping, /class="shopping-meal-heading"/);
  const family = component('FamilyView');
  assert.doesNotMatch(family, /switchMember|切换成员|当前成员/);
  assert.match(family, /<view v-for="member in state.family.members"/);
  assert.ok(family.indexOf('名称与封面') < family.indexOf('<CookingDiary'));
  assert.ok(family.indexOf('<CookingDiary') < family.indexOf('家庭成员</text>'));
  assert.match(component('CommunityView'), /<SelectField[^>]*:options="categories"[^>]*variant="feed"/);
  assert.doesNotMatch(component('CommunityView'), /v-if="type !== '套餐'"/);
  const home = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8');
  assert.match(home, /<view v-show="tab === 'menu'" class="menu-view">/);
  assert.match(home, /<HomeMenu[^>]*:active="tab === 'menu'"/);
  assert.doesNotMatch(home, /menuType|\['全部', \.\.\.CATEGORIES\]/);
  assert.match(component('HomeMenu'), /HOME_MENU_CATEGORIES/);
  for (const name of ['CommunityView', 'RecipeEditor']) assert.match(component(name), /CATEGORIES/);
});
