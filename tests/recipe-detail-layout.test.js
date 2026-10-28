import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@vue/compiler-sfc';
import { baseParse } from '@vue/compiler-dom';
import { recipeStepTitle } from '../src/domain/presentation.js';

const source = readFileSync(new URL('../src/components/RecipeContent.vue', import.meta.url), 'utf8');
const nodes = [];
function walk(node) { if (node.type === 1) { nodes.push(node); node.children.forEach(walk); } }
baseParse(parse(source).descriptor.template.content).children.forEach(walk);
const hasClass = (node, name) => node.props.some(prop => prop.name === 'class' && prop.value?.content.split(' ').includes(name));

test('recipe details read continuously from cover to ingredients to method without a second disclosure', () => {
  const root = nodes.find(node => hasClass(node, 'recipe-content'));
  const content = root.children.filter(node => node.type === 1);
  const cover = content.findIndex(node => node.tag === 'RecipeCover');
  const ingredients = content.findIndex(node => hasClass(node, 'recipe-ingredients-section'));
  const method = content.findIndex(node => hasClass(node, 'recipe-method'));
  assert.ok(cover >= 0 && ingredients > cover && method > ingredients);
  assert.ok(!content[ingredients].props.some(prop => prop.name === 'if'));
  const methodBody = nodes.find(node => hasClass(node, 'recipe-method-body'));
  assert.ok(!methodBody.props.some(prop => prop.name === 'if'));
  assert.doesNotMatch(source, /methodOpen|recipe-method-toggle|标准用量/);
  assert.match(methodBody.loc.source, /variant="detail"/);
  assert.match(content[ingredients].loc.source, /formatAmount\(ingredient.quantity, ingredient.unit, ingredient.amountText\)/);
});

test('every step photo preserves the whole image, including multi-photo steps', () => {
  const photos = nodes.find(node => hasClass(node, 'recipe-step-photos'));
  const image = nodes.find(node => hasClass(node, 'step-image'));
  assert.equal(image.props.find(prop => prop.name === 'mode')?.value?.content, 'widthFix');
  assert.equal(image.props.find(prop => prop.name === 'variant')?.value?.content, 'detail');
  assert.match(photos.loc.source, /@click="preview\(step, image\)"/);
  assert.doesNotMatch(photos.loc.source, /aspectFill|multiple|:mode=/);
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.recipe-step-photos \{ display: flex; flex-direction: column; gap: 12px;/);
  assert.doesNotMatch(css, /\.recipe-step-photos\.multiple/);
});

test('ingredient and method counts share heading typography and a middle dot separator', () => {
  const headings = nodes.filter(node => hasClass(node, 'recipe-section-heading'));
  assert.equal(headings.length, 2);
  for (const heading of headings) {
    const labels = heading.children.filter(node => node.type === 1);
    assert.equal(labels.length, 1);
    assert.equal(labels[0].tag, 'text');
    assert.ok(hasClass(labels[0], 'subheading'));
    assert.ok(!hasClass(labels[0], 'muted'));
  }
  assert.match(headings[0].loc.source, /食材 · {{ recipe.ingredients.length }} 种/);
  const methodCount = headings[1].children[0].children.find(node => node.type === 5);
  assert.equal(methodCount.content.content, "recipe.steps.length ? ' · ' + recipe.steps.length + ' 步' : ''");
  assert.ok(nodes.some(node => hasClass(node, 'recipe-method-empty')));
});

test('reader hides generic imported step headings without removing meaningful titles or changing saved data', () => {
  for (const title of ['', undefined, '步骤 1', '步骤14', '步骤一', '第 2 步', '第一步', 'Step 01', '03', ' 步骤 3： ']) {
    const step = { title, text: '揉成光滑的面团。', images: ['/static/tofu.png'] };
    const original = structuredClone(step);
    assert.equal(recipeStepTitle(step), '');
    assert.deepEqual(step, original);
  }
  for (const title of ['准备食材', '发酵 40 分钟', '步骤1：揉面', '第二步发酵', '  冷藏后切片  ']) assert.equal(recipeStepTitle({ title }), title.trim());
  const title = nodes.find(node => hasClass(node, 'step-title'));
  assert.equal(title.props.find(prop => prop.name === 'if').exp.content, 'recipeStepTitle(step)');
  const stepLead = nodes.find(node => hasClass(node, 'recipe-step-lead'));
  assert.match(stepLead.loc.source, /step-number/);
  assert.match(stepLead.loc.source, /step-body/);
  assert.ok(nodes.some(node => hasClass(node, 'recipe-method-empty') && node.props.some(prop => prop.name === 'if' && prop.exp.content === '!recipe.steps.length')));
});

test('food, home and friend-shared details reuse cover tags and the continuous ingredient and method layout', () => {
  const community = readFileSync(new URL('../src/components/CommunityView.vue', import.meta.url), 'utf8');
  assert.match(community, /<RecipeContent v-if="current.kind === 'dish'" :recipe="current.recipes\[0\]" :cover="false" :show-meta="false"/);
  assert.match(community, /<FoodDetailSheet/);
  assert.match(readFileSync(new URL('../src/components/FoodDetailSheet.vue', import.meta.url), 'utf8'), /<RecipeCover[^>]*immersive/);
  assert.match(community, /<FoodDetailSheet[^>]*:publisher="communityPublisherName\(current\)"/);
  const byline = readFileSync(new URL('../src/components/CommunityByline.vue', import.meta.url), 'utf8');
  assert.match(byline, /communityPublisherName\(props.post\)/);
  const cover = readFileSync(new URL('../src/components/RecipeCover.vue', import.meta.url), 'utf8');
  assert.match(cover, /variant="detail"/);
  assert.match(cover, /@click="previewImages\(/);
  assert.match(cover, /class="recipe-cover-tags"/);
  for (const path of ['components/RecipeSheet.vue', 'pages/shared/index.vue']) assert.match(readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8'), /<RecipeContent/);
  const forward = readFileSync(new URL('../src/components/FriendForwardButton.vue', import.meta.url), 'utf8');
  assert.match(forward, /NativeShareButton/);
  assert.doesNotMatch(forward, /action-icon-circle/);
  assert.match(forward, /name="share"/);
  assert.match(forward, /<text>分享<\/text>/);
  assert.doesNotMatch(forward, /发给好友/);
});
