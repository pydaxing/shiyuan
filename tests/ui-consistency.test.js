import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import postcss from 'postcss';
import { NATIVE_UI_COLORS } from '../src/domain/ui-theme.js';

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const stylesheet = postcss.parse(source('src/styles.css'));
const home = postcss.parse(source('src/components/MenuSwipeRow.vue').match(/<style scoped>([\s\S]*?)<\/style>/)[1]);

function declarationsFor(selector, sheet = stylesheet) {
  const declarations = new Map();
  sheet.walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    rule.walkDecls((declaration) => declarations.set(declaration.prop, declaration.value));
  });
  return declarations;
}

test('native confirmations and generated icons share the application color tokens', () => {
  const tokens = declarationsFor('.app-shell');
  assert.equal(NATIVE_UI_COLORS.primary, tokens.get('--green'));
  assert.equal(NATIVE_UI_COLORS.muted, tokens.get('--muted'));
  assert.equal(NATIVE_UI_COLORS.danger, tokens.get('--danger'));
  assert.match(source('scripts/build-ui-art.mjs'), /NATIVE_UI_COLORS\.primary/);
  assert.match(source('scripts/build-ui-art.mjs'), /NATIVE_UI_COLORS\.muted/);
});

test('all notification count badges share readable red and white without changing semantic status colors', () => {
  for (const root of [':root', 'page', '.app-shell']) assert.equal(declarationsFor(root).get('--notification'), '#e02e2e');
  const badge = declarationsFor('.nav-count');
  assert.equal(badge.get('background'), 'var(--notification)');
  assert.equal(badge.get('color'), 'var(--white)');
  assert.equal(declarationsFor('.app-shell').get('--warning'), '#8c6b39');
  assert.equal(declarationsFor('.app-shell').get('--danger'), '#9a5145');
  const prepSource = source('src/components/MealPreparationSheet.vue');
  const prepStyles = postcss.parse(prepSource.match(/<style scoped>([\s\S]*?)<\/style>/)[1]);
  assert.match(prepSource, /class="prep-cart-count nav-count"/);
  assert.equal(declarationsFor('.prep-cart-count', prepStyles).get('background'), undefined);
  assert.equal(declarationsFor('.prep-cart-count', prepStyles).get('color'), undefined);
  assert.equal((source('src/pages/index/index.vue').match(/class="nav-count"/g) || []).length, 2);
  assert.match(source('DESIGN.md'), /notification: "#e02e2e"/);
  const channels = declarationsFor('.app-shell').get('--notification').slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  const luminance = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  assert.ok(1.05 / (luminance + .05) >= 4.5, 'small white badge numbers remain readable');
});

test('notification badges stay circular instead of growing with padding or line height', () => {
  const badge = declarationsFor('.nav-count');
  assert.equal(badge.get('--count-size'), '20px');
  assert.equal(badge.get('width'), 'var(--count-size)');
  assert.equal(badge.get('height'), 'var(--count-size)');
  assert.equal(badge.get('box-sizing'), 'border-box');
  assert.equal(badge.get('padding'), '0');
  assert.equal(badge.get('border-radius'), '50%');
  assert.equal(badge.get('display'), 'inline-flex');
  assert.equal(badge.get('align-items'), 'center');
  assert.equal(badge.get('justify-content'), 'center');
  assert.equal(badge.get('line-height'), '1');
  assert.equal(declarationsFor('.nav-count.is-overflow').get('--count-size'), '26px');
  const prepStyles = postcss.parse(source('src/components/MealPreparationSheet.vue').match(/<style scoped>([\s\S]*?)<\/style>/)[1]);
  for (const property of ['width', 'height', 'min-width', 'padding', 'line-height', 'border-radius']) {
    assert.equal(declarationsFor('.prep-cart-count', prepStyles).get(property), undefined, `prep shares the badge ${property}`);
  }
});

test('menu and community share the type system but retain their distinct list and waterfall layouts', () => {
  assert.equal(declarationsFor('.home-menu-title', home).get('font-family'), 'var(--font-display)');
  assert.equal(declarationsFor('.community-waterfall .feed-title').get('font-family'), 'var(--font-display)');
  assert.equal(declarationsFor('.home-menu-title', home).get('font-size'), 'var(--type-list)');
  assert.equal(declarationsFor('.community-waterfall .feed-title').get('font-size'), 'var(--type-list)');
  assert.equal(declarationsFor('.food-list-title').get('white-space'), 'nowrap');
  assert.equal(declarationsFor('.food-list-title').get('text-overflow'), 'ellipsis');
  assert.equal(declarationsFor('.community-waterfall .feed-title').get('line-height'), '1.5');
  assert.equal(declarationsFor('.community-waterfall .feed-body').get('min-height'), '44px');
  assert.equal(declarationsFor('.home-menu-photo', home).get('border-radius'), 'var(--food-photo-radius)');
  assert.equal(declarationsFor('.community-waterfall .feed-card').get('border-radius'), 'var(--feed-cover-radius)');
  assert.equal(declarationsFor('.community-waterfall .feed-cover').get('border-radius'), 'var(--feed-cover-radius)');
  assert.equal(declarationsFor('.community-waterfall .feed-cover').get('height'), '0');
  assert.equal(declarationsFor('.feed-cover-media').get('position'), 'absolute');
  assert.equal(declarationsFor('.community-waterfall .waterfall-lane').get('flex-direction'), 'column');
  assert.equal(declarationsFor('.community-waterfall .waterfall-lane').get('flex'), '1');
});

test('menu thumbnails clip both the native image and its component wrapper without changing round avatars', () => {
  const lazy = postcss.parse(source('src/components/LazyImage.vue').match(/<style scoped>([\s\S]*?)<\/style>/)[1]);
  assert.equal(declarationsFor('.home-menu-photo', home).get('overflow'), 'hidden');
  assert.equal(declarationsFor('.home-menu-photo', home).get('padding'), '0');
  for (const selector of ['.round-photo', '.round-photo .lazy-photo-image', '.round-photo .lazy-photo-placeholder', '.round-photo .lazy-photo-retry']) assert.equal(declarationsFor(selector, lazy).get('border-radius'), '50%');
});

test('menu toolbar is explicit and category spacing does not single out sets', () => {
  const component = source('src/components/HomeMenu.vue');
  assert.match(component, /placeholder="搜菜品、套餐"/);
  assert.match(source('src/components/CommunityView.vue'), /placeholder="搜索" aria-label="搜索美食菜品或套餐"/);
  assert.doesNotMatch(component, /meal-set-category/);
  const create = declarationsFor('.home-menu-add');
  assert.equal(create.get('border'), '0');
  assert.equal(create.get('border-radius'), '50%');
  assert.equal(create.get('width'), '44px');
  assert.equal(create.get('height'), '44px');
});

test('selection toolbar contrasts with categories and aligns clearing beside checkout', () => {
  const dock = declarationsFor('.selection-dock');
  assert.equal(dock.get('height'), '66px');
  assert.equal(dock.get('min-height'), '66px');
  assert.equal(dock.get('padding'), '10px');
  assert.equal(parseFloat(dock.get('height')), parseFloat(declarationsFor('.selection-dock .selection-submit').get('height')) + 2 * parseFloat(dock.get('padding')) + 2 * parseFloat(dock.get('border')), 'equal padding surrounds the unchanged checkout button');
  assert.ok(parseFloat(declarationsFor('.app-shell').get('--selection-height')) >= parseFloat(dock.get('height')), 'menu reserves enough height for the checkout dock');
  assert.equal(dock.get('border-radius'), 'var(--radius-card)');
  assert.equal(dock.get('background'), 'var(--white)');
  assert.equal(dock.get('box-shadow'), '0 6px 28px rgba(36, 54, 63, 0.09)');
  assert.equal(dock.get('backdrop-filter'), 'none');
  assert.equal(dock.get('left'), 'var(--page-gutter)');
  assert.equal(dock.get('right'), 'var(--page-gutter)');
  assert.equal(dock.get('bottom'), 'calc(var(--nav-height) + env(safe-area-inset-bottom) + 6px)');
  for (const selector of ['.selection-clear', '.selection-dock .selection-submit']) {
    const action = declarationsFor(selector);
    assert.equal(action.get('height'), '44px');
    assert.equal(action.get('min-height'), '44px');
    assert.equal(action.get('border-radius'), 'var(--radius-control)');
    assert.equal(action.get('font-family'), 'var(--font-body)');
    assert.equal(action.get('font-size'), 'var(--type-control)');
  }
  assert.equal(declarationsFor('.selection-overview').get('gap'), '6px');
  assert.equal(declarationsFor('.selection-summary').get('flex'), '0 1 auto');
  assert.equal(declarationsFor('.selection-summary').get('font-family'), 'var(--font-body)');
  assert.equal(declarationsFor('.selection-summary').get('font-size'), 'var(--type-control)');
  assert.equal(declarationsFor('.selection-clear').get('background'), 'transparent');
  assert.equal(declarationsFor('.selection-clear').get('color'), 'var(--danger)');
  assert.equal(declarationsFor('.selection-clear').get('gap'), '6px');
  assert.equal(declarationsFor('.selection-clear').get('margin-left'), 'auto');
  assert.ok(existsSync(new URL('../src/static/icon-trash-danger.png', import.meta.url)));
  assert.equal(declarationsFor('.selection-clear').get('min-width'), '44px');
  assert.equal(declarationsFor('.selection-dock .selection-submit').get('flex'), '0 0 88px');
  assert.equal(declarationsFor('.selection-actions').size, 0);
  assert.equal(declarationsFor('.selection-actions button').size, 0);
  assert.equal(declarationsFor('.recipe-section-heading').get('justify-content'), 'flex-start');
});

test('procurement reuses the menu checkout surface and action instead of defining its own frame', () => {
  const component = source('src/components/ShoppingView.vue');
  const styles = postcss.parse(component.match(/<style scoped>([\s\S]*?)<\/style>/)[1]);
  assert.match(component, /class="selection-dock shopping-purchase"/);
  assert.match(component, /class="primary-button selection-submit"/);
  assert.deepEqual([...declarationsFor('.shopping-purchase', styles)], [['height', 'auto']]);
  assert.equal(declarationsFor('.shopping-purchase .primary-button', styles).size, 0);
  assert.equal(declarationsFor('.selection-dock').get('border'), '1px solid var(--line)');
  assert.equal(declarationsFor('.selection-dock').get('padding'), '10px');
  assert.equal(declarationsFor('.selection-dock .selection-submit').get('gap'), '6px');
  assert.equal(declarationsFor('.selection-dock .selection-submit').get('white-space'), 'nowrap');
  assert.equal(declarationsFor('.shopping-purchase-count', styles).get('line-height'), '20px');
  assert.equal(declarationsFor('.shopping-purchase-meta', styles).get('line-height'), '16px');
  assert.ok(existsSync(new URL('../src/static/icon-menu-inverse.png', import.meta.url)));
});

test('procurement uses the kitchen card frame with slightly relaxed top-aligned rows and stable touch targets', () => {
  const component = source('src/components/ShoppingView.vue');
  const styles = postcss.parse(component.match(/<style scoped>([\s\S]*?)<\/style>/)[1]);
  assert.match(component, /class="order-card shopping-meal"/);
  assert.equal(declarationsFor('.shopping-meal', styles).size, 0);
  const frame = declarationsFor('.order-card');
  assert.equal(frame.get('border'), '1px solid var(--line)');
  assert.equal(frame.get('border-radius'), 'var(--radius-card)');
  assert.equal(frame.get('padding'), 'var(--panel-padding)');
  assert.equal(frame.get('margin-bottom'), '12px');
  assert.equal(declarationsFor('.shopping-view.has-packages', styles).get('padding'), '2px var(--page-gutter) 88px');
  assert.equal(declarationsFor('.shopping-meal-heading', styles).get('margin'), '0 0 2px');
  assert.equal(declarationsFor('.shopping-package', styles).get('padding'), '8px 0');
  assert.equal(declarationsFor('.shopping-package', styles).get('margin'), '0');
  assert.equal(declarationsFor('.shopping-package-ingredients', styles).get('margin-top'), '10px');
  for (const selector of ['.shopping-meal-select', '.shopping-dish-select', '.shopping-remove']) assert.equal(declarationsFor(selector, styles).get('min-height'), '44px');
  assert.equal(declarationsFor('.shopping-view', styles).get('--shopping-column-gap'), '10px');
  assert.equal(declarationsFor('.shopping-meal-select', styles).get('gap'), 'var(--shopping-column-gap)');
  assert.equal(declarationsFor('.shopping-package-heading', styles).get('gap'), 'var(--shopping-column-gap)');
  assert.equal(declarationsFor('.shopping-package-heading', styles).get('align-items'), 'flex-start');
  for (const selector of ['.shopping-dish-select', '.shopping-remove']) assert.equal(declarationsFor(selector, styles).get('align-self'), 'center');
  assert.equal(declarationsFor('.shopping-dish-open', styles).get('align-items'), 'flex-start');
  assert.equal(declarationsFor('.shopping-dish-open .meal-ingredient-title', styles).get('line-height'), '20px');
  assert.equal(declarationsFor('.shopping-dish-copy', styles).get('flex-direction'), 'column');
  assert.equal(declarationsFor('.shopping-dish-copy', styles).get('gap'), '2px');
  for (const selector of ['.shopping-dish-open', '.shopping-package-disclosure']) {
    const action = declarationsFor(selector, styles);
    assert.equal(action.get('min-height'), '24px');
    assert.equal(action.get('width'), '100%');
    assert.equal(action.get('margin'), '0');
    assert.equal(action.get('padding'), '0');
  }
});

test('detail ordering is one title-row pill while other share/import footers retain their common appearance', () => {
  const component = source('src/components/MenuDetailActions.vue');
  const actions = postcss.parse(component.match(/<style scoped>([\s\S]*?)<\/style>/)[1]);
  assert.equal(declarationsFor('.menu-detail-share', actions).size, 0);
  const order = declarationsFor('.food-detail-primary .menu-detail-order');
  assert.equal(order.get('min-height'), '44px');
  assert.equal(order.get('background'), 'transparent');
  const surface = declarationsFor('.detail-choice-surface');
  assert.equal(surface.get('border-radius'), '999px');
  assert.equal(surface.get('background'), 'var(--green)');
  assert.equal(surface.get('min-height'), 'var(--detail-action-height)');
  assert.match(component, /class="detail-choice-surface"/);
  assert.equal((component.match(/class="recipe-detail-button menu-detail-/g) || []).length, 1);
  const button = declarationsFor('.recipe-detail-button');
  assert.equal(button.get('height'), '48px');
  assert.equal(button.get('min-height'), '48px');
  assert.equal(button.get('border-radius'), 'var(--radius-control)');
  assert.equal(button.get('border'), '1px solid var(--border-strong)');
  assert.equal(button.get('background'), 'var(--white)');
  assert.equal(button.get('color'), 'var(--green)');
  assert.equal(button.get('font-family'), 'var(--font-body)');
  assert.equal(button.get('font-size'), 'var(--type-control)');
  assert.equal(button.get('font-weight'), '500');
  assert.equal(declarationsFor('.menu-detail-actions', actions).get('align-items'), 'center');
  assert.equal(declarationsFor('.friend-detail-actions').get('gap'), '12px');
  assert.equal(declarationsFor('.friend-action-cell .recipe-detail-button').get('width'), '100%');
  const complete = declarationsFor('.recipe-detail-button.is-complete');
  assert.equal(complete.get('opacity'), '1');
  assert.equal(complete.get('background'), 'var(--white)');
  assert.equal(complete.get('color'), 'var(--muted)');
  assert.match(component, /'is-complete': selected/);
  for (const path of ['src/pages/shared/index.vue']) {
    const entry = source(path);
    assert.match(entry, /class="recipe-detail-button" :class="\{ 'is-complete':/);
    assert.match(entry, /'check' : 'plus'" :size="19" :active=/);
  }
  const forward = source('src/components/FriendForwardButton.vue');
  assert.match(forward, /button-class="recipe-detail-button friend-forward-button"/);
  assert.match(forward, /name="share" :size="19" active/);
  assert.match(forward, /<text>分享<\/text>/);
  assert.doesNotMatch(component, /primary-button|flex: 2/);
  assert.match(component, /'plus-inverse'/);
  assert.match(component, /:name="selected \? 'check' : 'plus-inverse'" :size="14"/);
  assert.match(component, /:disabled="selected \|\| busy" @click="\$feedback\(\); \$emit\('add'\)"/);
  assert.doesNotMatch(component, /\$emit\('share'\)/);
});

test('all main pages and detached sheets share spacing and surface tokens', () => {
  for (const selector of ['.family-banner', '.order-card', '.cooking-diary', '.checkout-card', '.family-choice-row']) {
    assert.equal(declarationsFor(selector).get('border-radius'), 'var(--radius-card)', selector);
  }
  assert.equal(declarationsFor('.page-header').get('min-height'), '52px');
  assert.equal(declarationsFor('.page-heading').get('font-size'), 'var(--type-heading)');
  assert.equal(declarationsFor('.sheet-header').get('padding'), '8px var(--page-gutter)');
  assert.equal(declarationsFor('.sheet-content').get('padding'), '16px var(--page-gutter) 24px');
  assert.equal(declarationsFor('.app-shell.sheet-root').get('background'), 'transparent');
  assert.equal(declarationsFor('.sheet').get('background'), 'var(--white, #ffffff)');
});

test('standalone invitation and shared recipe routes use the same native white navigation', () => {
  const configuration = JSON.parse(source('src/pages.json'));
  assert.equal(configuration.globalStyle.backgroundColor, '#ffffff');
  for (const path of ['pages/shared/index', 'pages/invite/index']) {
    const page = configuration.pages.find((page) => page.path === path);
    assert.ok(page, path);
    assert.equal(page.style.navigationBarBackgroundColor, '#ffffff', path);
  }
});

test('community waterfall keeps two stable lanes, detail-only cards and the original pagination', () => {
  const component = source('src/components/CommunityView.vue');
  assert.match(component, /class="waterfall community-waterfall"/);
  assert.match(component, /buildFoodWaterfall\(filtered.value\)/);
  assert.match(component, /v-for="\(lane, laneIndex\) in lanes"/);
  assert.match(component, /v-for="entry in lane" :key="entry.post.id"/);
  assert.match(component, /paddingTop: entry.coverPadding/);
  assert.match(component, /class="feed-body"[^>]*@click="open\(entry.post\)"/);
  assert.doesNotMatch(component, /class="feed-join"|@click="add\(entry.post\)"/);
  assert.match(component, /class="feed-meta"[^]*?<CommunityFamilyCount[^>]*inline/);
  assert.match(component, /class="recipe-detail-button menu-detail-order"[^>]*:disabled="imported\(current\) \|\| removingPost \|\| addingPosts.includes\(current.id\)"[^>]*@click="add\(current\)"/);
  assert.match(component, /createCommunityFeed/);
  assert.match(component, /loadMore/);
  assert.doesNotMatch(component, /class="community-list"/);
});

test('family settings retain cloud management and explicitly identify the limited local preview', () => {
  const editor = source('src/components/FamilyEditor.vue');
  const management = source('src/components/FamilyManagement.vue');
  assert.match(editor, /v-if="cloudMode" class="family-settings-tabs"/);
  assert.match(editor, /<FamilyManagement v-if="cloudMode && managementVisited"/);
  assert.match(editor, /v-if="!cloudMode" class="preview-mode-note" role="status"/);
  for (const action of ['create()', 'leave(family)', 'deleteFamily(family)']) assert.ok(management.includes(action), action);
  for (const label of ['新建', '确认退出', '删除家庭']) assert.ok(management.includes(label), label);
});

test('editor action icons exist for both native visual states', () => {
  for (const name of ['close', 'plus', 'plus-inverse', 'minus', 'check', 'check-inverse', 'arrow-up', 'arrow-down', 'chevron']) {
    for (const suffix of ['', '-active']) {
      assert.ok(existsSync(new URL(`../src/static/icon-${name}${suffix}.png`, import.meta.url)), `${name}${suffix}`);
    }
  }
});
