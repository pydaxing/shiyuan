import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import { baseParse } from '@vue/compiler-dom';
import postcss from 'postcss';
import sharp from 'sharp';
import { mainNavigation, hasIngredientManagement } from '../src/domain/navigation.js';

const read = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
const source = read('pages/index/index.vue');
const stylesheet = postcss.parse(read('styles.css'));
function nodesOf(content) {
  const nodes = [];
  function walk(node) { if (node.type === 1) { nodes.push(node); node.children.forEach(walk); } }
  baseParse(parse(content).descriptor.template.content).children.forEach(walk);
  return nodes;
}
const nodes = nodesOf(source);
const hasClass = (node, name) => node.props.some(prop => prop.name === 'class' && prop.value?.content.split(' ').includes(name));
const attribute = (node, name) => node.props.find(prop => prop.type === 6 && prop.name === name)?.value?.content;
const binding = (node, name) => node.props.find(prop => prop.name === 'bind' && prop.arg?.content === name)?.exp?.content;
const evaluate = (expression, context) => runInNewContext(`(${expression})`, context);
function declarationsFor(selector) {
  const declarations = new Map();
  stylesheet.walkRules(rule => { if (rule.selectors.includes(selector)) rule.walkDecls(declaration => declarations.set(declaration.prop, declaration.value)); });
  return declarations;
}

test('five navigation entries always retain procurement while only fridge controls its label and icon', () => {
  for (const features of [{}, { fridge: false, shopping: false }, { fridge: true, shopping: false }, { fridge: false, shopping: true }, { fridge: true, shopping: true }]) {
    const enabled = Boolean(features.fridge || features.shopping);
    const before = { ...features };
    assert.equal(hasIngredientManagement(features), enabled);
    assert.deepEqual(mainNavigation(features).map(item => item.label), ['菜单', '厨房', '美食', features.fridge ? '食材' : '采购', '我家']);
    assert.deepEqual(mainNavigation(features).map(item => item.icon), ['menu', 'chef', 'community', features.fridge ? 'inventory' : 'shopping', 'family']);
    assert.deepEqual(features, before, 'reading navigation must not migrate or save old feature settings');
  }
});

test('menu and kitchen are peer bottom buttons with fixed page titles and no family row', () => {
  const button = nodes.find(node => hasClass(node, 'nav-item'));
  assert.equal(button.tag, 'button');
  assert.equal(attribute(button, 'role'), 'button');
  assert.equal(attribute(button, 'hover-class'), 'touch-feedback');
  assert.equal(button.props.find(prop => prop.name === 'on' && prop.arg?.content === 'click').exp.content, 'selectNavigation(item.id)');
  assert.equal(binding(button.children[0].children.find(node => node.tag === 'AppIcon'), 'name'), 'item.icon');
  for (const item of mainNavigation({ fridge: true })) {
    assert.equal(evaluate(binding(button, 'aria-label'), { item }), item.label);
    assert.equal(evaluate(binding(button, 'aria-pressed'), { item, tab: item.id }), true);
  }
  assert.deepEqual(nodes.filter(node => node.tag === 'PageHeader').map(node => attribute(node, 'title')), ['我家菜单', '我家厨房']);
  assert.ok(!nodes.some(node => hasClass(node, 'menu-segments') || hasClass(node, 'hero')));
  assert.doesNotMatch(source, /menuMode|switchMenu|familyDisplay|editable @edit/);
});

test('menu remains mounted and all kitchen redirects use the new navigation entry', () => {
  assert.match(source, /<view v-show="tab === 'menu'" class="menu-view">/);
  assert.match(source, /<HomeMenu[^>]+:active="tab === 'menu'"/);
  assert.match(source, /useKitchenFocus\(orders, computed\(\(\) => tab.value === 'kitchen'\)/);
  const reveal = source.match(/function revealOrder\(orderId\) \{[\s\S]*?\n\}/)[0];
  assert.match(reveal, /tab.value = 'kitchen';/);
  assert.match(reveal, /kitchenFocus.focus\(orderId\)/);
  assert.match(source, /mealDraft.clear\(\); cartOpen.value = false; tab.value = 'kitchen';/);
  assert.match(source, /@click="openPreparation\(order\)"/);
  assert.match(source, /if \(!items.some\(\(item\) => item.id === tab.value\)\) tab.value = 'family'/);
});

test('navigation badges hide at zero and use a larger circle for 99+ without losing the true count', () => {
  for (const [id, countKey, label] of [['kitchen', 'pendingOrderCount', count => `待准备${count}餐`], ['ingredients', 'missingCount', count => `待采购${count}道菜`]]) {
    const badge = nodes.find(node => hasClass(node, 'nav-count') && node.props.some(prop => prop.name === 'if' && prop.exp.content.includes(`'${id}'`)));
    const visibility = badge.props.find(prop => prop.name === 'if').exp.content;
    const text = badge.children.find(node => node.type === 5).content.content;
    for (const count of [0, 1, 9, 10, 99, 100, 125, 1000]) {
      const context = { item: { id }, [countKey]: count };
      assert.equal(Boolean(evaluate(visibility, context)), count > 0);
      assert.equal(evaluate(text, context), count > 99 ? '99+' : count);
      assert.equal(evaluate(binding(badge, 'class'), context)['is-overflow'], count > 99);
      assert.equal(evaluate(binding(badge, 'aria-label'), context), label(count));
      assert.equal(Boolean(evaluate(visibility, { ...context, item: { id: 'menu' } })), false);
    }
  }
});

test('menu and kitchen reuse readable original PNG icons without filters', async () => {
  for (const name of ['menu', 'chef', 'menu-active', 'chef-active']) {
    const { data, info } = await sharp(readFileSync(new URL(`../src/static/icon-${name}.png`, import.meta.url))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 96);
    assert.equal(info.height, 96);
    let visiblePixels = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      if (data[offset + 3] < 128) continue;
      visiblePixels += 1;
      assert.ok(data[offset] < 200 && data[offset + 1] < 200 && data[offset + 2] < 200);
    }
    assert.ok(visiblePixels > 100);
  }
});

test('ingredients embed the original fridge and shopping behind the existing equal-width tabs', () => {
  const ingredients = read('components/IngredientsView.vue');
  const items = nodesOf(ingredients);
  assert.match(ingredients, /<PageHeader :title="fridgeEnabled \? '食材' : '采购'"/);
  const buttons = items.filter(node => attribute(node, 'role') === 'tab');
  assert.deepEqual(buttons.map(node => attribute(node, 'aria-label')), ['采购', '冰箱']);
  assert.equal(buttons.length, 2);
  for (const name of ['InventoryView', 'ShoppingView']) {
    const component = items.find(node => node.tag === name);
    assert.ok(component.props.some(prop => prop.name === 'embedded'));
    assert.ok(component.props.some(prop => prop.name === 'show'));
  }
  const control = declarationsFor('.menu-segments button');
  assert.equal(control.get('flex'), '1 1 0');
  assert.equal(control.get('min-height'), '44px');
  assert.equal(control.get('background'), 'transparent');
  assert.equal(control.get('border'), '0');
  assert.equal(declarationsFor('.menu-segments button.selected::after').get('height'), '3px');
  assert.doesNotMatch(ingredients, /库存|familyDisplay|FamilyCover|切换家庭/);
});

test('my home has a compact management entry and one shared ingredient and help card', () => {
  const family = read('components/FamilyView.vue');
  const items = nodesOf(family);
  assert.match(family, /computed\(\(\) => familyAppearance\(state.value.family\)\)/);
  assert.equal(binding(items.find(node => node.tag === 'PageHeader'), 'title'), 'familyDisplay.name');
  assert.ok(items.some(node => hasClass(node, 'family-banner')));
  assert.ok(!items.some(node => hasClass(node, 'hero')));
  assert.ok(family.indexOf('class="family-banner"') < family.indexOf('<CookingDiary'));
  assert.equal(items.filter(node => attribute(node, 'role') === 'switch').length, 1);
  assert.equal(items.filter(node => hasClass(node, 'family-management-entry')).length, 1);
  const preferences = items.find(node => hasClass(node, 'family-preferences'));
  const rows = preferences.children.filter(node => node.type === 1);
  assert.equal(rows.length, 2);
  assert.ok(hasClass(rows[0], 'feature-row'));
  assert.ok(hasClass(rows[1], 'family-help-entry'));
  assert.equal(attribute(items.find(node => attribute(node, 'role') === 'switch'), 'aria-label'), '冰箱');
  assert.equal(declarationsFor('.feature-copy .stock-name').get('font-weight'), '400');
  assert.equal(declarationsFor('.feature-copy .stock-name').get('font-size'), declarationsFor('.family-info-row').get('font-size'));
  assert.equal(declarationsFor('.stock-name').get('font-weight'), '500');
  assert.match(family, /setFridgeEnabled\(!familyFeatures.fridge\)/);
  assert.doesNotMatch(family, /我是大厨|按你家的习惯来|family-tools|食材管理|setFeature\(/);
});
