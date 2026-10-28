import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { effectScope, nextTick, watch } from 'vue';
import { parse } from '@vue/compiler-sfc';
import { baseParse } from '@vue/compiler-dom';
import { useRecipeAccordion } from '../src/composables/useRecipeAccordion.js';

function accordionHarness(options) {
  const scope = effectScope();
  const anchors = [];
  const accordion = scope.run(() => {
    const controller = useRecipeAccordion(options);
    watch(controller.scrollAnchor, anchor => anchors.push(anchor), { flush: 'sync' });
    return controller;
  });
  return { ...accordion, anchors, stop: () => scope.stop() };
}

test('recipe expansion waits for rendering before anchoring, then releases the scroll command', async () => {
  const accordion = accordionHarness();
  const pending = accordion.toggleRecipe('recipe-one', 0);
  assert.equal(accordion.expanded.value, 'recipe-one');
  assert.equal(accordion.scrollAnchor.value, '');
  await pending;
  assert.deepEqual(accordion.anchors, [accordion.recipeAnchor(0), '']);
  assert.equal(accordion.scrollAnchor.value, '');
  accordion.stop();
});

test('recipe switching waits for the native view update before requesting its new anchor', async (context) => {
  const original = globalThis.wx;
  const frames = [];
  globalThis.wx = { nextTick: callback => frames.push(callback) };
  context.after(() => { if (original === undefined) delete globalThis.wx; else globalThis.wx = original; });
  const accordion = accordionHarness();
  context.after(accordion.stop);
  const pending = accordion.toggleRecipe('recipe-two', 1);
  await nextTick();
  assert.equal(frames.length, 1);
  assert.equal(accordion.scrollAnchor.value, '');
  frames.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(accordion.scrollAnchor.value, accordion.recipeAnchor(1));
  assert.equal(frames.length, 1);
  frames.shift()();
  await pending;
  assert.equal(accordion.scrollAnchor.value, '');
});

test('rapidly opening another recipe cancels the older anchor instead of scrolling back', async () => {
  const accordion = accordionHarness();
  const first = accordion.toggleRecipe('first', 0);
  const second = accordion.toggleRecipe('second', 1);
  await Promise.all([first, second]);
  assert.equal(accordion.expanded.value, 'second');
  assert.deepEqual(accordion.anchors, [accordion.recipeAnchor(1), '']);
  accordion.stop();
});

test('closing and reopening the same recipe can anchor again without scrolling on collapse', async () => {
  const accordion = accordionHarness();
  await accordion.toggleRecipe('same', 0);
  const beforeCollapse = [...accordion.anchors];
  await accordion.toggleRecipe('same', 0);
  assert.equal(accordion.expanded.value, '');
  assert.deepEqual(accordion.anchors, beforeCollapse);
  await accordion.toggleRecipe('same', 0);
  assert.deepEqual(accordion.anchors, [...beforeCollapse, accordion.recipeAnchor(0), '']);
  accordion.stop();
});

test('a drag, reset, closing the detail, or disposing its scope cancels deferred positioning', async () => {
  for (const action of ['cancelRecipeScroll', 'resetRecipes', 'stop', 'inactive']) {
    let active = true;
    const accordion = accordionHarness({ isActive: () => active });
    const pending = accordion.toggleRecipe('first', 0);
    if (action === 'inactive') active = false;
    else accordion[action]();
    await pending;
    assert.deepEqual(accordion.anchors, [], action);
    assert.equal(accordion.scrollAnchor.value, '', action);
    if (action === 'resetRecipes') assert.equal(accordion.expanded.value, '');
    accordion.stop();
  }
});

test('friend-shared pages use the same post-render recipe target without a sheet scroll command', async () => {
  const targets = [];
  const accordion = accordionHarness({ scrollTo: anchor => targets.push(anchor) });
  const pending = accordion.toggleRecipe('菜品/带空格 id', 2);
  assert.deepEqual(targets, []);
  await pending;
  assert.deepEqual(targets, [accordion.recipeAnchor(2)]);
  assert.deepEqual(accordion.anchors, []);
  accordion.stop();
});

test('separate recipe lists get distinct native-compatible IDs rather than IDs derived from recipe data', () => {
  const first = accordionHarness();
  const second = accordionHarness();
  assert.notEqual(first.recipeAnchor(0), second.recipeAnchor(0));
  assert.notEqual(first.recipeAnchor(0), first.recipeAnchor(1));
  assert.match(first.recipeAnchor(0), /^[a-z][a-z0-9-]+$/);
  first.stop();
  second.stop();
});

function templateNodes(path) {
  const source = readFileSync(new URL(`../src/${path}.vue`, import.meta.url), 'utf8');
  const nodes = [];
  function walk(node) { if (node.type === 1) { nodes.push(node); node.children.forEach(walk); } }
  baseParse(parse(source).descriptor.template.content).children.forEach(walk);
  return { source, nodes };
}
const binding = (node, name) => node.props.find(prop => prop.name === 'bind' && prop.arg?.content === name)?.exp.content;
const hasClass = (node, name) => node.props.some(prop => prop.name === 'class' && prop.value?.content.split(' ').includes(name));

test('menu, food and friend-shared set details all anchor the selected recipe row and preserve member metadata', () => {
  for (const path of ['components/SetSheet', 'components/CommunityView', 'pages/shared/index']) {
    const { source, nodes } = templateNodes(path);
    assert.match(source, /useRecipeAccordion/);
    const row = nodes.find(node => binding(node, 'id') === 'recipeAnchor(index)');
    assert.ok(row, path);
    assert.match(row.loc.source, /toggleRecipe\(recipe.id, index\)/);
    assert.match(row.loc.source, /:aria-expanded="expanded === recipe.id"/);
    assert.match(row.loc.source, /<RecipeListMeta :category="recipe.category" :minutes="recipe.minutes"/);
    assert.match(row.loc.source, /<RecipeContent v-if="expanded === recipe.id"/);
    if (path.startsWith('components/')) assert.ok(nodes.some(node => node.tag === 'FoodDetailSheet' && binding(node, 'scroll-anchor') === 'scrollAnchor'));
    else assert.match(source, /pageScrollTo\(\{ selector: `#\$\{anchor\}`, duration: 0 \}\)/);
  }
  const { nodes } = templateNodes('components/Sheet');
  const scroller = nodes.find(node => node.tag === 'scroll-view');
  assert.equal(binding(scroller, 'scroll-into-view'), 'scrollAnchor');
  assert.equal(binding(scroller, 'scroll-with-animation'), 'false');
  assert.equal(binding(scroller, 'scroll-top'), 'scrollTop');
});

test('food details show the real publisher below their cover and set headings do not repeat the count', () => {
  const community = templateNodes('components/CommunityView');
  const cover = community.nodes.find(node => node.tag === 'FoodDetailSheet');
  assert.equal(binding(cover, 'publisher'), 'communityPublisherName(current)');
  const detail = templateNodes('components/FoodDetailSheet');
  const detailCover = detail.nodes.find(node => node.tag === 'RecipeCover');
  const detailBody = detail.nodes.find(node => hasClass(node, 'food-detail-body'));
  const attribution = detail.nodes.find(node => hasClass(node, 'food-detail-attribution'));
  assert.ok(detailBody.children.includes(attribution));
  assert.ok(attribution.children.some(node => node.type === 1 && hasClass(node, 'food-detail-publisher')));
  assert.ok(detail.nodes.indexOf(detailCover) < detail.nodes.indexOf(detailBody));
  const coverTemplate = templateNodes('components/RecipeCover');
  assert.ok(!coverTemplate.nodes.some(node => hasClass(node, 'recipe-cover-publisher')));
  for (const path of ['components/SetSheet', 'components/CommunityView']) {
    const { nodes } = templateNodes(path);
    const heading = nodes.find(node => hasClass(node, 'section-line') && node.loc.source.includes('套餐搭配'));
    assert.ok(heading, path);
    assert.doesNotMatch(heading.loc.source, /道菜/);
  }
  const setCover = templateNodes('components/SetSheet').nodes.find(node => node.tag === 'FoodDetailSheet');
  assert.equal(setCover.props.find(prop => prop.type === 6 && prop.name === 'kind')?.value?.content, 'set');
  assert.equal(binding(setCover, 'dish-count'), 'recipes.length');
  assert.ok(coverTemplate.nodes.some(node => hasClass(node, 'recipe-cover-tag') && node.loc.source.includes('{{ dishCount }} 道菜')));
});
