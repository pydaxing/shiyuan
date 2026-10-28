import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@vue/compiler-sfc';
import { baseParse } from '@vue/compiler-dom';
import postcss from 'postcss';

const source = readFileSync(new URL('../src/components/CommunityView.vue', import.meta.url), 'utf8');
const stylesheet = postcss.parse(readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8'));
const nodes = [];
function walk(node) { if (node.type === 1) { nodes.push(node); node.children.forEach(walk); } }
baseParse(parse(source).descriptor.template.content).children.forEach(walk);
const hasClass = (node, name) => node.props.some(prop => prop.name === 'class' && prop.value?.content.split(' ').includes(name));
const findClass = name => nodes.find(node => hasClass(node, name));
const directive = (node, name, argument) => node.props.find(prop => prop.type === 7 && prop.name === name && (!argument || prop.arg?.content === argument))?.exp?.content;
function declarationsFor(selector) {
  const declarations = new Map();
  stylesheet.walkRules(rule => {
    if (rule.selectors.includes(selector)) rule.walkDecls(declaration => declarations.set(declaration.prop, declaration.value));
  });
  return declarations;
}

test('food cards keep category on the photo and place author and household count in the footer', () => {
  const cover = findClass('feed-cover');
  const category = findClass('feed-cover-category');
  const byline = findClass('feed-byline');
  assert.ok(cover.children.includes(category));
  const metric = findClass('feed-family-count');
  assert.ok(metric);
  assert.equal(directive(metric, 'bind', 'count'), 'entry.post.importedFamilyCount');
  assert.ok(metric.props.some(prop => prop.name === 'inline'));
  assert.ok(findClass('feed-meta').children.includes(metric));
  assert.doesNotMatch(cover.loc.source, /CommunityFamilyCount/);
  assert.ok(!cover.children.includes(byline));
  assert.ok(findClass('feed-meta').children.includes(byline));
  assert.equal(byline.tag, 'CommunityByline');
  assert.equal(directive(byline, 'bind', 'post'), 'entry.post');
  assert.equal(findClass('feed-cover-byline'), undefined);
  assert.equal(findClass('feed-cover-author'), undefined);
  assert.doesNotMatch(findClass('feed-summary').loc.source, /post\.recipes|feed-cover-category/);
  assert.equal(findClass('feed-bottom'), undefined);
});

test('cover labels distinguish dishes and sets and preserve their item counts', () => {
  const expression = findClass('feed-cover-category').children.find(node => node.type === 5).content.content;
  const label = new Function('entry', `return (${expression});`);
  assert.equal(label({ post: { kind: 'dish', recipes: [{ category: '主食' }] } }), '主食');
  assert.equal(label({ post: { kind: 'dish', recipes: [{}] } }), '其他');
  assert.equal(label({ post: { kind: 'menu', recipes: [{}, {}, {}] } }), '套餐 · 3 道菜');
});

test('food details explicitly opt into publisher attribution and a cover count', () => {
  const sheet = nodes.find(node => node.tag === 'FoodDetailSheet');
  assert.equal(directive(sheet, 'bind', 'image'), 'current.image');
  assert.equal(directive(sheet, 'bind', 'publisher'), 'communityPublisherName(current)');
  assert.equal(directive(sheet, 'bind', 'family-count'), 'current.importedFamilyCount');
  assert.ok(sheet.props.some(prop => prop.name === 'community'));
  assert.equal(findClass('community-detail-meta'), undefined);
  const detail = readFileSync(new URL('../src/components/FoodDetailSheet.vue', import.meta.url), 'utf8');
  assert.match(detail, /class="food-detail-attribution"[\s\S]*class="food-detail-publisher"/);
  assert.doesNotMatch(detail, /<CommunityFamilyCount|food-detail-meta-dot/);
  assert.match(detail.match(/<RecipeCover[^>]*>/)[0], /:family-count="coverFamilyCount"/);
});

test('detail metadata keeps a readable author row without duplicating the cover count', () => {
  const row = declarationsFor('.food-detail-attribution');
  assert.equal(row.get('display'), 'flex');
  assert.equal(row.get('align-items'), 'center');
  assert.equal(row.get('flex-wrap'), 'wrap');
  assert.equal(row.get('gap'), '4px 8px');
  assert.equal(row.get('margin-top'), '4px');
  const author = declarationsFor('.food-detail-publisher');
  assert.equal(author.get('min-width'), '0');
  assert.equal(author.get('overflow-wrap'), 'anywhere');
  assert.equal(author.has('margin-top'), false);
  const count = declarationsFor('.food-detail-attribution .community-cover-count');
  assert.equal(count.size, 0);
  assert.equal(declarationsFor('.food-detail-meta-dot').size, 0);
});

test('compact card copy keeps the full-width title above author and household statistics', () => {
  const body = findClass('feed-body');
  const elements = body.children.filter(node => node.type === 1);
  assert.deepEqual(elements.map(node => node.props.find(prop => prop.name === 'class').value.content), ['feed-heading', 'feed-meta']);
  assert.ok(findClass('feed-heading').children.includes(findClass('feed-title')));
  assert.doesNotMatch(body.loc.source, /家庭在做|feed-join/);
});

test('cards only open details and the confirmed join action moves beside the detail title', () => {
  const summary = findClass('feed-summary');
  const body = findClass('feed-body');
  const join = nodes.find(node => directive(node, 'on', 'click') === 'add(current)');
  assert.ok(summary.children.includes(body));
  assert.equal(findClass('feed-join'), undefined);
  assert.equal(findClass('feed-join-mark'), undefined);
  assert.doesNotMatch(summary.loc.source, /add\(|imported\(/);
  assert.equal(directive(findClass('feed-cover'), 'on', 'click'), 'open(entry.post)');
  assert.equal(directive(body, 'on', 'click'), 'open(entry.post)');
  assert.equal(directive(join, 'bind', 'disabled'), 'imported(current) || removingPost || addingPosts.includes(current.id)');
  assert.ok(nodes.some(node => node.props.some(prop => prop.name === 'slot' && prop.arg?.content === 'action') && node.children.includes(join)));
  assert.match(join.loc.source, /imported\(current\) \? '已加入' : addingPosts.includes\(current.id\) \? '加入中' : '加入菜单'/);
  assert.match(join.loc.source, /imported\(current\) \? 'check' : 'plus-inverse'/);
  assert.ok(!body.children.includes(join));
});

test('cover overlays remain legible without blocking image clicks or using costly blur', () => {
  for (const selector of ['.feed-cover-category', '.recipe-cover-meta', '.community-cover-count']) {
    const declarations = declarationsFor(selector);
    assert.equal(declarations.get('position'), 'absolute');
    assert.equal(declarations.get('pointer-events'), 'none');
    assert.equal(declarations.get('z-index'), '1');
    assert.ok(!declarations.has('backdrop-filter'));
  }
  assert.equal(declarationsFor('.feed-cover-category').get('top'), '8px');
  for (const selector of ['.feed-cover-category', '.recipe-cover-tag']) {
    assert.equal(declarationsFor(selector).get('background'), 'var(--photo-label-surface)');
    assert.equal(declarationsFor(selector).get('color'), 'var(--white)');
    assert.equal(declarationsFor(selector).get('border-radius'), '999px');
    assert.equal(declarationsFor(selector).get('border'), '0');
  }
});

test('compact card copy retains the full detail tap target and lazy waterfall images', () => {
  const summary = declarationsFor('.community-waterfall .feed-summary');
  assert.equal(summary.get('display'), 'flex');
  assert.equal(summary.get('position'), 'relative');
  assert.equal(summary.get('min-height'), 'var(--feed-copy-min-height)');
  assert.equal(declarationsFor('.app-shell').get('--feed-copy-min-height'), '60px');
  assert.equal(declarationsFor('.community-waterfall .feed-body').get('flex'), '1');
  assert.equal(declarationsFor('.community-waterfall .feed-body').get('min-width'), '0');
  assert.equal(declarationsFor('.community-waterfall .feed-body').get('min-height'), '44px');
  assert.equal(declarationsFor('.community-waterfall .feed-join').size, 0);
  assert.equal(declarationsFor('.feed-skeleton-copy').get('height'), summary.get('min-height'));
  assert.equal(declarationsFor('.feed-heading').get('min-height'), '0');
  assert.equal(declarationsFor('.feed-heading').get('padding-right'), '0');
  assert.match(findClass('feed-cover-media').loc.source, /<LazyImage[^>]*variant="card"/);
  assert.match(findClass('feed-cover').loc.source, /paddingTop: entry.coverPadding/);
  assert.ok(!declarationsFor('.community-waterfall .feed-card').has('height'));
});

test('full-width titles grow naturally while long authors yield space to the footer count', () => {
  const summary = declarationsFor('.community-waterfall .feed-summary');
  const footer = declarationsFor('.feed-meta');
  const count = declarationsFor('.feed-family-count');
  assert.equal(summary.get('align-items'), 'center');
  assert.equal(summary.has('height'), false);
  assert.equal(summary.get('padding'), '6px 8px 8px');
  assert.equal(footer.get('display'), 'flex');
  assert.equal(footer.get('align-items'), 'center');
  assert.equal(footer.get('gap'), '8px');
  assert.equal(footer.get('margin-top'), '4px');
  assert.equal(count.get('flex'), '0 0 auto');
  assert.equal(count.get('margin-left'), 'auto');
  assert.equal(declarationsFor('.feed-byline').get('flex'), '1');
  assert.equal(declarationsFor('.feed-byline').get('min-width'), '0');
  assert.ok(hasClass(findClass('feed-title'), 'food-list-title'));
  assert.equal(declarationsFor('.food-list-title').get('white-space'), 'nowrap');
  assert.equal(declarationsFor('.food-list-title').get('text-overflow'), 'ellipsis');
  assert.equal(declarationsFor('.community-byline-author').get('text-overflow'), 'ellipsis');
  assert.equal(declarationsFor('.community-byline-count').size, 0);
});

test('feed cards and skeletons use the same compact gutters and subtle rounded white surface', () => {
  const tokens = declarationsFor('.app-shell');
  assert.equal(tokens.get('--feed-gap'), '5px');
  assert.equal(tokens.get('--feed-cover-radius'), 'var(--radius-control)');
  assert.equal(tokens.get('--radius-control'), '6px');
  for (const selector of ['.community-waterfall', '.community-waterfall .waterfall-lane']) {
    assert.equal(declarationsFor(selector).get('gap'), 'var(--feed-gap)');
  }
  for (const selector of ['.community-waterfall .feed-card', '.feed-skeleton-card']) {
    assert.equal(declarationsFor(selector).get('border'), '0');
    assert.equal(declarationsFor(selector).get('border-radius'), 'var(--feed-cover-radius)');
    assert.equal(declarationsFor(selector).get('background'), 'var(--white)');
  }
  for (const selector of ['.community-waterfall .feed-cover', '.feed-skeleton-cover']) {
    assert.equal(declarationsFor(selector).get('border-radius'), 'var(--feed-cover-radius)');
  }
  assert.equal(declarationsFor('.community-waterfall .feed-card').get('box-shadow'), 'none');
});

test('only mobile feed cards use five-pixel gutters while the toolbar and other pages retain eight', () => {
  assert.equal(declarationsFor('.app-shell').get('--page-gutter'), '8px');
  assert.equal(declarationsFor('.app-shell').get('--feed-page-gutter'), '5px');
  for (const property of ['margin-left', 'margin-right']) {
    assert.equal(declarationsFor('.community-view').get(property), 'calc(var(--feed-page-gutter) - var(--page-gutter))');
  }
  for (const property of ['padding-left', 'padding-right']) {
    assert.equal(declarationsFor('.community-sticky-frame').get(property), 'var(--page-gutter)');
  }
  assert.equal(declarationsFor('.community-view').get('--community-toolbar-height'), '50px');
  assert.equal(declarationsFor('.community-feed-content').get('padding-top'), 'var(--community-toolbar-height)');
  for (const selector of ['.sheet', '.entry-page']) {
    assert.equal(declarationsFor(selector).get('--page-gutter'), undefined);
  }
  assert.equal(declarationsFor('.order-card').get('margin-bottom'), '12px');
  assert.equal(declarationsFor('.order-card').get('padding'), 'var(--panel-padding)');
  assert.equal(declarationsFor('.feature-panel.family-preferences').get('margin-top'), '16px');
});

test('food cards and detail covers align category labels at top right and keep authors off the photo', () => {
  for (const [selector, inset] of [['.feed-cover-category', '8px'], ['.recipe-cover-meta', '12px']]) {
    const declarations = declarationsFor(selector);
    assert.equal(declarations.get('top'), inset, selector);
    assert.equal(declarations.get('right'), inset, selector);
    assert.equal(declarations.get('bottom'), undefined, selector);
    assert.equal(declarations.get('pointer-events'), 'none', selector);
    assert.equal(declarations.get('z-index'), '1', selector);
  }
  assert.equal(declarationsFor('.feed-cover-byline').size, 0);
  assert.equal(declarationsFor('.recipe-cover-publisher').size, 0);
  assert.equal(declarationsFor('.recipe-cover-tags').get('flex-wrap'), 'wrap');
  assert.equal(declarationsFor('.recipe-cover-tags').get('flex-direction'), 'row-reverse');
  assert.equal(declarationsFor('.feed-cover-category').get('left'), undefined);
  assert.equal(declarationsFor('.community-byline-author').get('text-overflow'), 'ellipsis');
  assert.equal(declarationsFor('.community-byline-author').get('min-width'), '0');
  assert.equal(declarationsFor('.community-byline-author').get('background'), undefined);
  assert.equal(declarationsFor('.community-byline-author').get('border'), undefined);
  assert.equal(declarationsFor('.community-byline.is-expanded .community-byline-author').get('white-space'), 'normal');
  assert.equal(declarationsFor('.community-byline.is-expanded .community-byline-author').get('overflow-wrap'), 'anywhere');
  assert.equal(declarationsFor('.community-byline-count').size, 0);
  assert.equal(declarationsFor('.feed-byline').get('display'), 'block');
  assert.equal(declarationsFor('.feed-byline').get('width'), '0');
  assert.equal(declarationsFor('.food-detail-publisher').get('overflow-wrap'), 'anywhere');
});

test('card and detail badges share their visual rules while retaining their respective density', () => {
  for (const selectors of [['.feed-cover-category', '.recipe-cover-tag'], ['.recipe-cover-tag', '.recipe-cover-meta .community-cover-count']]) {
    const [card, detail] = selectors.map(declarationsFor);
    for (const property of ['background', 'color', 'border-radius', 'font-family', 'font-weight']) {
      assert.ok(card.has(property), `${selectors[0]} ${property}`);
      assert.equal(card.get(property), detail.get(property), property);
      const sharedRule = stylesheet.nodes.find(rule => rule.type === 'rule' && selectors.every(selector => rule.selectors.includes(selector)) && rule.nodes.some(declaration => declaration.prop === property));
      assert.ok(sharedRule, `${property} must have one shared owner`);
    }
  }
  assert.equal(declarationsFor('.recipe-cover-tag').get('box-shadow'), undefined);
  assert.equal(declarationsFor('.feed-cover-category').get('font-size'), 'var(--type-caption)');
  assert.equal(declarationsFor('.recipe-cover-tag').get('font-size'), 'var(--type-caption)');
});

test('translucent charcoal category labels keep readable white text over both light and dark photos', () => {
  const tokens = declarationsFor('.app-shell');
  const [red, green, blue, alpha] = tokens.get('--photo-label-surface').match(/[\d.]+/g).map(Number);
  const ink = tokens.get('--white').slice(1).match(/.{2}/g).map(channel => Number.parseInt(channel, 16));
  const luminance = channels => channels.map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
  assert.ok(alpha > 0 && alpha < 1);
  for (const photo of [0, 255]) {
    const background = [red, green, blue].map(channel => channel * alpha + photo * (1 - alpha));
    assert.ok((luminance(ink) + .05) / (luminance(background) + .05) >= 4.5);
  }
});

test('optional cover counts stay hidden unless explicitly supplied and do not block photo clicks', () => {
  const metric = declarationsFor('.community-cover-count');
  assert.equal(metric.get('right'), 'var(--cover-meta-inset, 8px)');
  assert.equal(metric.get('bottom'), 'var(--cover-meta-inset, 8px)');
  assert.equal(metric.get('top'), undefined);
  assert.equal(metric.get('background'), 'none');
  assert.equal(metric.get('border'), '0');
  assert.equal(metric.get('padding'), '0');
  assert.equal(metric.get('color'), 'var(--white)');
  assert.equal(metric.get('pointer-events'), 'none');
  assert.equal(metric.get('box-shadow'), undefined);
  assert.equal(metric.get('backdrop-filter'), undefined);
  assert.ok(declarationsFor('.community-cover-count-value').get('text-shadow'));
  const cover = nodes.find(node => node.tag === 'FoodDetailSheet');
  assert.equal(directive(cover, 'bind', 'family-count'), 'current.importedFamilyCount');
  const wrapper = readFileSync(new URL('../src/components/FoodDetailSheet.vue', import.meta.url), 'utf8');
  assert.match(wrapper.match(/<RecipeCover[^>]*>/)[0], /:family-count="coverFamilyCount"/);
  const detailSource = readFileSync(new URL('../src/components/RecipeCover.vue', import.meta.url), 'utf8');
  assert.match(detailSource, /<CommunityFamilyCount :count="familyCount"/);
  assert.match(detailSource, /familyCount: \{ type: Number, default: null \}/);
  assert.match(detailSource, /--cover-meta-inset: 12px/);
  assert.match(detailSource, /name="clock-inverse"/);
});

test('feed card counts retain their muted inline appearance', () => {
  const count = declarationsFor('.community-cover-count.is-inline');
  assert.equal(count.get('position'), 'static');
  assert.equal(count.get('z-index'), 'auto');
  assert.equal(count.get('max-width'), 'none');
  assert.equal(count.get('color'), 'var(--muted)');
  assert.equal(count.get('font-size'), 'var(--type-caption)');
  assert.equal(count.get('font-weight'), '400');
  assert.equal(declarationsFor('.community-cover-count.is-inline .community-cover-count-value').get('text-shadow'), 'none');
  assert.equal(declarationsFor('.community-cover-count').get('background'), 'none');
  assert.equal(declarationsFor('.community-cover-count').get('border'), '0');
});

test('detail cover puts unlabelled counts to the right of category tags without overlapping them', () => {
  const cover = readFileSync(new URL('../src/components/RecipeCover.vue', import.meta.url), 'utf8');
  const coverNodes = [];
  const collect = node => { if (node.type === 1) { coverNodes.push(node); node.children.forEach(collect); } };
  baseParse(parse(cover).descriptor.template.content).children.forEach(collect);
  const row = coverNodes.find(node => hasClass(node, 'recipe-cover-meta'));
  const category = coverNodes.find(node => hasClass(node, 'recipe-cover-tags'));
  const counter = coverNodes.find(node => node.tag === 'CommunityFamilyCount');
  assert.ok(row.children.includes(category));
  assert.ok(row.children.includes(counter));
  assert.equal(directive(counter, 'bind', 'count'), 'familyCount');
  assert.ok(!counter.props.some(prop => ['inline', 'labelled'].includes(prop.name)));
  assert.equal(declarationsFor('.recipe-cover-meta').get('display'), 'flex');
  assert.equal(declarationsFor('.recipe-cover-meta').get('align-items'), 'flex-end');
  assert.equal(declarationsFor('.recipe-cover-tags').get('flex'), '1');
  assert.equal(declarationsFor('.recipe-cover-tags').get('min-width'), '0');
  const count = declarationsFor('.recipe-cover-meta .community-cover-count');
  assert.equal(count.get('position'), 'static');
  assert.equal(count.get('margin-left'), 'auto');
  assert.equal(count.get('max-width'), 'none');
  assert.equal(count.get('flex'), '0 0 auto');
  for (const property of ['background', 'border-radius', 'color', 'min-height', 'padding', 'font-size', 'line-height']) assert.equal(count.get(property), declarationsFor('.recipe-cover-tag').get(property), property);
  assert.equal(declarationsFor('.recipe-cover-meta .community-cover-count-value').get('text-shadow'), 'none');
});
