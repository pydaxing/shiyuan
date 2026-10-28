import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { pageHeaderHeight, pageHeaderStyle } from '../src/domain/mobile.js';
import { homeMenuGeometry } from '../src/domain/home-menu.js';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const css = postcss.parse(source('src/styles.css'));
function declarations(selector) {
  const result = new Map();
  css.walkRules(rule => { if (rule.selectors.includes(selector)) rule.walkDecls(value => result.set(value.prop, value.value)); });
  return result;
}

test('custom page titles remain geometrically centered, with identical capsule spacing on both sides', () => {
  assert.equal(declarations('.page-header').get('justify-content'), 'center');
  assert.equal(declarations('.page-heading').get('text-align'), 'center');
  for (const width of [320, 360, 390, 430]) {
    const result = pageHeaderStyle({ windowWidth: width, statusBarHeight: 54 }, { top: 58, bottom: 90, left: width - 97 });
    assert.equal(result.paddingLeft, result.paddingRight);
    assert.equal(result.paddingTop, '58px');
    assert.equal(result.minHeight, '102px');
    assert.equal(result.paddingBottom, '12px');
    assert.ok(result.paddingRight.includes('105px'));
  }
  assert.deepEqual(pageHeaderStyle({}, null), {});
  assert.equal(pageHeaderStyle({ windowWidth: 390, statusBarHeight: 54 }, {}).paddingTop, '58px');
  assert.match(source('src/components/PageHeader.vue'), /pageHeaderStyle\(info, capsule\)/);
  assert.equal(declarations('.page-heading-edit > .app-icon').get('position'), 'absolute');
});

test('fixed page titles reserve the same height as menu viewports and kitchen anchors', () => {
  for (const width of [320, 360, 390, 430, 760, 761, 1024]) {
    const info = { windowWidth: width, uniPlatform: 'h5' };
    const height = pageHeaderHeight(info);
    assert.equal(height, width > 760 ? 64 : 52);
    assert.equal(homeMenuGeometry(info).headerHeight, height);
    assert.equal(homeMenuGeometry(info).kitchenTop, height + 12);
    for (const statusBarHeight of [20, 44, 54, 59]) {
      const nativeInfo = { ...info, uniPlatform: 'mp-weixin', statusBarHeight };
      const capsule = { top: statusBarHeight + 4, bottom: statusBarHeight + 36, left: width - 97 };
      const style = pageHeaderStyle(nativeInfo, capsule);
      assert.equal(style.paddingTop, `${capsule.top}px`);
      assert.equal(style.paddingBottom, '12px');
      assert.equal(pageHeaderHeight(nativeInfo, capsule), capsule.bottom + 12);
      assert.equal(pageHeaderHeight(nativeInfo, capsule) - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom), capsule.bottom - capsule.top);
      assert.equal(pageHeaderHeight(nativeInfo, capsule), Number.parseFloat(pageHeaderStyle(nativeInfo, capsule).minHeight));
      assert.equal(homeMenuGeometry(nativeInfo, capsule).headerHeight, pageHeaderHeight(nativeInfo, capsule));
      assert.equal(pageHeaderHeight(nativeInfo), pageHeaderHeight(nativeInfo, {}));
    }
  }
  assert.equal(pageHeaderHeight(), 52);
  assert.equal(pageHeaderHeight({ screenWidth: 1024 }), 64);
});

test('all custom page headers share a full-width fixed surface below dialog overlays', () => {
  const fixed = declarations('.page-header-fixed');
  assert.equal(fixed.get('position'), 'fixed');
  assert.equal(fixed.get('top'), '0');
  assert.equal(fixed.get('right'), '0');
  assert.equal(fixed.get('background'), 'var(--white)');
  assert.ok(Number(fixed.get('z-index')) > 11);
  assert.ok(Number(fixed.get('z-index')) < Number(declarations('.cloud-sync-warning').get('z-index')));
  assert.ok(Number(fixed.get('z-index')) < Number(declarations('.sheet-backdrop').get('z-index')));
  assert.equal(declarations('.page-header-space').get('height'), 'calc(var(--page-header-height) + var(--page-header-extension-height, 0px))');
  assert.equal(declarations('.page-header-frame').get('max-width'), 'var(--content-width)');
  assert.equal(declarations('.page-header-frame').get('padding'), '0 var(--page-gutter)');
  const positions = [];
  css.walkRules(rule => {
    if (!rule.selectors.includes('.page-header-fixed')) return;
    rule.walkDecls('left', value => positions.push({ query: rule.parent.type === 'atrule' ? rule.parent.params : '', value: value.value }));
  });
  assert.deepEqual(positions, [{ query: '', value: 'var(--sidebar-width)' }, { query: '(max-width: 760px)', value: '0' }]);
  const header = source('src/components/PageHeader.vue');
  assert.match(header, /class="page-header-space"[^\n]+--page-header-height/);
  assert.match(header, /pageHeaderHeight\(info, capsule\)/);
  assert.match(header, /uni\.onWindowResize\?\.\(refreshLayout\)/);
  assert.match(header, /onScopeDispose\(\(\) => uni\.offWindowResize\?\.\(refreshLayout\)\)/);
  assert.match(header, /:style="layout\.safeStyle"/);
});

test('fixed titles keep page scrolling, feed pagination and the hidden menu lifecycle intact', () => {
  const page = source('src/pages/index/index.vue');
  assert.match(page, /<view v-show="tab === 'menu'" class="menu-view">\s*<PageHeader title="我家菜单"/);
  assert.match(page, /<PageHeader title="我家厨房"/);
  assert.match(page, /onReachBottom\(\(\) => \{ if \(tab\.value === 'community'\) communityView\.value\?\.loadMore\(\)/);
  assert.ok(source('src/components/CommunityView.vue').includes('<PageHeader title="美食"'));
  assert.match(source('src/components/IngredientsView.vue'), /<PageHeader :title="fridgeEnabled \? '食材' : '采购'"/);
  assert.match(source('src/components/FamilyView.vue'), /<PageHeader :title="familyDisplay\.name"/);
  assert.equal(declarations('.page-heading').get('text-overflow'), 'ellipsis');
});

test('sheet titles have symmetric control columns and stay centered when the keyboard done action appears', () => {
  assert.equal(declarations('.sheet-header').get('display'), 'grid');
  assert.equal(declarations('.sheet-header').get('grid-template-columns'), '48px minmax(0, 1fr) 48px');
  assert.equal(declarations('.sheet-heading').get('text-align'), 'center');
  const sheet = source('src/components/Sheet.vue');
  assert.ok(sheet.indexOf('class="sheet-header-leading"') < sheet.indexOf('class="sheet-heading"'));
  assert.ok(sheet.indexOf('class="sheet-heading"') < sheet.indexOf('class="sheet-header-actions"'));
  assert.match(sheet, /'keyboard-done-hidden': !keyboard/);
});

test('all create recipe surfaces say 创建菜品 without renaming edit or import actions', () => {
  for (const path of ['src/components/HomeMenu.vue', 'src/components/RecipeEditor.vue', 'src/pages/index/index.vue']) assert.doesNotMatch(source(path), /添加菜品/);
  assert.match(source('src/components/RecipeEditor.vue'), /recipe \? '编辑菜品' : '创建菜品'/);
  assert.match(source('src/pages/index/index.vue'), /aria-label="创建菜品"/);
  assert.match(source('src/components/HomeMenu.vue'), /primary-label="创建菜品"/);
});
