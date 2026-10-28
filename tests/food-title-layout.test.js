import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@vue/compiler-sfc';
import postcss from 'postcss';

const stylesheet = postcss.parse(readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8'));
const component = name => parse(readFileSync(new URL(`../src/components/${name}.vue`, import.meta.url), 'utf8')).descriptor;
const elements = node => [...(node.type === 1 ? [node] : []), ...(node.children || []).flatMap(elements)];
const hasClass = (node, name) => node.props.some(prop => prop.type === 6 && prop.name === 'class' && prop.value?.content.split(/\s+/).includes(name));
const directive = (node, name, argument) => node.props.find(prop => prop.type === 7 && prop.name === name && prop.arg?.content === argument)?.exp?.content;
const titleNode = (descriptor, expression) => elements(descriptor.template.ast).find(node => node.children.some(child => child.type === 5 && child.content.content === expression));
const declarations = selector => {
  const values = new Map();
  stylesheet.walkRules(rule => {
    if (rule.selectors.includes(selector)) rule.walkDecls(declaration => values.set(declaration.prop, declaration.value));
  });
  return values;
};

test('food list titles share one single-line ellipsis rule without changing typography', () => {
  const rules = [];
  stylesheet.walkRules(rule => { if (rule.selectors.includes('.food-list-title')) rules.push(rule); });
  assert.equal(rules.length, 1);
  const title = declarations('.food-list-title');
  assert.equal(title.get('display'), 'block');
  assert.equal(title.get('min-width'), '0');
  assert.equal(title.get('max-width'), '100%');
  assert.equal(title.get('overflow'), 'hidden');
  assert.equal(title.get('white-space'), 'nowrap');
  assert.equal(title.get('text-overflow'), 'ellipsis');
  for (const property of ['font-size', 'font-family', 'font-weight', 'height', '-webkit-line-clamp']) assert.equal(title.has(property), false);
});

for (const [name, expressions] of [
  ['MenuSwipeRow', ['entry.title']],
  ['MealDishList', ['item.recipe.title', 'group.title']],
  ['CommunityView', ['entry.post.title']],
  ['CookingDiary', ['dish.title']],
  ['AddDishesSheet', ['entry.title']],
  ['SetEditor', ['recipe.title']],
  ['ShareSheet', ['entry.title', 'selected.title']],
  ['ShoppingView', ['dish.recipe.title']],
]) {
  test(`${name} truncates display only and retains the complete food title`, () => {
    const descriptor = component(name);
    for (const expression of expressions) {
      const title = titleNode(descriptor, expression);
      assert.ok(title, expression);
      assert.equal(title.tag, 'text');
      assert.ok(hasClass(title, 'food-list-title'), expression);
    }
  });
}

test('collapsed set recipe titles truncate but expanded recipe details expose full names', () => {
  const recipe = { id: 'long-name', title: '香菇鸡腿焖饭（少盐少油家常版）' };
  const shared = parse(readFileSync(new URL('../src/pages/shared/index.vue', import.meta.url), 'utf8')).descriptor;
  for (const descriptor of [component('SetSheet'), component('CommunityView'), shared]) {
    const title = titleNode(descriptor, 'recipe.title');
    assert.equal(hasClass(title, 'food-list-title'), false);
    const classBinding = directive(title, 'bind', 'class');
    const classes = new Function('expanded', 'recipe', `return (${classBinding});`);
    assert.equal(classes(null, recipe)['food-list-title'], true);
    assert.equal(classes('another-recipe', recipe)['food-list-title'], true);
    assert.equal(classes(recipe.id, recipe)['food-list-title'], false);
  }
});

test('detail headers and recipe data remain full length with no shared truncation', () => {
  for (const [name, expression] of [['RecipeSheet', 'recipe.title'], ['SetSheet', 'mealSet.title'], ['CommunityView', 'current.title']]) {
    const sheet = elements(component(name).template.ast).find(node => node.tag === 'FoodDetailSheet');
    assert.equal(directive(sheet, 'bind', 'title'), expression);
    assert.equal(hasClass(sheet, 'food-list-title'), false);
  }
  const title = titleNode(component('Sheet'), 'title');
  assert.ok(hasClass(title, 'sheet-title'));
  assert.equal(hasClass(title, 'food-list-title'), false);
  assert.equal(declarations('.sheet-title').get('overflow-wrap'), 'anywhere');
  assert.equal(declarations('.sheet-title').has('text-overflow'), false);
  const foodTitle = titleNode(component('FoodDetailSheet'), 'title');
  assert.ok(hasClass(foodTitle, 'food-detail-title'));
  assert.equal(hasClass(foodTitle, 'food-list-title'), false);
  assert.equal(declarations('.food-detail-title').get('overflow-wrap'), 'anywhere');
  const shared = parse(readFileSync(new URL('../src/pages/shared/index.vue', import.meta.url), 'utf8')).descriptor;
  const sharedTitle = titleNode(shared, 'post.title');
  assert.ok(hasClass(sharedTitle, 'entry-title'));
  assert.equal(hasClass(sharedTitle, 'food-list-title'), false);
});

test('list title containers can shrink next to photos, controls and avatars', () => {
  for (const selector of ['.meal-dish-open', '.meal-dish-copy', '.recipe-list-copy', '.set-pick-copy', '.share-pick-copy', '.share-preview-copy', '.community-waterfall .feed-body', '.diary-recipe > text']) {
    assert.equal(declarations(selector).get('min-width'), '0', selector);
  }
  for (const [name, selectors] of [
    ['MenuSwipeRow', ['.home-menu-row-body', '.home-menu-info-slot', '.home-menu-info']],
    ['AddDishesSheet', ['.meal-addition-copy']],
    ['ShoppingView', ['.shopping-dish-open', '.shopping-dish-copy']],
    ['MealPreparationSheet', ['.prep-dish-open', '.prep-dish-copy']],
  ]) {
    const styles = postcss.parse(component(name).styles.map(style => style.content).join('\n'));
    for (const selector of selectors) {
      let minimumWidth;
      styles.walkRules(selector, rule => rule.walkDecls('min-width', declaration => { minimumWidth = declaration.value; }));
      assert.equal(minimumWidth, '0', `${name} ${selector}`);
    }
  }
});

test('legacy two-line title declarations no longer override the shared list rule', () => {
  for (const selector of ['.feed-title', '.community-waterfall .feed-title']) {
    const title = declarations(selector);
    assert.notEqual(title.get('display'), '-webkit-box');
    assert.equal(title.has('-webkit-line-clamp'), false);
    assert.notEqual(title.get('white-space'), 'normal');
  }
  for (const name of ['MenuSwipeRow', 'ShareSheet', 'ShoppingView']) {
    const descriptor = component(name);
    for (const style of descriptor.styles) assert.doesNotMatch(style.content, /-webkit-line-clamp/);
  }
});
