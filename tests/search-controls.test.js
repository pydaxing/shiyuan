import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { baseParse } from '@vue/compiler-dom';
import { parse } from '@vue/compiler-sfc';
import postcss from 'postcss';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const styles = postcss.parse(source('src/styles.css'));

function elements(node, predicate) {
  return [node, ...(node.children || []).flatMap(child => elements(child, () => true))].filter(element => element.type === 1 && predicate(element));
}

function attribute(node, name) {
  return node.props.find(prop => prop.type === 6 && prop.name === name)?.value?.content;
}

function directive(node, name) {
  return node.props.find(prop => prop.type === 7 && prop.name === name);
}

function hasClass(node, name) {
  return (attribute(node, 'class') || '').split(/\s+/).includes(name);
}

function declarations(selector, stylesheet = styles, viewport = 390) {
  const values = new Map();
  stylesheet.walkRules(rule => {
    if (rule.parent.type === 'atrule' && rule.parent.name === 'media') {
      const maximum = rule.parent.params.match(/max-width:\s*(\d+)px/);
      const minimum = rule.parent.params.match(/min-width:\s*(\d+)px/);
      if ((maximum && viewport > Number(maximum[1])) || (minimum && viewport < Number(minimum[1]))) return;
    }
    if (rule.selectors.includes(selector)) rule.walkDecls(declaration => values.set(declaration.prop, declaration.value));
  });
  return values;
}

for (const [filename, searchClass, label] of [
  ['HomeMenu.vue', 'home-menu-search', '清空搜索'],
  ['CommunityView.vue', 'community-search', '清空美食搜索'],
  ['AddDishesSheet.vue', 'meal-addition-search', '清空加菜搜索'],
]) {
  test(`${filename} keeps the search icon, input and clear slot stable in native layout`, () => {
    const template = baseParse(parse(source(`src/components/${filename}`)).descriptor.template.content);
    const search = elements(template, node => hasClass(node, searchClass))[0];
    const slots = search.children.filter(node => node.type === 1);
    assert.deepEqual(slots.map(node => attribute(node, 'class')), ['search-leading-icon', 'search-input-slot', 'search-clear-slot']);
    for (const slot of slots) {
      assert.equal(slot.tag, 'view');
      assert.equal(directive(slot, 'if'), undefined);
      assert.equal(directive(slot, 'show'), undefined);
    }
    const icon = elements(slots[0], node => node.tag === 'AppIcon')[0];
    assert.equal(attribute(icon, 'name'), 'search');
    assert.equal(directive(icon, 'if'), undefined);
    assert.equal(attribute(slots[0], 'aria-hidden'), 'true');
    const fields = elements(slots[1], node => node.tag === 'FormField');
    assert.equal(fields.length, 1);
    assert.equal(directive(fields[0], 'if'), undefined);
    const buttons = elements(slots[2], node => node.tag === 'button');
    assert.equal(buttons.length, 1);
    assert.equal(directive(buttons[0], 'if').exp.content, 'search');
    assert.equal(attribute(buttons[0], 'aria-label'), label);
    assert.ok(buttons[0].props.some(prop => prop.name === 'on' && prop.arg?.content === 'click' && prop.exp.content === 'clearSearch'));
  });
}

test('search geometry does not depend on native custom components being direct flex children', () => {
  for (const selector of ['.search-leading-icon', '.search-input-slot', '.search-clear-slot']) {
    assert.equal(declarations(selector).get('position'), 'relative');
    assert.equal(declarations(selector).get('z-index'), '1');
  }
  assert.equal(declarations('.search-leading-icon').get('flex'), '0 0 16px');
  assert.equal(declarations('.search-input-slot').get('flex'), '1');
  assert.equal(declarations('.search-input-slot').get('width'), '0');
  assert.equal(declarations('.search-input-slot input').get('padding'), '0');
  assert.equal(declarations('.search-input-slot input').get('text-align'), 'left');
  assert.equal(declarations('.search-clear-slot').get('flex'), '0 0 44px');
  assert.equal(declarations('.search-clear-slot .search-clear').get('width'), '44px');
  assert.equal(declarations('.search-clear-slot .search-clear').get('height'), '44px');
  assert.equal(declarations('.search-clear-slot .search-clear').get('margin'), '0');
  assert.equal(declarations('.search-clear-slot .search-clear .app-icon').get('width'), '16px');
  for (const selector of ['.home-menu .home-menu-search', '.community-toolbar .community-search', '.meal-addition-search.search-wrap']) {
    assert.equal(declarations(selector).get('padding'), '0 0 0 10px');
    assert.equal(declarations(selector).get('gap'), '5px');
  }
  assert.equal(declarations('.community-single-toolbar .community-search').get('margin-left'), '8px');
});

test('menu, food and add-dishes search fields share the same 14px font without page-specific overrides', () => {
  const selectors = ['.home-menu-search .home-menu-search-input', '.community-search .form-field input', '.meal-addition-search .form-field input'];
  for (const viewport of [320, 390, 768]) {
    for (const selector of selectors) {
      const field = declarations(selector, styles, viewport);
      assert.equal(field.get('font-size'), 'var(--type-control)');
      assert.equal(field.get('height'), '44px');
    }
  }
  const fontRules = [];
  styles.walkRules(rule => {
    if (!/home-menu-search|community-search/.test(rule.selector)) return;
    rule.walkDecls('font-size', () => fontRules.push(rule.selectors));
  });
  assert.deepEqual(fontRules, [selectors]);
});

test('add-dishes reuses the home capsule height, outline and clear control instead of a local input surface', () => {
  for (const suffix of ['', '::before', ':focus-within', ':focus-within::before']) {
    assert.deepEqual(declarations(`.meal-addition-search.search-wrap${suffix}`), declarations(`.home-menu .home-menu-search${suffix}`));
  }
  const component = parse(source('src/components/AddDishesSheet.vue')).descriptor;
  assert.doesNotMatch(component.styles[0].content, /\.meal-addition-search|:deep\(\.search-input\)/);
  const template = baseParse(component.template.content);
  const empty = elements(template, node => hasClass(node, 'meal-addition-empty'))[0];
  assert.equal(attribute(empty, 'role'), 'status');
  assert.equal(elements(empty, node => node.tag === 'button').length, 0);
  const layout = declarations('.meal-addition-empty', postcss.parse(component.styles[0].content));
  assert.equal(layout.get('align-items'), 'center');
  assert.equal(layout.get('padding'), '36px 8px 24px');
  assert.equal(layout.get('text-align'), 'center');
});

test('a 320px food toolbar keeps both search hint characters and the full clear touch height', () => {
  const viewport = 320;
  const pixels = (selector, property) => {
    const value = declarations(selector, styles, viewport).get(property);
    const token = value?.match(/^var\((--[a-z-]+)\)$/)?.[1];
    return Number.parseFloat(token ? declarations('page', styles, viewport).get(token) : value);
  };
  const available = viewport - 2 * pixels('page', '--page-gutter');
  const controls = 2 * pixels('.community-single-toolbar .community-order-button', 'min-width') + pixels('.community-single-toolbar .community-filter-trigger', 'min-width');
  const searchWidth = available - controls - 3 * pixels('.community-single-toolbar', 'gap') - pixels('.community-single-toolbar .community-search', 'margin-left');
  const inputWidth = searchWidth - pixels('.community-single-toolbar .community-search', 'padding-left') - pixels('.search-leading-icon', 'width') - 2 * pixels('.community-toolbar .community-search', 'gap') - pixels('.search-clear-slot', 'width');
  assert.ok(inputWidth >= 2 * pixels('.community-search .form-field input', 'font-size'));
  assert.equal(pixels('.search-clear-slot', 'height'), 44);
  assert.equal(pixels('.community-order-button', 'height'), 44);
  assert.equal(pixels('.community-filter-trigger', 'height'), 44);
});

test('menu empty search is horizontally centered near the top without counts or a second clear action', () => {
  const component = parse(source('src/components/HomeMenu.vue')).descriptor;
  const template = baseParse(component.template.content);
  const empty = elements(template, node => hasClass(node, 'home-menu-empty'))[0];
  assert.equal(attribute(empty, 'role'), 'status');
  assert.match(empty.loc.source, /没有找到相关菜品或套餐/);
  assert.match(empty.loc.source, /换一换试试/);
  assert.equal(elements(empty, node => node.tag === 'button').length, 0);
  assert.doesNotMatch(component.template.content, /找到 \{\{ resultCount \}\} 项|home-menu-search-count|试试菜名/);
  const layout = declarations('.home-menu-empty', postcss.parse(component.styles[0].content));
  assert.equal(layout.get('align-items'), 'center');
  assert.equal(layout.get('text-align'), 'center');
  assert.equal(layout.get('justify-content'), 'flex-start');
  assert.equal(layout.get('min-height'), undefined);
});

test('menu empty search centers on the full menu rather than the right list without blocking categories', () => {
  const component = parse(source('src/components/HomeMenu.vue')).descriptor;
  const template = baseParse(component.template.content);
  const menuLayout = elements(template, node => hasClass(node, 'home-menu-layout'))[0];
  const empty = menuLayout.children.find(node => node.type === 1 && hasClass(node, 'home-menu-empty'));
  assert.ok(empty);
  assert.equal(directive(empty, 'if').exp.content, 'query && !resultCount');
  const list = elements(menuLayout, node => hasClass(node, 'home-menu-list'))[0];
  assert.equal(elements(list, node => hasClass(node, 'home-menu-empty')).length, 0);
  assert.equal(elements(menuLayout, node => hasClass(node, 'home-menu-rail')).length, 1);
  const stylesheet = postcss.parse(component.styles[0].content);
  for (const viewport of [320, 390, 768]) {
    assert.equal(declarations('.home-menu-layout', stylesheet, viewport).get('position'), 'relative');
    const layout = declarations('.home-menu-empty', stylesheet, viewport);
    assert.equal(layout.get('position'), 'absolute');
    assert.equal(layout.get('left'), '0');
    assert.equal(layout.get('right'), '0');
    assert.equal(layout.get('top'), '0');
    assert.equal(layout.get('padding'), '36px 8px 24px');
    assert.equal(layout.get('pointer-events'), 'none');
  }
});

test('food empty results cannot reset the category to the removed all option', () => {
  const component = source('src/components/CommunityView.vue');
  const template = baseParse(parse(component).descriptor.template.content);
  const empty = elements(template, node => hasClass(node, 'community-search-empty'))[0];
  assert.equal(attribute(empty, 'role'), 'status');
  assert.match(empty.loc.source, /没有找到相关菜品或套餐/);
  assert.match(empty.loc.source, /换一换试试/);
  assert.equal(elements(empty, node => node.tag === 'button').length, 0);
  assert.doesNotMatch(component, /查看全部|category(?:\.value)?\s*=\s*['"]全部['"]/);
  assert.equal(declarations('.search-empty-hint').get('font-size'), 'var(--type-control)');
  assert.equal(declarations('.search-empty-hint').get('color'), 'var(--muted)');
});
