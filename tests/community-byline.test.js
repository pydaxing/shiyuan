import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@vue/compiler-sfc';
import { compile } from '@vue/compiler-dom';
import * as Vue from 'vue';
import { communityPublisherName } from '../src/domain/community-policy.js';

const source = readFileSync(new URL('../src/components/CommunityByline.vue', import.meta.url), 'utf8');
const descriptor = parse(source).descriptor;
const setupSource = descriptor.scriptSetup.content.replace(/^import .*;\n/gm, '').replace(/^const props = defineProps\(.*\);\n/m, '');
const setup = new Function('props', 'computed', 'communityPublisherName', `${setupSource}\nreturn { publisher };`);
const render = new Function('Vue', compile(descriptor.template.content, { mode: 'function' }).code)({ ...Vue, resolveComponent: name => name });
const countSource = readFileSync(new URL('../src/components/CommunityFamilyCount.vue', import.meta.url), 'utf8');
const countDescriptor = parse(countSource).descriptor;
const countSetupSource = countDescriptor.scriptSetup.content.replace(/^import .*;\n/gm, '').replace(/^const props = defineProps\(.*\);\n/m, '');
const countSetup = new Function('props', 'computed', `${countSetupSource}\nreturn { familyCount };`);
const countRender = new Function('Vue', compile(countDescriptor.template.content, { mode: 'function' }).code)({ ...Vue, resolveComponent: name => name });
function byline(post, expanded = false) {
  const props = Vue.reactive({ post, expanded });
  const bindings = setup(props, Vue.computed, communityPublisherName);
  return { props, bindings, render: () => render(Vue.proxyRefs({ ...bindings, expanded: Vue.computed(() => props.expanded) }), []) };
}
function coverCount(count, inline = false, labelled = false) {
  const props = Vue.reactive({ count, inline, labelled });
  const bindings = countSetup(props, Vue.computed);
  return { props, bindings, render: () => countRender(Vue.proxyRefs({ ...bindings, inline: Vue.computed(() => props.inline), labelled: Vue.computed(() => props.labelled) }), []) };
}
function findClass(node, name) {
  if (!node || typeof node !== 'object') return undefined;
  if (node.props?.class?.split(' ').includes(name)) return node;
  return Array.isArray(node.children) ? node.children.map(child => findClass(child, name)).find(Boolean) : undefined;
}

test('card and expanded bylines preserve the same full original author without a photo badge', () => {
  const publisher = '苏格兰人的吉普赛媳妇';
  const post = { publisherType: 'official', author: '平台账号', importedFamilyCount: 2, recipes: [{ provenance: { attribution: publisher } }] };
  for (const expanded of [false, true]) {
    const instance = byline(post, expanded);
    const node = instance.render();
    assert.equal(findClass(node, 'community-byline-author').children, publisher);
    assert.equal(findClass(node, 'community-byline-author').props['aria-label'], `发布者：${publisher}`);
    assert.equal(node.props.class.includes('is-expanded'), expanded);
    assert.equal(findClass(node, 'community-cover-count'), undefined);
    assert.equal(findClass(node, 'community-byline-count'), undefined);
  }
});

test('photo household counts show a white cooking icon and number with a complete accessible label', () => {
  for (const count of [0, 1, 2, 12345]) {
    const node = coverCount(count).render();
    const metric = findClass(node, 'community-cover-count');
    assert.equal(metric.props['aria-label'], `${count} 个家庭在做`);
    const icon = metric.children.find(child => child.type === 'AppIcon');
    assert.equal(icon.props.name, 'menu-photo');
    assert.equal(icon.props.size, 14);
    assert.ok(readFileSync(new URL(`../src/static/icon-${icon.props.name}.png`, import.meta.url)).length > 0);
    assert.equal(metric.children.find(child => child.type === 'text').children, String(count));
  }
});

test('card footer counts use the original muted cooking icon without photo shadow styling', () => {
  for (const count of [0, 1, 2, 12345]) {
    const metric = findClass(coverCount(count, true).render(), 'community-cover-count');
    assert.ok(metric.props.class.includes('is-inline'));
    assert.equal(metric.props['aria-label'], `${count} 个家庭在做`);
    const icon = metric.children.find(child => child.type === 'AppIcon');
    assert.equal(icon.props.name, 'menu');
    assert.equal(icon.props.size, 14);
    assert.equal(metric.children.find(child => child.type === 'text').children, String(count));
  }
  const metric = coverCount(2);
  assert.equal(metric.render().props.class.includes('is-inline'), false);
  metric.props.inline = true;
  assert.ok(metric.render().props.class.includes('is-inline'));
  assert.equal(metric.render().children.find(child => child.type === 'AppIcon').props.name, 'menu');
});

test('missing or invalid household statistics are hidden instead of fabricated as zero', () => {
  for (const count of [undefined, null, -1, 1.5, '2', NaN, Infinity]) {
    const instance = coverCount(count);
    assert.equal(instance.bindings.familyCount.value, null);
    assert.equal(instance.render().type, Vue.Comment);
    assert.equal(coverCount(count, true).render().type, Vue.Comment);
    assert.equal(findClass(byline({ author: '真实作者', importedFamilyCount: count }).render(), 'community-byline-author').children, '真实作者');
  }
});

test('detail counts can include the household unit without changing compact feed counts', () => {
  const metric = coverCount(2, true, true);
  assert.equal(findClass(metric.render(), 'community-cover-count-value').children, '2 家庭');
  metric.props.labelled = false;
  assert.equal(findClass(metric.render(), 'community-cover-count-value').children, '2');
});

test('empty authors leave no byline while known photo counts can appear independently', () => {
  for (const author of [undefined, '', '   ']) {
    assert.equal(byline({ author }).render().type, Vue.Comment);
    assert.equal(byline({ author, importedFamilyCount: 0 }).render().type, Vue.Comment);
    assert.ok(findClass(coverCount(0).render(), 'community-cover-count'));
  }
});

test('authors and photo counts update without fetching or mutating post data', () => {
  const instance = byline({ author: '首屏作者' });
  const metric = coverCount(instance.props.post.importedFamilyCount);
  assert.equal(metric.render().type, Vue.Comment);
  instance.props.post = { author: '完整详情作者', importedFamilyCount: 3 };
  instance.props.expanded = true;
  metric.props.count = instance.props.post.importedFamilyCount;
  const node = instance.render();
  assert.equal(findClass(node, 'community-byline-author').children, '完整详情作者');
  assert.equal(findClass(metric.render(), 'community-cover-count').props['aria-label'], '3 个家庭在做');
  assert.deepEqual(instance.props.post, { author: '完整详情作者', importedFamilyCount: 3 });
  assert.doesNotMatch(source, /fetch\(|invokeCloud|watch\(|onMounted|\.slice\(|\.substring\(/);
  assert.doesNotMatch(countSource, /fetch\(|invokeCloud|watch\(|onMounted|@click|@tap|<button/);
  metric.props.count = undefined;
  assert.equal(metric.render().type, Vue.Comment);
});

test('photo count icon keeps a transparent canvas and a light glyph with its own shadow', async () => {
  const sharp = (await import('sharp')).default;
  const { data, info } = await sharp(readFileSync(new URL('../src/static/icon-menu-photo.png', import.meta.url))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 4);
  for (const offset of [0, (info.width - 1) * 4, (info.width * (info.height - 1)) * 4, (info.width * info.height - 1) * 4]) assert.equal(data[offset + 3], 0);
  let whitePixels = 0;
  let shadowPixels = 0;
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] > 220 && data[offset] > 245 && data[offset + 1] > 245 && data[offset + 2] > 245) whitePixels += 1;
    if (data[offset + 3] > 40 && data[offset + 3] < 200 && data[offset] < 70) shadowPixels += 1;
  }
  assert.ok(whitePixels > 100);
  assert.ok(shadowPixels > 100);
});
