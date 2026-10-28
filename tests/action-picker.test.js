import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@vue/compiler-sfc';
import { baseParse } from '@vue/compiler-dom';
import postcss from 'postcss';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const styles = postcss.parse(source('src/styles.css'));
function nodesFor(path) {
  const nodes = [];
  function walk(node) {
    if (node.type !== 1) return;
    nodes.push(node);
    node.children.forEach(walk);
  }
  baseParse(parse(source(path)).descriptor.template.content).children.forEach(walk);
  return nodes;
}
const attribute = (node, name) => node.props.find(prop => prop.type === 6 && prop.name === name)?.value?.content;
const directive = (node, name, argument) => node.props.find(prop => prop.type === 7 && prop.name === name && (!argument || prop.arg?.content === argument));
const hasClass = (node, name) => (attribute(node, 'class') || '').split(' ').includes(name);
function declarations(selector) {
  const result = new Map();
  styles.walkRules(rule => { if (rule.selectors.includes(selector)) rule.walkDecls(declaration => result.set(declaration.prop, declaration.value)); });
  return result;
}

test('menu creation uses three labelled circle actions with the original destinations', () => {
  const nodes = nodesFor('src/pages/index/index.vue');
  const sheet = nodes.find(node => node.tag === 'Sheet' && directive(node, 'if')?.exp?.content === 'createMenuOpen');
  assert.equal(attribute(sheet, 'title'), '添加到菜单');
  assert.equal(attribute(sheet, 'variant'), 'action-picker');
  assert.equal(directive(sheet, 'bind', 'preferred-height'), undefined);
  const options = nodes.find(node => hasClass(node, 'menu-create-options'));
  assert.ok(hasClass(options, 'sheet-action-options'));
  const cells = options.children.filter(node => node.type === 1);
  assert.equal(cells.length, 3);
  for (const [index, label, handler] of [[0, '创建菜品', 'createDish()'], [1, '创建套餐', 'createSet()'], [2, '发现美食', 'discoverFood']]) {
    const button = cells[index].children.find(node => node.tag === 'button');
    assert.ok(hasClass(cells[index], 'sheet-action-cell'));
    assert.ok(hasClass(button, 'sheet-action-option'));
    assert.equal(attribute(button, 'aria-label'), label);
    assert.equal(directive(button, 'on', 'click').exp.content, handler);
    assert.ok(directive(button, 'on', 'click').modifiers.includes('stop'));
    assert.ok(button.children.some(node => node.type === 1 && hasClass(node, 'sheet-action-icon')));
    assert.ok(button.children.some(node => node.type === 1 && hasClass(node, 'sheet-action-label') && node.children[0].content === label));
  }
  assert.doesNotMatch(options.loc.source, /chevron|记下食材|把家里的|把喜欢的/);
});

test('create set uses a compartmented meal tray instead of the two-column grid icon', () => {
  const button = nodesFor('src/pages/index/index.vue').find(node => node.tag === 'button' && attribute(node, 'aria-label') === '创建套餐');
  assert.match(button.loc.source, /<AppIcon name="meal-set" :size="26" active/);
  assert.doesNotMatch(button.loc.source, /name="grid"/);
  assert.match(source('scripts/build-ui-art.mjs'), /'meal-set': '<rect[^']*<path[^']*<circle/);
  for (const variant of ['', '-active']) {
    const icon = readFileSync(new URL(`../src/static/icon-meal-set${variant}.png`, import.meta.url));
    assert.equal(icon.readUInt32BE(16), 96);
    assert.equal(icon.readUInt32BE(20), 96);
    assert.notDeepEqual(icon, readFileSync(new URL(`../src/static/icon-grid${variant}.png`, import.meta.url)));
  }
});

test('sharing keeps its native share card, public confirmation entry and privacy scope', () => {
  const nodes = nodesFor('src/components/FriendShareSheet.vue');
  const sheet = nodes.find(node => node.tag === 'Sheet');
  assert.equal(attribute(sheet, 'title'), '分享');
  assert.equal(attribute(sheet, 'variant'), 'action-picker');
  assert.equal(directive(sheet, 'bind', 'preferred-height'), undefined);
  const options = nodes.find(node => hasClass(node, 'friend-share-options'));
  assert.ok(hasClass(options, 'sheet-action-options'));
  assert.equal(options.children.filter(node => node.type === 1).length, 2);
  const native = nodes.find(node => node.tag === 'NativeShareButton');
  assert.equal(attribute(native, 'button-class'), 'sheet-action-option');
  assert.equal(attribute(native, 'label'), '分享给微信好友');
  assert.equal(directive(native, 'bind', 'card').exp.content, 'card');
  assert.match(native.loc.source, /微信好友/);
  const publish = nodes.find(node => node.tag === 'button' && attribute(node, 'aria-label')?.startsWith('发布到美食'));
  assert.equal(directive(publish, 'on', 'click').exp.content, "$feedback(); $emit('publish')");
  const emitted = [];
  new Function('$feedback', '$emit', directive(publish, 'on', 'click').exp.content)(() => {}, event => emitted.push(event));
  assert.deepEqual(emitted, ['publish']);
  const privacy = nodes.find(node => hasClass(node, 'share-privacy-note'));
  assert.match(privacy.loc.source, /仅分享菜品与做法，不含家庭信息/);
  assert.match(privacy.loc.source, /发布到美食后，所有人可见/);
  assert.doesNotMatch(options.loc.source, /chevron/);
});

test('unprepared friend shares disable during loading and retry in cloud mode', () => {
  const nodes = nodesFor('src/components/FriendShareSheet.vue');
  const fallback = nodes.find(node => node.tag === 'button' && directive(node, 'else'));
  const notices = [];
  const events = [];
  const click = new Function('$feedback', 'notify', 'cloudMode', '$emit', directive(fallback, 'on', 'click').exp.content);
  click(() => {}, message => notices.push(message), false, event => events.push(event));
  assert.deepEqual(notices, ['请在微信小程序中分享给好友']);
  click(() => {}, message => notices.push(message), true, event => events.push(event));
  assert.deepEqual(events, ['retry']);
  assert.equal(directive(fallback, 'bind', 'disabled').exp.content, 'preparing');
  assert.equal(directive(fallback, 'bind', 'aria-busy').exp.content, 'preparing');
  assert.equal(attribute(fallback, 'open-type'), undefined);
});

test('action circles share stable geometry, label size and transparent button surfaces', () => {
  const options = declarations('.sheet-action-options');
  assert.equal(options.get('display'), 'flex');
  assert.equal(options.get('justify-content'), 'center');
  assert.equal(options.get('gap'), '12px');
  assert.equal(declarations('.sheet-action-cell').get('flex'), '1 1 0');
  assert.equal(declarations('.sheet-action-cell').get('min-width'), '0');
  const icon = declarations('.sheet-action-icon');
  assert.equal(icon.get('width'), '56px');
  assert.equal(icon.get('height'), '56px');
  assert.equal(icon.get('border-radius'), '50%');
  assert.equal(icon.get('background'), 'var(--green-light)');
  const button = declarations('.sheet-action-option');
  assert.equal(button.get('background'), 'transparent');
  assert.equal(button.get('min-height'), '96px');
  assert.equal(button.get('gap'), '8px');
  assert.equal(declarations('.sheet-action-label').get('font-size'), 'var(--type-control)');
  assert.equal(declarations('.share-privacy-note').get('text-align'), 'center');
  for (const selector of ['.share-option', '.menu-create-option', '.menu-create-title']) assert.equal(declarations(selector).size, 0);
});

test('the compact sheet variant does not alter forms, details or safe-area ownership', () => {
  const sheet = source('src/components/Sheet.vue');
  assert.match(sheet, /'is-action-picker': variant === 'action-picker'/);
  assert.match(sheet, /'is-preparation': variant === 'preparation'/);
  assert.match(sheet, /'is-food-detail': immersive/);
  assert.equal(declarations('.sheet.is-action-picker .sheet-header').get('border-bottom'), '0');
  assert.equal(declarations('.sheet.is-action-picker .sheet-content').get('padding-top'), '8px');
  assert.match(sheet, /class="sheet-safe-space"/);
  assert.equal(declarations('.sheet.is-action-picker .sheet-safe-space').size, 0);
});

test('menu plus hover recolors its inset circle without expanding the visible tap surface', () => {
  const button = declarations('.home-menu-add');
  assert.equal(button.get('width'), '44px');
  assert.equal(button.get('height'), '44px');
  assert.equal(button.get('background'), 'none');
  assert.equal(declarations('.home-menu-add::before').get('inset'), 'var(--search-surface-inset)');
  assert.equal(declarations('.home-menu-add:not([disabled]):hover::before').get('background'), 'var(--control-hover)');
  styles.walkRules(rule => {
    if (!rule.selectors.some(selector => selector.includes('.home-menu-add') && selector.includes(':hover'))) return;
    assert.ok(rule.selectors.every(selector => selector.endsWith('::before')));
    rule.walkDecls(declaration => assert.equal(declaration.prop, 'background'));
  });
});
