import { matchesImportedSource } from '../src/domain/kitchen.js';
import test from 'node:test';
import { NATIVE_UI_COLORS } from '../src/domain/ui-theme.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import { baseParse } from '@vue/compiler-dom';
import postcss from 'postcss';
import * as Vue from 'vue';
import { usePageLock } from '../src/composables/usePageLock.js';
import { registerSheet, sheetOpen } from '../src/composables/sheetStack.js';
import { useDiaryScroll, DIARY_DAY_WIDTH } from '../src/composables/useDiaryScroll.js';
import { useRecipeAccordion } from '../src/composables/useRecipeAccordion.js';
import { useCommunityNavigation } from '../src/composables/useCommunityNavigation.js';
import { useCommunityFeedViewport } from '../src/composables/useCommunityFeedViewport.js';
import { cookingDays } from '../src/domain/cooking-diary.js';
import { dateOffset } from '../src/domain/kitchen.js';
import { createCommunityFeed, communityFeedRevision } from '../src/services/community-feed.js';
import { FOOD_CATEGORIES, foodFeedQuery, orderFoodPosts, buildFoodWaterfall } from '../src/domain/food-feed.js';

const component = (name) => readFileSync(new URL(`../src/components/${name}.vue`, import.meta.url), 'utf8');

test('page is physically frozen at its previous offset until all nested sheets close', async () => {
  const scope = Vue.effectScope();
  const restored = [];
  const lock = scope.run(() => usePageLock(sheetOpen, (top) => restored.push(top)));
  lock.onScroll({ scrollTop: 835 });
  const editor = registerSheet();
  assert.equal(lock.style.value.position, 'fixed');
  assert.equal(lock.style.value.top, '-835px');
  lock.onScroll({ scrollTop: 0 });
  const date = registerSheet();
  date.close();
  await Vue.nextTick();
  assert.equal(lock.style.value.top, '-835px');
  assert.deepEqual(restored, []);
  editor.close();
  await Vue.nextTick();
  assert.deepEqual(lock.style.value, {});
  assert.deepEqual(restored, [835]);
  scope.stop();
});

test('reopening a sheet cancels stale restoration and a new tab resets the offset', async () => {
  const scope = Vue.effectScope();
  const restored = [];
  const lock = scope.run(() => usePageLock(sheetOpen, (top) => restored.push(top)));
  lock.onScroll({ scrollTop: 400 });
  const first = registerSheet();
  first.close();
  const next = registerSheet();
  await Vue.nextTick();
  assert.deepEqual(restored, []);
  lock.reset();
  next.close();
  await Vue.nextTick();
  assert.deepEqual(restored, [0]);
  scope.stop();
});

test('page-meta precedes the fixed page and only sheet chrome blocks touch moves', () => {
  const page = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8');
  assert.match(page, /<template>\s*<page-meta/);
  assert.match(page, /sheetOpen \? 'overflow: hidden;' : 'overflow: visible;'/);
  assert.match(page, /:style="pageStyle"/);
  const template = parse(component('Sheet')).descriptor.template.content;
  const nodes = [];
  function walk(node) { if (node.type === 1) { nodes.push(node); node.children.forEach(walk); } }
  baseParse(template).children.forEach(walk);
  for (const name of ['sheet-mask', 'sheet-header', 'sheet-footer']) {
    const node = nodes.find((entry) => entry.props.some((prop) => prop.name === 'class' && prop.value?.content === name));
    assert.ok(node.props.some((prop) => prop.name === 'on' && prop.arg?.content === 'touchmove' && prop.modifiers.includes('prevent')));
  }
  const scroll = nodes.find((entry) => entry.tag === 'scroll-view');
  assert.ok(!scroll.props.some((prop) => prop.name === 'on' && prop.arg?.content === 'touchmove' && prop.modifiers.includes('prevent')));
  assert.match(template, /class="icon-button sheet-close"[\s\S]*?icon-close.png/);
});

test('purchase expiry is always present outside the fridge-only location control', () => {
  const template = parse(component('StockEditor')).descriptor.template.content;
  let expiry;
  function walk(node, conditions = []) {
    if (node.type !== 1) return;
    const next = [...conditions, ...node.props.filter((prop) => prop.name === 'if').map((prop) => prop.exp?.content)];
    if (node.tag === 'DateField') expiry = next;
    node.children.forEach((child) => walk(child, next));
  }
  baseParse(template).children.forEach((node) => walk(node));
  assert.deepEqual(expiry, []);
  assert.doesNotMatch(template, /:preferred-height=/);
  assert.match(template, /v-if="!purchase \|\| state.family.features.fridge" v-model="draft.image" frame="recipe"/);
});

test('diary days cross leap days and years continuously, and only completed meals mark cooking', () => {
  const recipe = { id: 'dish', title: '米饭' };
  const orders = ['completed', 'pending', 'cancelled', 'accepted'].map((status, index) => ({ date: dateOffset(index, new Date('2024-02-28T12:00:00')), status, meal: '晚餐', items: [{ recipe }] }));
  const days = cookingDays(orders, '2024-02-28', 5);
  assert.deepEqual(days.map((day) => day.date), ['2024-02-28', '2024-02-29', '2024-03-01', '2024-03-02', '2024-03-03']);
  assert.deepEqual(days.map((day) => day.meals.length), [1, 0, 0, 0, 0]);
  assert.deepEqual(cookingDays([], '2026-12-31', 2).map((day) => day.date), ['2026-12-31', '2027-01-01']);
});

test('diary keeps the same day and pixel offset when prepending, without scroll feedback', async () => {
  const strip = useDiaryScroll('2026-09-08');
  await strip.earlier();
  assert.equal(strip.count.value, 93, 'initial positioning must finish before loading at the left edge');
  strip.onScroll({ detail: { scrollLeft: strip.scrollLeft.value } });
  strip.onScroll({ detail: { scrollLeft: 121 } });
  assert.equal(strip.scrollLeft.value, 29 * DIARY_DAY_WIDTH);
  const originalDate = dateOffset(2, new Date(`${strip.start.value}T12:00:00`));
  const originalMonth = strip.month.value;
  await strip.earlier();
  assert.equal(strip.count.value, 186);
  assert.equal(strip.scrollLeft.value, 121 + 93 * DIARY_DAY_WIDTH);
  assert.equal(dateOffset(95, new Date(`${strip.start.value}T12:00:00`)), originalDate);
  strip.onScroll({ detail: { scrollLeft: 0 } });
  assert.equal(strip.month.value, originalMonth, 'ignore stale pre-insertion scroll callbacks');
  strip.onScroll({ detail: { scrollLeft: strip.scrollLeft.value } });
  assert.equal(strip.month.value, originalMonth);
  await strip.earlier();
  assert.equal(strip.count.value, 279);
});

test('diary extends in both directions beyond a year and reports the center visible month', async () => {
  const strip = useDiaryScroll('2026-12-31');
  strip.resize(300);
  strip.onScroll({ detail: { scrollLeft: strip.scrollLeft.value } });
  for (let index = 0; index < 8; index += 1) {
    strip.later();
    strip.onScroll({ detail: { scrollLeft: 120 } });
    await strip.earlier();
    strip.onScroll({ detail: { scrollLeft: strip.scrollLeft.value } });
  }
  assert.equal(strip.count.value, 93 * 17);
  const expected = dateOffset(2 + 93 + 2, new Date(`${strip.start.value}T12:00:00`)).slice(0, 7);
  assert.equal(strip.month.value, expected);
});

test('diary circles mark only cooked days and have no month buttons or selected-date scroll snapping', () => {
  const source = component('CookingDiary');
  assert.match(source, /v-if="day.meals.length" class="diary-date-dot"/);
  assert.match(source, /today: day.date === today/);
  assert.match(source, /day.day === 1/);
  assert.match(source, /@scrolltoupper="earlier" @scrolltolower="later"/);
  assert.doesNotMatch(source, /scroll-into-view|shift\(|上个月|下个月/);
});

test('diary meal names and dish counts stay together on the left with a decorative middle dot', () => {
  const template = parse(component('CookingDiary')).descriptor.template.content;
  const nodes = [];
  function walk(node) { if (node.type === 1) { nodes.push(node); node.children.forEach(walk); } }
  baseParse(template).children.forEach(walk);
  const label = nodes.find(node => node.props.some(prop => prop.name === 'class' && prop.value?.content === 'diary-meal-label'));
  const texts = label.children.filter(node => node.type === 1);
  assert.deepEqual(texts.map(node => node.tag), ['text', 'text', 'text']);
  assert.match(texts[0].loc.source, /\{\{ meal.name \}\}/);
  assert.equal(texts[1].children[0].content, '·');
  assert.ok(texts[1].props.some(prop => prop.name === 'aria-hidden' && prop.value?.content === 'true'));
  assert.match(texts[2].loc.source, /\{\{ meal.recipes.length \}\} 道菜/);
  const values = new Map();
  postcss.parse(readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')).walkRules(rule => {
    if (rule.selectors.includes('.diary-meal-label')) rule.walkDecls(declaration => values.set(declaration.prop, declaration.value));
  });
  assert.equal(values.get('display'), 'flex');
  assert.equal(values.get('justify-content'), 'flex-start');
  assert.equal(values.get('gap'), '6px');
  assert.equal(values.get('font-size'), 'var(--type-control)');
});

test('kitchen headings group date, meal and status in compact matching tags with a right-side action menu', () => {
  const page = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const heading = page.match(/<view class="section-line compact order-card-heading">([\s\S]*?)<MealDishList/)[1];
  assert.match(page, /pending: '已预订', accepted: '已预订', completed: '已开饭', cancelled: '已取消'/);
  assert.doesNotMatch(page, /待备菜/);
  assert.match(heading, /class="order-tag order-date-tag">{{ mealDateLabel\(order.date, today\) }}/);
  assert.match(heading, /class="order-tag order-meal-tag">{{ order.meal }}/);
  assert.match(heading, /class="order-schedule">(?:(?!<\/view>)[\s\S])*<text class="order-tag order-status" :class="order.status"/);
  assert.match(heading, /<\/view>\s*<OrderActionMenu/);
  assert.doesNotMatch(heading, /{{\s*order.items.length\s*}}|道菜|order-add-button/);
  assert.doesNotMatch(page, /order-stamp|cancelled-stamp|order-dish-count/);
  assert.doesNotMatch(css, /order-stamp|cancelled-stamp|order-dish-count/);
  assert.match(css, /\.order-date-tag\s*\{[^}]*background: var\(--green-light\);[^}]*color: var\(--green\)/);
  assert.match(css, /\.order-meal-tag\s*\{[^}]*background: var\(--meal-light\);[^}]*color: var\(--meal\)/);
  const badge = css.match(/\.order-tag\s*\{([^}]+)\}/)[1];
  assert.match(badge, /display: inline-flex;/);
  assert.match(badge, /min-height: 24px;/);
  assert.match(badge, /padding: 3px 8px;/);
  assert.match(badge, /border-radius: var\(--radius-small\);/);
  assert.match(badge, /font-size: var\(--type-caption\);/);
  assert.match(badge, /line-height: 18px;/);
  assert.doesNotMatch(css.match(/\.order-status\s*\{([^}]+)\}/)[1], /font-size:|border-radius:|padding:|min-height:/);
  assert.doesNotMatch(badge, /box-shadow:|border:/);
  for (const [status, surface, color] of [['pending', 'warning-light', 'warning'], ['accepted', 'warning-light', 'warning'], ['completed', 'success-light', 'success'], ['cancelled', 'danger-light', 'danger']]) {
    const tone = css.match(new RegExp(`\\.order-status\\.${status}(?:,\\s*\\.order-status\\.\\w+)*\\s*\\{([^}]+)\\}`))[1];
    assert.ok(tone.includes(`background: var(--${surface});`));
    assert.ok(tone.includes(`color: var(--${color});`));
  }
  assert.match(page, /'is-finished': \['completed', 'cancelled'\]\.includes\(order.status\)/);
  assert.doesNotMatch(css, /\.order-card\.is-finished \.order-status/);
  assert.match(css, /\.order-card\.is-finished::after\s*\{[^}]*pointer-events: none;/);
  assert.doesNotMatch(css, /\.is-cancelled > \.section-line/);
});

test('kitchen keeps a left-aligned add action during preparation and retains recipe details', () => {
  const page = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const toolbar = page.match(/<view v-if="\['pending', 'accepted'\]\.includes\(order.status\)" class="order-actions">([\s\S]*?)<view class="order-progress-actions">/)[1];
  assert.match(toolbar, /class="text-button order-add-button"[^>]*@click="openAdditions\(order\)"/);
  assert.match(toolbar, /<AppIcon name="plus" :size="16" \/><text>加菜<\/text>/);
  assert.doesNotMatch(page, /备菜用量|cookingDetail|order-usage-button|mealPreparationRequirements/);
  assert.match(page, /<MealDishList[^>]*@open="orderRecipe = \$event"/);
  assert.match(page, /<RecipeSheet v-if="orderRecipe"[^>]*:recipe="orderRecipe"/);
  assert.match(css, /\.order-actions \.text-button\s*\{[^}]*margin-right: auto;/);
  assert.doesNotMatch(page, /class="order-tools"/);
  assert.doesNotMatch(toolbar, /chevron/);
});

test('kitchen preparation and serving share fixed dimensions without a separate start step', () => {
  const page = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const actions = page.match(/<view class="order-progress-actions">([\s\S]*?)<\/view>/)[1];
  const dimensions = css.match(/\.order-progress-actions \.primary-button, \.order-progress-actions \.secondary-button\s*\{([^}]+)\}/)[1];
  assert.doesNotMatch(actions, /开始备菜|去备菜|做好了|orderAction\(order, 'accepted'\)/);
  assert.match(actions, /@click="openPreparation\(order\)"[^>]*><AppIcon name="chef" active :size="16" \/><text>备菜 \{\{ preparationByOrder\[order.id\]\?\.preparedCount \|\| 0 \}\}\/\{\{ order.items.length \}\}<\/text><\/button>/);
  assert.doesNotMatch(actions, /features\.shopping|features\.fridge|openIngredients/);
  assert.match(actions, /<button role="button" class="primary-button"[^>]*@click="orderAction\(order, 'completed'\)"[^>]*><AppIcon name="menu-inverse" :size="16" \/><text>开饭<\/text><\/button>/);
  assert.match(dimensions, /flex: 0 0 96px;/);
  assert.match(dimensions, /width: 96px;/);
  assert.match(dimensions, /height: 44px;/);
  assert.match(dimensions, /min-height: 44px;/);
});

test('community import stays in the detail, requires confirmation and ignores duplicates', () => {
  const source = component('CommunityView');
  let script = compileScript(parse(source).descriptor, { id: 'community-confirmation' }).content;
  const post = { id: 'test', title: '南瓜汤', kind: 'dish', recipes: [{ id: 'test-recipe' }] };
  const snapshot = Vue.ref({ recipes: [], mealSets: [], posts: [], comments: [], family: { members: [] } });
  const imported = [];
  const modules = { ...Vue, state: snapshot, communityPosts: [], CATEGORIES: [], filterPosts: () => [], commentThreads: () => [], runAction: (action) => action(), addCollection: (value) => { imported.push(value); if (value.kind === 'menu') snapshot.value.mealSets.push({ sourceId: value.id }); else snapshot.value.recipes.push({ id: 'import', sourceId: 'test-recipe' }); }, notify() {} };
  Object.assign(modules, { matchesImportedSource, NATIVE_UI_COLORS, FOOD_CATEGORIES, foodFeedQuery, orderFoodPosts, buildFoodWaterfall, createCommunityFeed, communityFeedRevision, useRecipeAccordion, useCommunityNavigation, useCommunityFeedViewport, sheetOpen, cloudStatus: Vue.ref({ familyId: '' }), tapFeedback() {} });
  script = script.replace(/import (\{[^}]+\}|\w+) from '[^']+';/g, (_, binding) => `const ${binding} = ${binding.startsWith('{') ? 'modules' : '{}'};`);
  const setup = new Function('modules', script.replace('export default', 'return'))(modules).setup;
  const scope = Vue.effectScope();
  let modal;
  const previous = globalThis.uni;
  globalThis.uni = { showModal: (options) => { modal = options; } };
  try {
    const api = scope.run(() => setup({}, { expose() {}, emit() {} }));
    api.add(post);
    assert.deepEqual(imported, []);
    modal.success({ confirm: false });
    assert.deepEqual(imported, []);
    api.add(post);
    modal.success({ confirm: true });
    assert.deepEqual(imported, [post]);
    modal.success({ confirm: true });
    assert.equal(imported.length, 1);
    const mealSet = { ...post, id: 'set-test', title: '暖心双拼', kind: 'menu', recipes: [post.recipes[0], { id: 'second' }] };
    api.add(mealSet);
    assert.match(modal.content, /暖心双拼.*2 道菜/);
    modal.success({ confirm: false });
    assert.equal(imported.length, 1);
    api.add(mealSet);
    modal.success({ confirm: true });
    assert.deepEqual(imported, [post, mealSet]);
    assert.doesNotMatch(source, /@click="add\(entry.post\)"/);
    assert.match(source, /class="feed-body"[^>]*@click="open\(entry.post\)"/);
    assert.match(source, /@click="add\(current\)"/);
  } finally { scope.stop(); globalThis.uni = previous; }
});
