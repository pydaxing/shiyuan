import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@vue/compiler-sfc';
import postcss from 'postcss';
import { COVER_RATIOS, coverFrameStyle } from '../src/domain/image-crop.js';

const readSource = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
const styles = postcss.parse(readSource('styles.css'));

function componentStyles(name) {
  return postcss.parse(parse(readSource(`components/${name}.vue`)).descriptor.styles.map(style => style.content).join('\n'));
}

function declarationsFor(selector, source = styles) {
  const declarations = new Map();
  source.walkRules(rule => {
    if (rule.selectors.includes(selector)) rule.walkDecls(declaration => declarations.set(declaration.prop, declaration.value));
  });
  return declarations;
}

test('dish and set list photos share the cover ratio through one thumbnail component', () => {
  const source = readSource('components/FoodThumbnail.vue');
  assert.equal(declarationsFor('page').get('--food-photo-radius'), 'var(--radius-small)');
  assert.equal(declarationsFor('page').get('--radius-small'), '4px');
  const thumbnail = declarationsFor('.food-thumbnail', componentStyles('FoodThumbnail'));
  assert.equal(thumbnail.get('border-radius'), 'var(--food-photo-radius)');
  assert.equal(thumbnail.get('width'), 'var(--food-thumbnail-width)');
  assert.equal(thumbnail.get('flex'), '0 0 var(--food-thumbnail-width)');
  assert.equal(thumbnail.get('height'), undefined);
  assert.equal(thumbnail.get('overflow'), 'hidden');
  assert.match(source, /:style="coverFrameStyle\('recipe'\)"/);
  assert.match(source, /variant="card" mode="aspectFill" thumbnail/);
  assert.doesNotMatch(source, /fill: Boolean|aspectFit/);
  assert.doesNotMatch(source, /variant="original"|aspect-ratio:/);
  for (const width of [60, 80, 84, 88, 96, 112]) {
    const height = width * Number.parseFloat(coverFrameStyle('recipe').paddingTop) / 100;
    assert.ok(Math.abs(width / height - COVER_RATIOS.recipe) < .00001);
  }
  for (const component of ['MenuSwipeRow', 'MealDishList', 'SetSheet', 'CommunityView', 'SetEditor', 'ShareSheet', 'AddDishesSheet', 'CookingDiary']) {
    assert.match(readSource(`components/${component}.vue`), /<FoodThumbnail\b/, component);
  }
  assert.match(readSource('pages/shared/index.vue'), /<FoodThumbnail\b/);
  const home = declarationsFor('.home-menu-photo', componentStyles('MenuSwipeRow'));
  assert.equal(home.get('--food-thumbnail-width'), 'var(--food-photo-width)');
  assert.equal(home.get('height'), undefined);
  assert.equal(home.get('min-height'), '44px');
  for (const selector of ['.meal-dish-photo', '.recipe-expand > image', '.set-pick-row > image', '.shared-recipe-thumb', '.share-preview-cover', '.checkout-dishes .meal-dish-photo']) {
    assert.equal(declarationsFor(selector).get('height'), undefined, selector);
  }
});

test('all food lists fill golden cover frames without page-specific opt-ins', () => {
  for (const component of ['MenuSwipeRow', 'MealDishList', 'SetSheet', 'CommunityView', 'SetEditor', 'ShareSheet', 'AddDishesSheet', 'CookingDiary']) {
    assert.doesNotMatch(readSource(`components/${component}.vue`), /<FoodThumbnail\b[^>]*\bfill\b/, component);
  }
  assert.doesNotMatch(readSource('pages/shared/index.vue'), /<FoodThumbnail\b[^>]*\bfill\b/);
});

test('food thumbnail loading, loaded, and failed states clip inside the image component', () => {
  const photoStyles = componentStyles('LazyImage');
  for (const selector of ['.thumbnail-photo', '.thumbnail-photo .lazy-photo-image', '.thumbnail-photo .lazy-photo-placeholder', '.thumbnail-photo .lazy-photo-retry']) {
    assert.equal(declarationsFor(selector, photoStyles).get('border-radius'), 'var(--food-photo-radius)', selector);
  }
  assert.match(readSource('components/LazyImage.vue'), /'thumbnail-photo': thumbnail/);
  const source = readSource('components/FoodThumbnail.vue');
  assert.match(source, /<LazyImage[^>]*\bthumbnail\s*\/>/);
  assert.doesNotMatch(source, /<LazyImage[^>]*\bround\b/);
  assert.equal(declarationsFor('.food-thumbnail-image', componentStyles('FoodThumbnail')).get('position'), 'absolute');
});

test('menu photos inherit kitchen thumbnail corners while tags and swipe actions stay rectangular', () => {
  const menuStyles = componentStyles('MenuSwipeRow');
  assert.equal(declarationsFor('.menu-swipe', menuStyles).get('--food-photo-radius'), undefined);
  for (const selector of ['.menu-swipe-surface', '.menu-swipe-actions', '.home-menu-item-category', '.menu-swipe-edit', '.menu-swipe-delete']) {
    assert.equal(declarationsFor(selector, menuStyles).get('border-radius'), '0', selector);
  }
  assert.equal(declarationsFor('.home-menu-photo', menuStyles).get('border-radius'), 'var(--food-photo-radius)');
  assert.equal(declarationsFor('page').get('--food-photo-radius'), 'var(--radius-small)');
  assert.equal(declarationsFor('page').get('--radius-small'), '4px');
  for (const selector of ['.home-menu-pick', '.home-menu-pick-mark']) {
    assert.equal(declarationsFor(selector, menuStyles).get('border-radius'), '50%', selector);
  }
});

test('member and author avatars stay round while food thumbnails use landscape frames', () => {
  for (const selector of ['.profile-avatar', '.avatar', '.member-photo', '.author-dot']) {
    assert.equal(declarationsFor(selector).get('border-radius'), '50%', selector);
  }
  const photoStyles = componentStyles('LazyImage');
  for (const selector of ['.round-photo', '.round-photo .lazy-photo-image', '.round-photo .lazy-photo-placeholder', '.round-photo .lazy-photo-retry']) {
    assert.equal(declarationsFor(selector, photoStyles).get('border-radius'), '50%', selector);
  }
  assert.match(readSource('components/FamilyView.vue'), /<LazyImage class="member-avatar-image" :src="member.avatar" variant="card" avatar round\s*\/>/);
});

test('flexible recipe text cannot stretch golden-ratio thumbnails in selection and detail lists', () => {
  assert.equal(declarationsFor('.recipe-expand > view').get('flex'), undefined);
  assert.equal(declarationsFor('.set-pick-row > view').get('flex'), undefined);
  for (const selector of ['.recipe-list-copy', '.set-pick-copy', '.share-pick-copy']) {
    assert.equal(declarationsFor(selector).get('flex'), '1');
    assert.equal(declarationsFor(selector).get('min-width'), '0');
  }
});

test('menu and food card names use compact sizes without changing section or detail titles', () => {
  assert.equal(declarationsFor('.home-menu-title', componentStyles('MenuSwipeRow')).get('font-size'), 'var(--type-list)');
  assert.equal(declarationsFor('.home-menu-group-heading', componentStyles('HomeMenu')).get('font-size'), 'var(--type-control)');
  assert.equal(declarationsFor('.community-waterfall .feed-title').get('font-size'), 'var(--type-list)');
  assert.equal(declarationsFor('.recipe-expand .stock-name').get('font-size'), 'var(--type-list)');
});

test('home dish and set names align with the photo top while selection buttons stay centered', () => {
  const rowStyles = componentStyles('MenuSwipeRow');
  const row = declarationsFor('.home-menu-row', rowStyles);
  const info = declarationsFor('.home-menu-info', rowStyles);
  assert.equal(row.get('align-items'), 'flex-start');
  assert.equal(row.get('padding'), 'var(--food-row-padding) 0');
  assert.equal(row.get('min-height'), 'var(--food-row-height)');
  assert.equal(info.get('justify-content'), 'flex-start');
  assert.equal(info.get('padding'), '0');
  assert.equal(info.get('min-height'), 'var(--food-row-content-height)');
  assert.equal(declarationsFor('.home-menu-row-body', rowStyles).get('align-items'), 'center');
  assert.equal(declarationsFor('.home-menu-pick', rowStyles).get('height'), '44px');
  assert.equal(declarationsFor('.home-menu-title', rowStyles).has('-webkit-line-clamp'), false);
  assert.equal(declarationsFor('.food-list-title').get('white-space'), 'nowrap');
});
