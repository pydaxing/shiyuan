import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileTemplate } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import postcss from 'postcss';
import { foodDetailToolbarOpacity } from '../src/domain/food-detail.js';
import { isPendingRecord } from '../src/services/mutation-feedback.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const descriptor = parse(read('src/components/FoodDetailSheet.vue')).descriptor;
const compiled = compileTemplate({ source: descriptor.template.content, filename: 'FoodDetailSheet.vue', id: 'food-detail-test' });
assert.deepEqual(compiled.errors, []);
const renderCode = compiled.code.replace(/import \{([^}]+)\} from "vue"/g, (_, imports) => `const {${imports.replace(/ as /g, ': ')}} = Vue;`).replace('export function render', 'return function render');
const render = new Function('Vue', renderCode)({ ...Vue, resolveComponent: name => ({ name }), renderSlot: (slots, name) => Vue.createVNode('slot', { name }, slots[name]?.() || []) });
const setupCode = descriptor.scriptSetup.content.replace(/^import .*;\s*$/gm, '');

function collect(node) {
  if (Array.isArray(node)) return node.flatMap(collect);
  if (!node || typeof node !== 'object') return [];
  const children = Array.isArray(node.children) ? node.children : Object.values(node.children || {}).filter(value => typeof value === 'function').flatMap(slot => slot());
  return [node, ...children.flatMap(collect)];
}

function detail(overrides = {}) {
  const props = Vue.reactive({ title: '完整显示而不截断的菜品名称', image: '/photo.jpg', kind: 'dish', community: false, publisher: '', familyCount: null, canEdit: false, canRemove: false, canShare: false, shareCard: null, sharing: false, busy: false, ...overrides });
  const events = [];
  const setup = new Function('computed', 'ref', 'defineProps', 'defineEmits', 'foodDetailToolbarOpacity', `${setupCode}; return { menuOpen, toolbarOpacity, publisherName, coverFamilyCount, actions, onDetailScroll };`)(Vue.computed, Vue.ref, () => props, () => () => {}, foodDetailToolbarOpacity);
  const draw = () => collect(render(Vue.proxyRefs({ ...props, ...setup, $slots: {}, $feedback() {}, $emit: event => events.push(event) }), []));
  const find = predicate => draw().find(predicate);
  return { props, setup, events, draw, find };
}

test('immersive details share one full-width cover and keep the full title below it', () => {
  const control = detail();
  const rendered = control.draw();
  const sheet = rendered.find(node => node.type?.name === 'Sheet');
  assert.equal(sheet.props.immersive, '');
  assert.equal(sheet.props['fit-content'], false);
  assert.equal(typeof sheet.children.header, 'function');
  const cover = rendered.find(node => node.type?.name === 'RecipeCover');
  assert.equal(cover.props.image, '/photo.jpg');
  assert.equal(cover.props.immersive, '');
  const title = rendered.find(node => node.props?.class === 'food-detail-title');
  assert.equal(title.children, control.props.title);
  assert.ok(rendered.indexOf(cover) < rendered.indexOf(title));
  const source = descriptor.template.content;
  assert.ok(source.indexOf('<RecipeCover') < source.indexOf('class="food-detail-title"'));
  assert.doesNotMatch(source, /#footer|food-list-title/);
});

test('editable menu details show share and only permitted edit/delete actions', () => {
  const control = detail({ canShare: true, canEdit: true, canRemove: true });
  const share = control.find(node => node.type === 'button' && node.props?.['aria-label'] === '分享菜品或套餐');
  assert.equal(share.props.disabled, false);
  share.props.onClick({ stopPropagation() {} });
  assert.deepEqual(control.events, ['share']);
  const more = control.find(node => node.type?.name === 'OrderActionMenu');
  assert.deepEqual(more.props.actions.map(option => option.action), ['edit', 'remove']);
  more.props.onEdit();
  more.props.onRemove();
  assert.deepEqual(control.events, ['share', 'edit', 'remove']);
  control.props.sharing = true;
  assert.equal(control.find(node => node.type === 'button' && node.props?.['aria-label'] === '正在准备分享').props.disabled, true);
  assert.equal(control.find(node => node.type?.name === 'OrderActionMenu').props.busy, true);
});

test('read-only snapshots have no editing actions, while public cards use the real native share component', () => {
  const readonly = detail();
  assert.equal(readonly.find(node => ['NativeShareButton', 'OrderActionMenu'].includes(node.type?.name)), undefined);
  const close = readonly.find(node => node.props?.['aria-label'] === '关闭详情');
  close.props.onClick({ stopPropagation() {} });
  assert.deepEqual(readonly.events, ['close']);
  const card = { title: '分享菜品', path: '/pages/shared/index?postId=published' };
  const publicDetail = detail({ shareCard: card });
  assert.deepEqual(publicDetail.find(node => node.type?.name === 'NativeShareButton').props.card, card);
  assert.equal(publicDetail.find(node => node.type?.name === 'OrderActionMenu'), undefined);
});

test('detail toolbar follows native scrolling in both directions without a persistent white bar', () => {
  const control = detail({ canEdit: true });
  const backdrop = () => control.find(node => node.props?.class === 'food-detail-toolbar-backdrop');
  const sheet = control.find(node => node.type?.name === 'Sheet');
  assert.equal(backdrop().props.style.opacity, 0);
  control.setup.menuOpen.value = true;
  for (const [scrollTop, opacity] of [[30, .25], [60, .5], [120, 1], [600, 1], [60, .5], [0, 0], [-10, 0]]) {
    sheet.props.onScroll({ detail: { scrollTop } });
    assert.equal(backdrop().props.style.opacity, opacity);
    assert.equal(control.setup.menuOpen.value, false);
  }
  for (const invalid of [undefined, null, NaN, Infinity, '60']) assert.equal(foodDetailToolbarOpacity(invalid), 0);
  assert.equal(foodDetailToolbarOpacity(15), .13);
});

test('shared Sheet preserves its scroll bookkeeping and only forwards immersive scroll events', () => {
  const source = read('src/components/Sheet.vue');
  const code = source.slice(source.indexOf('function handleScroll('), source.indexOf('\nconst layer ='));
  for (const immersive of [false, true]) {
    const calls = [];
    const event = { detail: { scrollTop: 60 } };
    const handler = new Function('props', 'onScroll', 'emit', `${code}; return handleScroll;`)({ immersive }, received => calls.push(['bookkeeping', received]), (...args) => calls.push(args));
    handler(event);
    assert.deepEqual(calls, immersive ? [['bookkeeping', event], ['scroll', event]] : [['bookkeeping', event]]);
  }
  assert.match(source, /@scroll="handleScroll"/);
});

test('community details keep the publisher below the title and move the count onto the cover', () => {
  const control = detail({ community: true, publisher: '  原始发布者  ', familyCount: 2 });
  const nodes = control.draw();
  const title = nodes.find(node => node.props?.class === 'food-detail-title');
  const row = nodes.find(node => node.props?.class === 'food-detail-attribution');
  const author = collect(row).find(node => node.props?.class === 'food-detail-publisher');
  assert.ok(nodes.indexOf(row) > nodes.indexOf(title));
  assert.equal(author.children, '原始发布者');
  assert.equal(collect(row).find(node => node.type?.name === 'CommunityFamilyCount'), undefined);
  assert.equal(nodes.find(node => node.type?.name === 'RecipeCover').props['family-count'], 2);
  assert.equal(detail().find(node => node.props?.class === 'food-detail-attribution'), undefined);
  for (const count of [0, 2, 999]) assert.equal(detail({ community: true, familyCount: count }).find(node => node.type?.name === 'RecipeCover').props['family-count'], count);
  for (const count of [undefined, null, -1, NaN, Infinity, '2']) assert.equal(detail({ community: true, familyCount: count }).find(node => node.type?.name === 'RecipeCover').props['family-count'], null);
});

test('non-community details hide attribution even when saved author and count data are supplied', () => {
  const control = detail({ publisher: '原始发布者', familyCount: 2 });
  const author = () => control.find(node => node.props?.class === 'food-detail-attribution');
  const cover = () => control.find(node => node.type?.name === 'RecipeCover');
  assert.equal(author(), undefined);
  assert.equal(cover().props['family-count'], null);
  control.props.community = true;
  assert.ok(author());
  assert.equal(cover().props['family-count'], 2);
  control.props.community = false;
  assert.equal(author(), undefined);
  assert.equal(cover().props['family-count'], null);
  for (const publisher of [undefined, null, '', ' ', 42]) assert.equal(detail({ community: true, publisher }).find(node => node.props?.class === 'food-detail-attribution'), undefined);
});

test('only the community entry opts into public detail metadata, not menu, kitchen, diary or shared entries', () => {
  for (const file of ['RecipeSheet.vue', 'SetSheet.vue']) {
    const source = read(`src/components/${file}`);
    assert.doesNotMatch(source.match(/<FoodDetailSheet[^>]*>/)[0], /community|publisher|family-count/);
    assert.doesNotMatch(source, /foodDetailPublisher/);
  }
  assert.doesNotMatch(parse(read('src/pages/shared/index.vue')).descriptor.template.content, /post\.author|CommunityFamilyCount/);
  assert.match(read('src/components/CommunityView.vue'), /<FoodDetailSheet[^>]*\bcommunity\s/);
  assert.match(read('src/components/CommunityView.vue'), /:publisher="communityPublisherName\(current\)" :family-count="current.importedFamilyCount"/);
});

test('menu detail action uses a plus and selection label without changing selected or busy behavior', () => {
  const actionDescriptor = parse(read('src/components/MenuDetailActions.vue')).descriptor;
  const actionTemplate = compileTemplate({ source: actionDescriptor.template.content, filename: 'MenuDetailActions.vue', id: 'menu-action-test' });
  assert.deepEqual(actionTemplate.errors, []);
  const actionCode = actionTemplate.code.replace(/import \{([^}]+)\} from "vue"/g, (_, imports) => `const {${imports.replace(/ as /g, ': ')}} = Vue;`).replace('export function render', 'return function render');
  const actionRender = new Function('Vue', actionCode)({ ...Vue, resolveComponent: name => ({ name }) });
  const events = [];
  const context = { selected: false, busy: false, $feedback() {}, $emit: event => events.push(event) };
  const draw = () => collect(actionRender(context, []));
  const button = () => draw().find(node => node.type === 'button');
  assert.equal(button().props['aria-label'], '选择');
  assert.equal(button().props.disabled, false);
  assert.ok(draw().some(node => node.type === 'text' && node.children === '选择'));
  assert.equal(draw().find(node => node.type?.name === 'AppIcon').props.name, 'plus-inverse');
  button().props.onClick();
  assert.deepEqual(events, ['add']);
  context.busy = true;
  assert.equal(button().props.disabled, true);
  context.busy = false;
  context.selected = true;
  assert.equal(button().props.disabled, true);
  assert.equal(button().props['aria-pressed'], true);
  assert.equal(button().props['aria-label'], '已选中');
  assert.equal(draw().find(node => node.type?.name === 'AppIcon').props.name, 'check');
});

test('detail controls use a pure downward chevron and dedicated rounded share artwork', () => {
  const icons = detail({ canShare: true }).draw().filter(node => node.type?.name === 'AppIcon').map(node => node.props.name);
  assert.ok(icons.includes('detail-collapse'));
  assert.ok(icons.includes('detail-share'));
  assert.ok(!icons.includes('arrow') && !icons.includes('share-feed'));
  assert.match(read('scripts/build-ui-art.mjs'), /'detail-collapse': '<path d="m7\.5 12 8\.5 8\.5 8\.5-8\.5"\/>',/);
  for (const icon of ['detail-collapse', 'detail-share']) {
    for (const variant of ['', '-active']) {
      const png = readFileSync(new URL(`../src/static/icon-${icon}${variant}.png`, import.meta.url));
      assert.equal(png.readUInt32BE(16), 96);
      assert.equal(png.readUInt32BE(20), 96);
    }
  }
});

test('swipe sharing prepares once and releases its reactive busy guard on success or failure', async () => {
  const page = read('src/pages/index/index.vue');
  const action = page.slice(page.indexOf('async function shareEntry('), page.indexOf('\nwatch(() => cloudStatus.value.familyId'));
  for (const failure of [false, true]) {
    const selection = Vue.ref(null);
    const removing = Vue.ref(false);
    let resolve;
    let requests = 0;
    const pending = new Promise(done => { resolve = done; });
    const handler = new Function('swipeSharing', 'removingMenuEntry', 'nextTick', 'prepareMenuShare', 'isPendingRecord', 'friendSharing', 'cloudMode', `${action}; return shareEntry;`)(selection, removing, Vue.nextTick, async () => { requests += 1; await pending; if (failure) throw new Error('无法分享'); }, isPendingRecord, Vue.ref(null), true);
    const entry = { id: 'dish', kind: 'dish' };
    const result = handler(entry);
    await Vue.nextTick();
    await handler(entry);
    assert.equal(requests, 1);
    assert.equal(selection.value.id, 'dish');
    resolve();
    if (failure) await assert.rejects(result, /无法分享/);
    else await result;
    assert.equal(selection.value, null);
    removing.value = true;
    await handler(entry);
    assert.equal(requests, 1);
  }
});

test('opening and dismissing share choices keeps the original dish or set detail mounted', () => {
  const page = read('src/pages/index/index.vue');
  const action = page.slice(page.indexOf('function share(item,'), page.indexOf('\nasync function shareEntry('));
  for (const kind of ['dish', 'set']) {
    const item = { id: 'original', title: '原菜品或套餐' };
    const detail = Vue.ref(kind === 'dish' ? item : null);
    const setDetail = Vue.ref(kind === 'set' ? item : null);
    const originalDetail = detail.value;
    const originalSet = setDetail.value;
    const friendSharing = Vue.ref(null);
    const card = { title: item.title, path: '/pages/share/index?token=prepared' };
    const share = new Function('detail', 'setDetail', 'friendSharing', 'isPendingRecord', 'notify', `${action}; return share;`)(detail, setDetail, friendSharing, () => false, () => {});
    share(item, kind, card);
    assert.equal(detail.value, originalDetail);
    assert.equal(setDetail.value, originalSet);
    assert.deepEqual(friendSharing.value, { itemId: item.id, kind, card });
    friendSharing.value = null;
    assert.equal(detail.value, originalDetail);
    assert.equal(setDetail.value, originalSet);
  }
  assert.match(page, /<FriendShareSheet[^>]*@close="closeFriendShare"/);
  assert.match(page, /<ShareSheet[^>]*@close="sharing = null"/);
  const published = page.match(/<ShareSheet[^>]*@published="([^"]+)"/)[1];
  const complete = new Function('sharing', 'detail', 'setDetail', 'tab', `${published}; return { sharing, detail, setDetail, tab };`);
  assert.deepEqual(complete({}, {}, {}, 'menu'), { sharing: null, detail: null, setDetail: null, tab: 'community' });
});

test('all mobile shells share eight-pixel gutters while immersive cover and toolbar remain independently laid out', () => {
  const stylesheet = postcss.parse(read('src/styles.css'));
  const declarations = selector => {
    const values = new Map();
    stylesheet.walkRules(rule => { if (rule.selectors.includes(selector)) rule.walkDecls(declaration => values.set(declaration.prop, declaration.value)); });
    return values;
  };
  assert.equal(declarations('.app-shell').get('--page-gutter'), '8px');
  assert.equal(declarations('.app-shell').get('--feed-page-gutter'), '5px');
  for (const selector of ['.content', '.entry-page', '.food-detail-body', '.sheet-header', '.sheet-content', '.sheet-footer']) assert.ok([...declarations(selector).values()].some(value => value.includes('var(--page-gutter)')), selector);
  for (const selector of ['.sheet', '.entry-page']) assert.equal(declarations(selector).get('--page-gutter'), undefined);
  assert.equal(declarations('.sheet.is-food-detail .sheet-content').get('padding'), '0 0 16px');
  assert.equal(declarations('.sheet.is-food-detail .sheet-header').get('position'), 'absolute');
  assert.equal(declarations('.recipe-cover.is-immersive').get('border-radius'), '0');
  assert.equal(declarations('.recipe-cover-fade').get('pointer-events'), 'none');
  assert.equal(declarations('.recipe-cover-fade').get('height'), 'calc(var(--detail-card-overlap) + 28px)');
  assert.match(declarations('.recipe-cover-fade').get('background'), /rgba\(245, 247, 248, \.015\) 28%/);
  assert.match(declarations('.recipe-cover-fade').get('background'), /rgba\(245, 247, 248, \.08\) 48%/);
  assert.match(declarations('.recipe-cover-fade').get('background'), /rgba\(245, 247, 248, \.24\) 64%/);
  assert.ok(declarations('.recipe-cover-fade').get('background').endsWith('var(--paper))'));
  assert.match(read('src/components/RecipeCover.vue'), /<view v-if="immersive" class="recipe-cover-fade" aria-hidden="true"/);
  assert.equal(declarations('.sheet.is-food-detail .sheet-header').get('top'), '0');
  assert.equal(declarations('.sheet.is-food-detail .sheet-header').get('background'), 'transparent');
  assert.equal(declarations('.sheet.is-food-detail .sheet-header').get('border'), '0');
  assert.equal(declarations('.food-detail-toolbar-backdrop').get('opacity'), '0');
  assert.equal(declarations('.food-detail-toolbar').get('height'), 'var(--detail-toolbar-height)');
  assert.equal(declarations('.food-detail-body').get('border-radius'), 'var(--detail-card-radius)');
  assert.equal(declarations('.food-detail-body').get('margin'), 'calc(0px - var(--detail-card-overlap)) var(--page-gutter) 0');
  assert.equal(declarations('.food-detail-body').get('background'), 'var(--white)');
  assert.equal(declarations('.food-detail-body').get('background-image'), undefined);
  assert.equal(declarations('.food-detail-body').get('padding'), '12px var(--panel-padding) 16px');
  for (const selector of ['.recipe-cover-fade', '.food-detail-body']) {
    for (const property of ['filter', 'backdrop-filter', 'opacity', 'mask-image']) assert.equal(declarations(selector).get(property), undefined, `${selector} must not fade or blur its content`);
  }
  assert.equal(declarations('.detail-choice-surface').get('min-height'), 'var(--detail-action-height)');
  assert.equal(declarations('.food-detail-primary .menu-detail-order').get('min-height'), '44px');
  assert.equal(declarations('.food-detail-primary .menu-detail-order').get('background'), 'transparent');
  assert.equal(declarations('.recipe-cover.is-immersive .recipe-cover-meta').get('top'), 'auto');
  assert.equal(declarations('.recipe-cover.is-immersive .recipe-cover-meta').get('bottom'), 'calc(var(--detail-card-overlap) + 24px)');
  assert.equal(declarations('.detail-toolbar-button').get('width'), '44px');
  assert.equal(declarations('.food-detail-title').get('font-size'), 'var(--type-title)');
});
