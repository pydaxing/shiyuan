import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@vue/compiler-sfc';
import { baseParse, compile } from '@vue/compiler-dom';
import * as Vue from 'vue';
import postcss from 'postcss';
import { mealVoterRows } from '../src/domain/presentation.js';

const source = name => readFileSync(new URL(`../src/components/${name}.vue`, import.meta.url), 'utf8');
const styles = postcss.parse(readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8'));
function declarations(selector, sheet = styles) {
  const result = {};
  sheet.walkRules(rule => {
    if (rule.selectors.includes(selector)) rule.walkDecls(declaration => { result[declaration.prop] = declaration.value; });
  });
  return result;
}
function nodes(name) {
  const result = [];
  function visit(node) { if (node.type === 1) { result.push(node); node.children.forEach(visit); } }
  baseParse(parse(source(name)).descriptor.template.content).children.forEach(visit);
  return result;
}
const hasClass = (node, name) => node.props.some(prop => prop.name === 'class' && prop.value?.content.split(' ').includes(name));

test('family avatars retain current member photos and shared anonymous rendering', () => {
  const photo = nodes('FamilyView').find(node => node.tag === 'LazyImage' && node.props.some(prop => prop.arg?.content === 'src' && prop.exp?.content === 'member.avatar'));
  assert.ok(photo);
  assert.ok(hasClass(photo, 'member-avatar-image'));
  for (const name of ['avatar', 'round']) assert.ok(photo.props.some(prop => prop.name === name), name);
  assert.equal(photo.props.find(prop => prop.name === 'variant')?.value?.content, 'card');
  assert.ok(!photo.props.some(prop => prop.arg?.content === 'fallback'), 'missing pictures use the anonymous icon, not nickname initials');
  const portrait = nodes('FamilyView').find(node => hasClass(node, 'member-photo'));
  assert.ok(!portrait.props.some(prop => prop.name === 'if'), 'members without photos still get a visible avatar container');
});

test('kitchen dishes release the avatar column without losing counts, food photos or checkout removal', () => {
  const mealNodes = nodes('MealDishList');
  const row = mealNodes.find(node => hasClass(node, 'meal-dish-row'));
  assert.equal(row.children.filter(node => node.type === 1).length, 3, 'the dish opener and mutually exclusive checkout / kitchen removal controls remain');
  assert.ok(mealNodes.some(node => node.tag === 'FoodThumbnail' && hasClass(node, 'meal-dish-photo')));
  assert.ok(mealNodes.some(node => hasClass(node, 'dish-voters')));
  const remove = mealNodes.find(node => hasClass(node, 'cart-remove'));
  assert.equal(remove.props.find(prop => prop.name === 'if')?.exp?.content, 'removable');
  assert.equal(remove.props.find(prop => prop.name === 'on' && prop.arg?.content === 'click')?.exp?.content, "$emit('remove', item.recipe.id)");
  assert.doesNotMatch(source('MealDishList'), /LazyImage|dish-avatar|member\.avatar/);
  for (const selector of ['.dish-avatar', '.dish-avatars']) assert.deepEqual(declarations(selector), {});
  assert.equal(declarations('.meal-dish-open').flex, '1');
  assert.equal(declarations('.meal-dish-copy').flex, '1');
  assert.equal(declarations('.meal-dish-copy')['min-width'], '0');
  const home = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8');
  assert.match(home, /<MealDishList :rows="orderRows\(order\)" :members="state.family.members"/);
});

test('the native avatar host fills its circle instead of collapsing as an unsized flex item', () => {
  const image = declarations('.member-avatar-image');
  assert.equal(image.position, 'absolute');
  assert.equal(image.inset, '0');
  assert.equal(image.display, 'block');
  assert.equal(image.width, '100%');
  assert.equal(image.height, '100%');
  assert.equal(image['border-radius'], '50%');
  for (const selector of ['.member-photo']) {
    const frame = declarations(selector);
    assert.equal(frame.position, 'relative', selector);
    assert.ok(Number.parseFloat(frame.width) > 0, selector);
    assert.equal(frame.width, frame.height, selector);
    assert.equal(frame['border-radius'], '50%', selector);
  }
  assert.equal(declarations('.member-photo > image').width, undefined, 'do not size a native image that is actually inside a custom component');
});

test('anonymous avatars use a light hollow head and open shoulder arc without remote image dependencies', () => {
  const placeholder = nodes('LazyImage').find(node => hasClass(node, 'lazy-avatar-fallback'));
  assert.ok(placeholder);
  const render = new Function('Vue', compile(placeholder.loc.source, { mode: 'function' }).code)(Vue);
  assert.equal(render({ avatarFallbackVisible: false }, []).type, Vue.Comment);
  const rendered = render({ avatarFallbackVisible: true }, []);
  assert.equal(rendered.props['aria-hidden'], 'true');
  assert.deepEqual(rendered.children.filter(child => child.type === 'view').map(child => child.props.class), ['lazy-avatar-head', 'lazy-avatar-shoulders']);
  const sheet = postcss.parse(parse(source('LazyImage')).descriptor.styles[0].content);
  const fallback = declarations('.lazy-avatar-fallback', sheet);
  assert.equal(fallback.position, 'absolute');
  assert.equal(fallback.inset, '0');
  assert.equal(fallback['pointer-events'], 'none');
  assert.equal(fallback.background, 'var(--paper)');
  assert.equal(fallback.color, 'var(--avatar-placeholder-ink)');
  const head = declarations('.lazy-avatar-head', sheet);
  const shoulders = declarations('.lazy-avatar-shoulders', sheet);
  assert.equal(head.background, 'transparent');
  assert.equal(head.border, '1.25px solid currentColor');
  assert.equal(head['border-radius'], '50%');
  assert.equal(shoulders.background, 'transparent');
  assert.equal(shoulders.border, head.border);
  assert.equal(shoulders['border-bottom'], '0');
  assert.equal(shoulders['border-radius'], '999px 999px 0 0');
  assert.equal(declarations(':root')['--avatar-placeholder-ink'], '#7e8b91');
});

test('order voter metadata retains current profiles and distinct identities without mutating snapshots', () => {
  const members = [
    { id: 'first', name: '微信昵称', avatar: 'https://example.com/wechat-avatar.png' },
    { id: 'second', name: '自选头像', avatar: 'cloud://family/profile.png' },
    { id: 'third', name: '未设置', avatar: '' },
  ];
  for (const status of ['pending', 'accepted', 'completed', 'cancelled']) {
    const rows = [{ status, recipe: { id: 'dish' }, groups: [], chosenBy: [
      { id: 'second', name: '旧昵称', avatar: 'cloud://family/outdated.png' },
      { id: 'first', name: '旧微信昵称' },
      { id: 'second', name: '重复点同一道菜' },
      { id: 'third', name: '旧头像', avatar: 'cloud://family/removed.png' },
      { id: 'departed', name: '已退出的家人', avatar: 'cloud://other-family/private.png' },
    ] }];
    const before = JSON.stringify([rows, members]);
    const [row] = mealVoterRows(rows, members);
    assert.deepEqual(row.voters.map(member => member.id), ['second', 'first', 'third', 'departed']);
    assert.deepEqual(row.voters.map(member => member.avatar), [members[1].avatar, members[0].avatar, '', '']);
    assert.deepEqual(row.voters.map(member => member.name), ['自选头像', '微信昵称', '未设置', '已退出的家人']);
    assert.equal(JSON.stringify([rows, members]), before);
  }
});

test('voter metadata follows profile changes without rewriting order snapshots', () => {
  const members = Vue.ref([{ id: 'member', name: '家人', avatar: 'cloud://family/old.png' }]);
  const rows = [{ recipe: { id: 'dish' }, chosenBy: [{ id: 'member', name: '点餐时的昵称' }] }];
  const displayed = Vue.computed(() => mealVoterRows(rows, members.value));
  assert.equal(displayed.value[0].voters[0].avatar, members.value[0].avatar);
  members.value[0].avatar = 'cloud://family/new.png';
  members.value[0].name = '新昵称';
  assert.equal(displayed.value[0].voters[0].avatar, 'cloud://family/new.png');
  assert.equal(displayed.value[0].voters[0].name, '新昵称');
  members.value[0].avatar = '';
  assert.equal(displayed.value[0].voters[0].avatar, '');
  members.value = [];
  assert.equal(displayed.value[0].voters[0].name, '点餐时的昵称');
  assert.equal(displayed.value[0].voters[0].avatar, '');
  assert.equal(rows[0].chosenBy[0].name, '点餐时的昵称');
});
