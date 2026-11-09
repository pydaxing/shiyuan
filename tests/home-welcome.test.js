import { orderStatusLabel } from '../src/domain/order-record-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parse, compileTemplate } from '@vue/compiler-sfc';
import { baseParse } from '@vue/compiler-dom';
import * as Vue from 'vue';
import postcss from 'postcss';
import { kitchenWelcome, homeDateLabel } from '../src/domain/home-welcome.js';
import { kitchenOrders, localDate, mealDateLabel } from '../src/domain/kitchen.js';
import { preparationMeals } from '../src/domain/meal-preparation.js';
import { HOME_MENU_CATEGORIES, groupHomeMenu } from '../src/domain/home-menu.js';
import { kitchenOrderAnchor } from '../src/composables/useKitchenFocus.js';
import { DEFAULT_FAMILY_COVER, FAMILY_APPEARANCE_DEFAULTS, familyAppearance } from '../src/domain/family.js';
import { DEFAULT_SET_COVER } from '../src/domain/presentation.js';

const today = '2026-10-22';
const read = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
const menuSource = read('components/HomeMenu.vue');
const indexSource = read('pages/index/index.vue');
const welcomeSource = read('components/HomeWelcome.vue');

function allNodes(node) {
  if (Array.isArray(node)) return node.flatMap(allNodes);
  if (!node || typeof node !== 'object') return [];
  return [node, ...(Array.isArray(node.children) ? node.children.flatMap(allNodes) : [])];
}

function compile(source) {
  const compiled = compileTemplate({ source, filename: 'home-welcome-test.vue', id: 'home-welcome-test' });
  assert.deepEqual(compiled.errors, []);
  const code = compiled.code.replace(/import \{([^}]+)\} from "vue"/g, (_, imports) => `const {${imports.replace(/ as /g, ': ')}} = Vue;`).replace('export function render', 'return function render');
  return new Function('Vue', code)({ ...Vue, resolveComponent: name => name });
}

const renderMenu = compile(parse(menuSource).descriptor.template.content);
const renderWelcome = compile(parse(welcomeSource).descriptor.template.content);
const indexNodes = allNodes(baseParse(parse(indexSource).descriptor.template.content));
const kitchenNode = indexNodes.find(node => node.props?.some(prop => prop.name === 'class' && prop.value?.content === 'orders-view'));
const renderKitchen = compile(kitchenNode.loc.source);
const withClass = (nodes, className) => nodes.filter(node => typeof node.props?.class === 'string' && node.props.class.split(' ').includes(className));
const meal = (status, id = status, date = today) => ({ id, status, date, recordState: status === 'completed' ? 'recorded' : '', meal: '晚餐', items: [] });

function menuContext({ entries = [], search = '', family = {}, currentDay = today } = {}) {
  const groups = groupHomeMenu(entries, search).filter(group => group.entries.length);
  return {
    entries, search, query: search, category: '荤菜', selected: {}, busy: false, menuStyle: {}, cover: 'cloud://family-cover', menuAppearance: familyAppearance(family), dateLabel: homeDateLabel(currentDay), emptyMenu: !entries.length,
    docked: true, sheetOpen: false, scrollEnabled: true, railTarget: '', listScrollTarget: 0, openedKey: '', visibleGroups: groups,
    resultCount: groups.reduce((count, group) => count + group.entries.length, 0), HOME_MENU_CATEGORIES,
    railGesture: {}, closeMenuActions() {}, beginSearch() {}, clearSearch() {}, openCreateOptions() {}, performEntryAction() {}, $emit() {},
  };
}

function kitchenContext(familyOrders, currentDay = today) {
  const declaration = indexSource.match(/const orders = computed\(.*\);/)[0];
  const orders = new Function('computed', 'state', 'today', 'completedMealIds', 'kitchenOrders', `${declaration}; return orders.value;`)(Vue.computed, Vue.ref({ orders: familyOrders }), Vue.ref(currentDay), Vue.ref([]), kitchenOrders);
  return {
    isPendingRecord: () => false, orders, kitchenIntro: kitchenWelcome(orders, currentDay), todayLabel: homeDateLabel(currentDay), today: currentDay, DEFAULT_FAMILY_COVER,
    state: { orders: familyOrders, family: { cover: 'cloud://family-cover', members: [] } }, features: { fridge: false, shopping: false },
    statusLabel: orderStatusLabel, statusNames: { pending: '已安排', accepted: '已安排', completed: '已记录', cancelled: '已取消' }, kitchenOrderAnchor, mealDateLabel,
    preparationByOrder: Object.fromEntries(preparationMeals({ orders: familyOrders }, currentDay).map(order => [order.id, order])),
    orderRows: order => order.items, orderAction() {}, openAdditions() {}, openPreparation() {}, openIngredients() {}, orderRecipe: null, tab: 'activity', mealSection: 'orders', showMenu() { this.tab = 'menu'; },
  };
}

test('menu and kitchen dates omit year and lunar prefix and put the weekday last', () => {
  assert.equal(homeDateLabel(today), '10月22日 · 九月十三 · 周四');
  assert.equal(homeDateLabel('2026-10-23'), '10月23日 · 九月十四 · 周五');
  assert.equal(homeDateLabel('2026-10-25'), '10月25日 · 九月十六 · 周日');
  assert.equal(homeDateLabel('2027-01-01'), '01月01日 · 冬月廿四 · 周五');
  for (const invalid of ['', '2026-02-30', '2026-13-01', '2026-2-01', undefined, null]) assert.equal(homeDateLabel(invalid), '');
});

test('lunar dates handle new year, leap months and 29-day or 30-day month boundaries', () => {
  const dates = [
    ['2026-02-16', '02月16日 · 腊月廿九 · 周一'],
    ['2026-02-17', '02月17日 · 正月初一 · 周二'],
    ['2025-07-24', '07月24日 · 六月三十 · 周四'],
    ['2025-07-25', '07月25日 · 闰六月初一 · 周五'],
    ['2025-08-22', '08月22日 · 闰六月廿九 · 周五'],
    ['2025-08-23', '08月23日 · 七月初一 · 周六'],
    ['2024-02-29', '02月29日 · 正月二十 · 周四'],
  ];
  for (const [date, expected] of dates) assert.equal(homeDateLabel(date), expected);
  assert.equal(homeDateLabel('1900-01-31'), '01月31日 · 正月初一 · 周三');
  assert.equal(homeDateLabel('1899-12-31'), '12月31日 · 周日');
  assert.equal(homeDateLabel('2101-01-01'), '01月01日 · 周六');
});

test('calendar conversion works offline without Intl and never shifts the supplied local day', () => {
  const script = `globalThis.Intl = undefined; const { homeDateLabel } = await import('./src/domain/home-welcome.js'); process.stdout.write(homeDateLabel('2026-10-23'));`;
  for (const timezone of ['Asia/Shanghai', 'America/New_York', 'Pacific/Honolulu']) {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), env: { ...process.env, TZ: timezone }, encoding: 'utf8' });
    assert.equal(output, '10月23日 · 九月十四 · 周五');
  }
});

test('calendar descriptions wrap whole date segments without splitting lunar words or shrinking type', () => {
  const description = homeDateLabel('2026-10-23');
  const context = { $slots: {}, title: '日期', description, calendar: true, compact: true, kitchen: true, cover: '', illustration: DEFAULT_SET_COVER, primaryLabel: '', secondaryLabel: '', coverFrameStyle: () => ({}) };
  const nodes = allNodes(renderWelcome(context, []));
  const date = withClass(nodes, 'home-welcome-date')[0];
  assert.equal(date.props['aria-label'], description);
  assert.deepEqual(withClass(nodes, 'home-welcome-date-part').map(node => node.children), ['10月23日', '· 九月十四', '· 周五']);
  assert.match(welcomeSource, /\.home-welcome-date\s*\{[^}]*display: flex;[^}]*flex-wrap: wrap;/);
  assert.match(welcomeSource, /\.home-welcome-date-part\s*\{[^}]*white-space: nowrap;/);
  assert.match(welcomeSource, /\.is-compact \.home-welcome-description\s*\{[^}]*font-size: var\(--type-meta\);/);
  const ordinary = allNodes(renderWelcome({ ...context, calendar: false, description: '普通说明' }, []));
  assert.equal(withClass(ordinary, 'home-welcome-date').length, 0);
  assert.equal(withClass(ordinary, 'home-welcome-description')[0].children, '普通说明');
});

test('an empty kitchen differs from a kitchen containing only cancelled or completed records', () => {
  assert.deepEqual(kitchenWelcome([], today), { mode: 'empty', title: '还没有安排', recordTitle: '' });
  assert.deepEqual(kitchenWelcome([meal('cancelled')], today), { mode: 'idle', title: '可以继续安排下一餐', recordTitle: '' });
  assert.equal(kitchenWelcome([meal('completed')], today).recordTitle, '已记录');
  assert.equal(kitchenWelcome([meal('completed')], today).title, '可以继续安排下一餐');
  assert.equal(kitchenWelcome([meal('completed'), meal('cancelled')], today).recordTitle, '餐食记录');
  assert.equal(kitchenWelcome([meal('completed'), meal('cancelled')], today).title, '可以继续安排下一餐');
});

test('the header reflects pending and accepted meals without counting cancelled records', () => {
  assert.deepEqual(kitchenWelcome([meal('pending')], today), { mode: 'active', title: '有餐食预定', recordTitle: '' });
  assert.equal(kitchenWelcome([meal('accepted')], today).title, '有餐食预定');
  assert.equal(kitchenWelcome([meal('pending'), meal('cancelled')], today).title, '有餐食预定');
  assert.equal(kitchenWelcome([meal('pending'), meal('accepted'), meal('cancelled')], today).title, '有餐食预定');
  assert.equal(kitchenWelcome([meal('accepted', 'first'), meal('accepted', 'second')], today).title, '有餐食预定');
  assert.equal(kitchenWelcome([meal('accepted'), meal('pending', 'tomorrow', '2026-10-23')], today).title, '有餐食预定');
});

test('tomorrow and day-after reservations activate the header without claiming they are today or history', () => {
  const futureOrders = [meal('pending', 'tomorrow', '2026-10-23'), meal('accepted', 'day-after', '2026-10-24')];
  for (const orders of [futureOrders, [futureOrders[0]], [futureOrders[1]], [meal('completed'), ...futureOrders], [meal('cancelled'), ...futureOrders]]) {
    assert.deepEqual(kitchenWelcome(orders, today), { mode: 'active', title: '有餐食预定', recordTitle: '' });
  }
  assert.equal(kitchenWelcome([meal('pending'), ...futureOrders], today).title, '有餐食预定');
});

test('finishing the last reservation removes the preparation prompt and restoring it brings the prompt back', () => {
  for (const date of [today, '2026-10-23', '2026-10-24']) {
    for (const status of ['completed', 'cancelled']) {
      const finished = Object.freeze([Object.freeze(meal(status, 'finished', date))]);
      assert.equal(kitchenWelcome(finished, today).mode, 'idle');
      assert.equal(kitchenWelcome(finished, today).title, '可以继续安排下一餐');
      assert.equal(kitchenWelcome([...finished, meal('accepted', 'remaining', '2026-10-24')], today).mode, 'active');
      assert.equal(kitchenWelcome([{ ...finished[0], status: 'accepted' }], today).title, '有餐食预定');
      assert.equal(finished[0].status, status);
    }
  }
});

test('reservation labels follow the existing local-day clock without restoring the retired cover', () => {
  const orders = Object.freeze([Object.freeze(meal('pending', 'tomorrow', '2026-10-23'))]);
  for (const [day, label] of [['2026-10-22', '明天'], ['2026-10-23', '今天']]) {
    const nodes = allNodes(renderKitchen(kitchenContext(orders, day), []));
    assert.equal(withClass(nodes, 'order-date-tag')[0].children, label);
    assert.equal(nodes.some(node => node.type === 'HomeWelcome'), false);
  }
  assert.equal(withClass(allNodes(renderKitchen(kitchenContext(orders, '2026-10-24'), [])), 'order-card').length, 0);
  assert.equal(orders[0].date, '2026-10-23');
  assert.match(indexSource, /setInterval\(refreshDay, 60000\)/);
  assert.match(indexSource, /onShow\(refreshDay\)/);
});

test('the welcome state and kitchen cards share the three-day window without deleting out-of-window records', () => {
  const orders = Object.freeze([Object.freeze({ ...meal('cancelled'), date: '2026-10-21' }), Object.freeze({ ...meal('pending'), date: '2026-10-25' })]);
  const original = JSON.stringify(orders);
  assert.deepEqual(kitchenWelcome(orders, today), { mode: 'empty', title: '还没有安排', recordTitle: '' });
  assert.deepEqual(kitchenOrders(orders, today), []);
  assert.equal(JSON.stringify(orders), original);
  assert.equal(kitchenWelcome([meal('pending')], today).mode, 'active');
  assert.equal(kitchenWelcome([meal('cancelled')], today).mode, 'idle');
});

test('a kitchen with only out-of-window records displays the full empty state for all statuses', () => {
  for (const status of ['pending', 'accepted', 'completed', 'cancelled']) {
    const context = kitchenContext([meal(status, `past-${status}`, '2026-09-01')]);
    assert.equal(context.kitchenIntro.mode, 'empty');
    assert.equal(context.kitchenIntro.recordTitle, '');
    const nodes = allNodes(renderKitchen(context, []));
    assert.equal(nodes.some(node => node.type === 'HomeWelcome'), true);
    assert.equal(Boolean(nodes.find(node => node.type === 'HomeWelcome').props.compact), false);
    assert.equal(nodes.find(node => node.type === 'HomeWelcome').props['primary-label'], '看看菜单');
    assert.equal(withClass(nodes, 'order-card').length, 0);
    assert.equal(withClass(nodes, 'kitchen-record-title').length, 0);
    assert.equal(context.state.orders.length, 1);
  }
  assert.equal(kitchenContext([]).kitchenIntro.mode, 'empty');
});

test('completed meals remain visible beside cancelled records so occupied slots have a destination', () => {
  const source = Object.freeze([Object.freeze(meal('completed')), Object.freeze(meal('cancelled'))]);
  const context = kitchenContext(source);
  const nodes = allNodes(renderKitchen(context, []));
  assert.equal(nodes.some(node => node.type === 'HomeWelcome'), false);
  assert.equal(withClass(nodes, 'kitchen-continue').length, 0);
  assert.equal(withClass(nodes, 'order-card').length, 2);
  assert.equal(withClass(nodes, 'kitchen-record-title').length, 0);
  assert.equal(withClass(nodes, 'is-cancelled-summary').length, 2);
  const history = nodes.find(node => node.type === 'MealTimeline');
  assert.equal(history, undefined, 'history only renders in its separate popup');
  assert.deepEqual(nodes.filter(node => node.type === 'OrderActionMenu').map(node => node.props.status).sort(), ['cancelled', 'completed']);
  assert.equal(source.length, 2);
});

test('an empty menu restores the illustrated welcome and its original create and discover actions', () => {
  const emitted = [];
  const context = { ...menuContext(), $emit: (...args) => emitted.push(args) };
  const nodes = allNodes(renderMenu(context, []));
  const welcome = nodes.find(node => node.type === 'HomeWelcome');
  assert.ok(welcome);
  assert.equal(welcome.props.title, '把爱吃的，放进我家菜单');
  assert.equal(welcome.props['primary-label'], '创建菜品');
  assert.equal(welcome.props['secondary-label'], '看看美食');
  assert.equal(withClass(nodes, 'home-menu-tools').length, 0);
  assert.equal(withClass(nodes, 'home-menu-layout').length, 0);
  welcome.props.onPrimary();
  welcome.props.onSecondary();
  assert.deepEqual(emitted, [['create', '荤菜', 'dish'], ['discover']]);
});

test('a populated or searched menu keeps the bounded dual list and the original search controls', () => {
  const entries = [{ id: 'dish', key: 'dish', kind: 'dish', category: '荤菜', title: '家常小炒', ingredients: [] }];
  for (const search of ['', '没有匹配', '小炒']) {
    const nodes = allNodes(renderMenu(menuContext({ entries, search }), []));
    const welcome = nodes.find(node => node.type === 'HomeWelcome');
    assert.equal(welcome, undefined, 'the shared menu/reservation switch replaces the populated menu cover');
    assert.equal(withClass(nodes, 'home-menu-tools').length, 1);
    assert.equal(withClass(nodes, 'home-menu-category').length, HOME_MENU_CATEGORIES.length);
    assert.equal(withClass(nodes, 'home-menu-group').length, search === '没有匹配' ? 0 : 1);
  }
  const clearing = allNodes(renderMenu(menuContext({ search: '不存在' }), []));
  assert.equal(withClass(clearing, 'home-menu-tools').length, 1, 'a retained query stays available to clear even after the last dish is removed');
  assert.equal(withClass(clearing, 'home-menu-empty').length, 1);
});





test('an empty meal list restores the full welcome and original menu action', () => {
  const context = kitchenContext([]);
  const nodes = allNodes(renderKitchen(context, []));
  const welcome = nodes.find(node => node.type === 'HomeWelcome');
  assert.equal(Boolean(welcome.props.compact), false);
  assert.equal(Boolean(welcome.props.kitchen), false);
  assert.equal(welcome.props.title, '还没有安排');
  assert.equal(welcome.props['primary-label'], '看看菜单');
  welcome.props.onPrimary.call(context);
  assert.equal(context.tab, 'menu');
  assert.equal(context.state.orders.length, 0);
});

test('cancelled-only kitchens retain their cards, identities, usage action and member data', () => {
  const orders = [meal('cancelled', 'first'), meal('cancelled', 'second')];
  const nodes = allNodes(renderKitchen(kitchenContext(orders), []));
  const continueAction = withClass(nodes, 'kitchen-continue')[0];
  assert.ok(continueAction, 'a cancelled-only meal list shows a quiet empty-arrangement status');
  assert.equal(withClass(nodes, 'kitchen-idle-title')[0].children, '没有安排');
  assert.equal(allNodes(continueAction).some(node => node.type === 'button'), false);
  assert.equal(withClass(nodes, 'kitchen-date').length, 0);
  assert.equal(withClass(nodes, 'kitchen-record-title').length, 0);
  assert.deepEqual(withClass(nodes, 'order-status').map(node => node.children), ['已取消', '已取消']);
  assert.deepEqual(withClass(nodes, 'order-card').map(node => node.key), ['first:cancelled', 'second:cancelled']);
  assert.equal(withClass(nodes, 'order-usage-button').length, 0);
  assert.equal(withClass(nodes, 'order-add-button').length, 0);
  assert.equal(withClass(nodes, 'order-actions').length, 0);
});

test('one active order keeps its original actions without a header CTA or plan-another footer', () => {
  const context = kitchenContext([meal('pending')]);
  const nodes = allNodes(renderKitchen(context, []));
  const welcome = nodes.find(node => node.type === 'HomeWelcome');
  assert.equal(welcome, undefined);
  assert.equal(withClass(nodes, 'kitchen-date').length, 0);
  assert.equal(withClass(nodes, 'order-card').length, 1);
  assert.equal(withClass(nodes, 'order-add-button').length, 1);
  assert.equal(withClass(nodes, 'order-actions').length, 1);
  assert.equal(withClass(nodes, 'kitchen-record-title').length, 0);
  assert.equal(withClass(nodes, 'kitchen-plan-another').length, 0);
  assert.equal(context.tab, 'activity');
});

test('future-only reservations retain their date-labelled cards and actions without a cover', () => {
  const context = kitchenContext([meal('pending', 'tomorrow', '2026-10-23')]);
  const nodes = allNodes(renderKitchen(context, []));
  const welcome = nodes.find(node => node.type === 'HomeWelcome');
  assert.equal(welcome, undefined);
  assert.equal(withClass(nodes, 'kitchen-date').length, 0);
  assert.equal(withClass(nodes, 'kitchen-record-title').length, 0);
  assert.equal(withClass(nodes, 'kitchen-plan-another').length, 0);
  assert.equal(withClass(nodes, 'order-card')[0].key, 'tomorrow:pending');
  assert.equal(withClass(nodes, 'order-date-tag')[0].children, '明天');
  assert.equal(withClass(nodes, 'order-add-button').length, 1);
  assert.equal(withClass(nodes, 'order-actions').length, 1);
  assert.equal(context.tab, 'activity');
});



test('empty welcome actions render matching navigation icons and keep their original events', () => {
  for (const action of [
    { primaryLabel: '创建菜品', primaryIcon: 'plus-inverse', secondaryLabel: '看看美食', secondaryIcon: 'community' },
    { primaryLabel: '看看菜单', primaryIcon: 'menu-inverse', secondaryLabel: '', secondaryIcon: '' },
  ]) {
    const emitted = [];
    const nodes = allNodes(renderWelcome({ $slots: {}, title: '空态标题', description: '', compact: false, kitchen: false, illustration: DEFAULT_FAMILY_COVER, cover: '', busy: true, coverFrameStyle: () => ({}), ...action, $emit: event => emitted.push(event) }, []));
    assert.equal(withClass(nodes, 'home-welcome-description').length, 0);
    const primary = withClass(nodes, 'primary-button')[0];
    const primaryIcon = allNodes(primary).find(node => node.type === 'AppIcon');
    assert.equal(primary.props.role, 'button');
    assert.equal(primary.props.disabled, true);
    assert.equal(primaryIcon.props.name, action.primaryIcon);
    assert.equal(primaryIcon.props.size, 18);
    assert.equal(primaryIcon.props.active, false);
    assert.ok(read(`static/icon-${action.primaryIcon}.png`).length);
    primary.props.onClick({ stopPropagation() {} });
    if (action.secondaryLabel) {
      const secondary = withClass(nodes, 'secondary-button')[0];
      const secondaryIcon = allNodes(secondary).find(node => node.type === 'AppIcon');
      assert.equal(secondary.props.role, 'button');
      assert.equal(secondaryIcon.props.name, action.secondaryIcon);
      assert.equal(secondaryIcon.props.size, 18);
      assert.equal(secondaryIcon.props.active, '');
      assert.ok(read(`static/icon-${action.secondaryIcon}-active.png`).length);
      assert.equal(allNodes(secondary).some(node => node.type === 'text' && node.children === action.secondaryLabel), true);
      secondary.props.onClick({ stopPropagation() {} });
      assert.deepEqual(emitted, ['primary', 'secondary']);
    } else {
      assert.equal(withClass(nodes, 'secondary-button').length, 0);
      assert.deepEqual(emitted, ['primary']);
    }
  }
});



test('kitchen menu entry is a quiet text action without shrinking its readable type or touch height', () => {
  const styles = postcss.parse(parse(welcomeSource).descriptor.styles[0].content);
  const declarations = selector => {
    const values = new Map();
    styles.walkRules(rule => { if (rule.selector === selector) rule.walkDecls(declaration => values.set(declaration.prop, declaration.value)); });
    return values;
  };
  const button = declarations('.is-kitchen .home-welcome-button');
  assert.equal(button.get('background'), 'transparent');
  assert.equal(button.get('border'), '0');
  assert.equal(button.get('box-shadow'), 'none');
  assert.equal(button.get('color'), 'var(--green)');
  assert.equal(button.get('font-weight'), '400');
  assert.equal(button.get('padding-left'), '0');
  assert.equal(button.get('padding-right'), '4px');
  assert.equal(button.get('white-space'), 'nowrap');
  const compact = declarations('.is-compact .home-welcome-button');
  assert.equal(compact.get('min-height'), '44px');
  assert.equal(compact.get('font-size'), 'var(--type-control)');
  assert.ok(read('static/icon-menu-active.png').length);
  assert.equal(declarations('.home-welcome .home-welcome-button').get('background'), undefined);
});



test('kitchen intro preserves its gap while meal rows join without extra card spacing', () => {
  const spacing = new Map();
  postcss.parse(read('styles.css')).walkRules(rule => {
    if (['.kitchen-intro', '.kitchen-intro.is-empty', '.kitchen-order', '.kitchen-order .order-card'].includes(rule.selector)) {
      rule.walkDecls('margin-bottom', declaration => spacing.set(rule.selector, declaration.value));
    }
  });
  assert.equal(spacing.get('.kitchen-intro'), '12px');
  assert.equal(spacing.get('.kitchen-order'), '0');
  assert.equal(spacing.get('.kitchen-intro.is-empty'), '0');
  assert.equal(spacing.get('.kitchen-order .order-card'), '0');
});

test('welcome images keep golden-ratio frames and native-cover rendering without new asset requests', () => {
  assert.match(welcomeSource, /coverFrameStyle\('family'\)/);
  assert.match(welcomeSource, /<FamilyCoverImage :src="cover" variant="card"/);
  assert.match(welcomeSource, /:src="illustration" mode="aspectFill"/);
  assert.doesNotMatch(welcomeSource, /https?:|cloud\.call|request\(/);
  assert.match(welcomeSource, /hover-class="touch-feedback"/);
});

test('only the selected category is tinted without extending or padding the rail height', () => {
  const styles = postcss.parse(parse(menuSource).descriptor.styles[0].content);
  const declarations = selector => {
    const values = new Map();
    styles.walkRules(rule => { if (rule.selector === selector) rule.walkDecls(declaration => values.set(declaration.prop, declaration.value)); });
    return values;
  };
  assert.equal(declarations('.home-menu-rail').get('background'), 'var(--white)');
  assert.equal(declarations('.home-menu-rail').get('height'), 'var(--home-menu-rail-height)');
  assert.equal(declarations('.home-menu-category').get('min-height'), '48px');
  assert.equal(declarations('.home-menu-category.active').get('background'), 'var(--green-light)');
  assert.equal(declarations('.home-menu-category.active::before').get('width'), '3px');
  assert.match(menuSource, /max\(48px, min\(var\(--home-menu-rail-content-height\)/);
  assert.match(menuSource, /:bounces="false"/);
});
