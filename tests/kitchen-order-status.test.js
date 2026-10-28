import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileTemplate } from '@vue/compiler-sfc';
import { baseParse } from '@vue/compiler-dom';
import * as Vue from 'vue';
import postcss from 'postcss';
import { createKitchenActions } from '../src/domain/actions.js';
import { createSeed } from '../src/data/seed.js';
import { kitchenOrders, mealDateLabel } from '../src/domain/kitchen.js';
import { preparationMeals } from '../src/domain/meal-preparation.js';
import { kitchenOrderAnchor } from '../src/composables/useKitchenFocus.js';
import { NATIVE_UI_COLORS } from '../src/domain/ui-theme.js';
import { hasIngredientManagement } from '../src/domain/navigation.js';
import { isPendingRecord, presentMutation } from '../src/services/mutation-feedback.js';

const source = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8');
const statusNames = new Function(`return ${source.match(/const statusNames = (.*);/)[1]};`)();
const templateNodes = [];
function collect(node) {
  if (node.type !== 1) return;
  templateNodes.push(node);
  node.children.forEach(collect);
}
baseParse(parse(source).descriptor.template.content).children.forEach(collect);
const card = templateNodes.find(node => node.props.some(prop => prop.name === 'class' && prop.value?.content === 'order-card'));
const host = templateNodes.find(node => node.props.some(prop => prop.name === 'class' && prop.value?.content === 'kitchen-order'));
const compiled = compileTemplate({ source: host.loc.source, filename: 'kitchen-order-status.vue', id: 'kitchen-order-status-test' });
assert.deepEqual(compiled.errors, []);
const renderCode = compiled.code.replace(/import \{([^}]+)\} from "vue"/g, (_, imports) => `const {${imports.replace(/ as /g, ': ')}} = Vue;`).replace('export function render', 'return function render');
const renderTemplate = new Function('Vue', renderCode)({ ...Vue, resolveComponent: name => name });
const actionSource = source.match(/async function orderAction\(order, action\) \{[\s\S]*?(?=\nfunction resetDraft)/)[0];

function nodes(node) {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== 'object') return [];
  return [node, ...(Array.isArray(node.children) ? node.children.flatMap(nodes) : typeof node.children?.default === 'function' ? nodes(node.children.default()) : [])];
}

function buttonWithLabel(root, label) {
  return nodes(root).find(node => node.type === 'button' && nodes(node).some(child => child.type === 'text' && child.children === label));
}

function context({ initialStatus = 'pending', fail = false, wait = Promise.resolve(), fridge = true, shopping = true, hasDishes = false, mealDate = '2026-10-21' } = {}) {
  const today = '2026-10-21';
  let currentDate = today;
  const pageDate = Vue.ref(today);
  const state = Vue.ref({
    family: { features: { fridge, shopping }, members: [{ id: 'me', name: '我' }] },
    activeMemberId: 'me',
    inventory: [{ id: 'stock', name: '胡萝卜', quantity: 2, unit: '根' }],
    purchases: [{ id: 'purchase', name: '胡萝卜', quantity: 1, unit: '根', orderIds: ['dinner'] }],
    orders: [
      { id: 'lunch', date: mealDate, meal: '午餐', status: initialStatus, items: hasDishes ? [{ recipe: createSeed().recipes[0], quantity: 1 }] : [] },
      { id: 'dinner', date: today, meal: '晚餐', status: 'pending', items: [] },
      { id: 'old-cancelled', date: today, meal: '早餐', status: 'cancelled', items: [] },
    ],
  });
  const actions = createKitchenActions({ getState: () => state.value, commit: value => { state.value = value; }, newId: () => 'unused', today: () => currentDate });
  const modals = [];
  const messages = [];
  const requests = [];
  const redirects = [];
  const orderSavingId = Vue.ref('');
  const orderFailure = Vue.ref(null);
  const openedOrderId = Vue.ref('');
  const orderActionBusy = Vue.computed(() => Boolean(orderSavingId.value));
  let task = Promise.resolve();
  const bindings = {
    NATIVE_UI_COLORS, hasIngredientManagement, isPendingRecord, presentMutation, orderSavingId, orderFailure, orderActionBusy, openedOrderId, mealDateLabel, today: pageDate,
    refreshDay: () => { pageDate.value = currentDate; },
    tab: Vue.ref('kitchen'),
    openIngredients: (...args) => redirects.push(args),
    features: Vue.computed(() => state.value.family.features),
    uni: { showModal: options => modals.push(options) },
    notify: message => messages.push(message),
    updateOrder: async (id, status) => {
      requests.push({ id, status });
      await wait;
      if (fail) throw new Error(status === 'accepted' ? '恢复失败，请重试' : '取消失败，请重试');
      actions.updateOrder(id, status);
    },
    removeOrder: async id => {
      requests.push({ id, status: 'deleted' });
      await wait;
      if (fail) throw new Error('删除失败，请重试');
      actions.removeOrder(id);
    },
  };
  const perform = new Function(...Object.keys(bindings), `let orderActionRevision = 0;\n${actionSource}\nreturn orderAction;`)(...Object.values(bindings));
  const orderAction = (...args) => { task = perform(...args); return task; };
  function drawNodes() {
    const data = { orders: kitchenOrders(state.value.orders, today), state: state.value, today, features: state.value.family.features, kitchenOrderAnchor, mealDateLabel, statusNames, orderRows: order => order.items, orderAction, orderFailure: orderFailure.value, orderSavingId: orderSavingId.value, orderActionBusy: orderActionBusy.value, openedOrderId: openedOrderId.value, openPreparation: order => redirects.push(['preparation', order.id]), preparationByOrder: Object.fromEntries(preparationMeals(state.value, today).map(order => [order.id, order])), openIngredients: bindings.openIngredients, openAdditions() {}, orderRecipe: null, tab: 'menu' };
    return nodes(renderTemplate(data, []));
  }
  const draw = () => drawNodes().filter(node => node.props?.class?.split(' ').includes('order-card'));
  const drawMenus = () => drawNodes().filter(node => node.type === 'OrderActionMenu');
  const order = () => state.value.orders.find(entry => entry.id === 'lunch');
  return { state, order, orderAction, modals, messages, requests, redirects, orderFailure, orderActionBusy, draw, drawMenus, settled: () => task, advanceDay: value => { currentDate = value; } };
}

test('kitchen action menu owns cancel, restore and delete without duplicating them in the preparing footer', async () => {
  const kitchen = context({ initialStatus: 'accepted' });
  const menu = kitchen.drawMenus()[0];
  assert.equal(menu.props.status, 'accepted');
  assert.equal(typeof menu.props.onRestore, 'function');
  assert.equal(typeof menu.props.onRemove, 'function');
  assert.ok(!nodes(kitchen.draw()[0]).some(node => node.children === '取消这一餐'));
  menu.props.onCancel();
  assert.equal(kitchen.modals.length, 1);
  assert.deepEqual(kitchen.requests, []);
  kitchen.modals[0].success({ confirm: true });
  await kitchen.settled();
  assert.equal(kitchen.order().status, 'cancelled');
  assert.deepEqual(kitchen.requests, [{ id: 'lunch', status: 'cancelled' }]);
});

test('restoring through the cancelled card immediately returns the same meal to preparing', async () => {
  const kitchen = context({ initialStatus: 'cancelled', hasDishes: true });
  const original = structuredClone(Vue.toRaw(kitchen.order()));
  const menu = kitchen.drawMenus().find(node => node.props.label.includes('午餐'));
  assert.equal(menu.props.status, 'cancelled');
  await menu.props.onRestore();
  await kitchen.settled();
  await Vue.nextTick();
  assert.deepEqual(Vue.toRaw(kitchen.order()), { ...original, status: 'accepted' });
  assert.deepEqual(kitchen.requests, [{ id: 'lunch', status: 'accepted' }]);
  assert.deepEqual(kitchen.messages, []);
  assert.deepEqual(kitchen.modals, []);
  assert.deepEqual(kitchen.redirects, []);
  const restored = kitchen.draw().find(node => node.key === 'lunch:accepted');
  assert.doesNotMatch(restored.props.class, /\bis-finished\b/);
  assert.ok(nodes(restored).some(node => node.children === '已预订'));
  assert.ok(nodes(restored).some(node => node.props?.class?.includes('order-add-button')));
});

test('restoration blocks repeated requests until the response and retains the muted card on failure', async () => {
  let finish;
  const kitchen = context({ initialStatus: 'cancelled', hasDishes: true, fail: true, wait: new Promise(resolve => { finish = resolve; }) });
  const restoring = kitchen.orderAction(kitchen.order(), 'accepted');
  await kitchen.orderAction(kitchen.order(), 'accepted');
  assert.equal(kitchen.requests.length, 1);
  assert.ok(kitchen.drawMenus().every(node => node.props.busy));
  assert.equal(kitchen.order().status, 'cancelled');
  finish();
  await restoring;
  assert.equal(kitchen.order().status, 'cancelled');
  assert.match(kitchen.draw().find(node => node.key === 'lunch:cancelled').props.class, /\bis-finished\b/);
  assert.equal(kitchen.orderActionBusy.value, false);
  assert.deepEqual(kitchen.messages, []);
  assert.match(JSON.stringify(kitchen.orderFailure.value), /恢复失败/);
});

test('restoration conflict stays visible beside the unchanged cancelled meal', async () => {
  const kitchen = context({ initialStatus: 'cancelled', hasDishes: true });
  kitchen.state.value.orders.push({ ...kitchen.order(), id: 'rebooked-lunch', status: 'accepted' });
  const before = JSON.stringify(kitchen.state.value.orders);
  await kitchen.orderAction(kitchen.order(), 'accepted');
  assert.equal(JSON.stringify(kitchen.state.value.orders), before);
  assert.deepEqual(kitchen.messages, []);
  assert.match(JSON.stringify(kitchen.orderFailure.value), /不能重复恢复/);
});

test('empty cancelled cards stay in history without dish rows or a restore option', async () => {
  const kitchen = context({ initialStatus: 'cancelled' });
  const card = kitchen.draw().find(node => node.key === 'lunch:cancelled');
  assert.match(card.props.class, /\bis-finished\b/);
  assert.ok(nodes(card).some(node => node.children === '本餐暂无菜品'));
  const list = nodes(card).find(node => node.type === 'MealDishList');
  assert.deepEqual(list.props.rows, []);
  assert.equal(list.props.editable, false);
  const menu = kitchen.drawMenus().find(node => node.props.label.includes('午餐'));
  assert.equal(menu.props['has-dishes'], false);
  assert.equal(nodes(card).some(node => node.props?.class === 'order-actions'), false);
  await kitchen.orderAction(kitchen.order(), 'accepted');
  assert.equal(kitchen.order().status, 'cancelled');
  assert.deepEqual(kitchen.order().items, []);
  assert.match(kitchen.orderFailure.value.message, /没有菜品.*重新预订/);
});

test('add-dish whitespace is tightened without reducing the forty-four-pixel tap target', () => {
  const sheet = postcss.parse(readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8'));
  const selectors = new Map(['.order-card .meal-dish-list', '.order-actions', '.order-add-button'].map(selector => [selector, new Map()]));
  sheet.walkRules(rule => {
    for (const selector of rule.selectors) {
      if (selectors.has(selector)) rule.walkDecls(declaration => selectors.get(selector).set(declaration.prop, declaration.value));
    }
  });
  assert.equal(selectors.get('.order-card .meal-dish-list').get('margin-bottom'), '0');
  assert.equal(selectors.get('.order-actions').get('margin-top'), '0');
  assert.equal(selectors.get('.order-actions').get('padding-top'), '8px');
  assert.equal(selectors.get('.order-add-button').get('min-height'), '44px');
  assert.equal(selectors.get('.order-add-button').get('min-width'), '44px');
});

for (const [initialStatus, label] of [['pending', '已预订'], ['accepted', '已预订'], ['completed', '已开饭'], ['cancelled', '已取消']]) {
  test(`${initialStatus} meal renders a non-interactive status badge without an unused quantity toolbar`, () => {
    const kitchen = context({ initialStatus });
    const renderedCard = kitchen.draw().find(node => node.key === `lunch:${initialStatus}`);
    const children = nodes(renderedCard);
    const badge = children.find(node => node.props?.class?.split(' ').includes('order-status'));
    assert.equal(badge.type, 'text');
    assert.equal(badge.children, label);
    assert.ok(badge.props.class.split(' ').includes(initialStatus));
    assert.equal(renderedCard.props.class.split(' ').includes('is-finished'), ['completed', 'cancelled'].includes(initialStatus));
    assert.doesNotMatch(renderedCard.props.class, /is-focused/);
    assert.equal(badge.props.onClick, undefined);
    assert.equal(children.some(node => node.props?.class?.split(' ').includes('order-actions')), ['pending', 'accepted'].includes(initialStatus));
    assert.equal(Boolean(buttonWithLabel(renderedCard, '加菜')), ['pending', 'accepted'].includes(initialStatus));
    assert.equal(children.some(node => node.props?.class?.split(' ').includes('order-tools')), false);
    assert.ok(!children.some(node => ['点餐中', '开始备菜', '做好了', '去备菜'].includes(node.children)));
    assert.ok(!children.some(node => node.children === '备菜用量'));
    assert.ok(children.some(node => node.type === 'MealDishList' && typeof node.props.onOpen === 'function'));
  });
}

test('opening a meal immediately moves its finished card below the remaining preparation without navigation', async () => {
  const kitchen = context({ initialStatus: 'accepted' });
  const before = kitchen.draw();
  await kitchen.orderAction(kitchen.order(), 'completed');
  await Vue.nextTick();
  const after = kitchen.draw();
  assert.equal(kitchen.order().status, 'completed');
  assert.ok(kitchen.order().completedAt);
  assert.equal(after[0].key, before[1].key);
  assert.equal(after[1].key, 'lunch:completed');
  assert.equal(after[2].key, before[2].key);
  assert.match(after[1].props.class, /\bis-finished\b/);
  assert.ok(nodes(after[1]).some(node => node.children === '已开饭'));
});

for (const initialStatus of ['pending', 'accepted']) {
  test(`a ${initialStatus} meal gets fresh card identity and cancelled styling in the same update`, async () => {
    const kitchen = context({ initialStatus });
    const before = kitchen.draw();
    const inventory = structuredClone(Vue.toRaw(kitchen.state.value.inventory));
    const purchases = structuredClone(Vue.toRaw(kitchen.state.value.purchases));
    kitchen.orderAction(kitchen.order(), 'cancelled');
    assert.deepEqual(kitchen.requests, []);
    assert.equal(kitchen.modals.length, 1);
    kitchen.modals[0].success({ confirm: true });
    await kitchen.settled();
    await Vue.nextTick();
    const after = kitchen.draw();
    assert.equal(kitchen.order().status, 'cancelled');
    assert.deepEqual(kitchen.requests, [{ id: 'lunch', status: 'cancelled' }]);
    assert.deepEqual(kitchen.messages, []);
    assert.equal(after[0].key, before[1].key, 'the other active meal keeps its existing view');
    assert.equal(after[2].key, before[2].key, 'the previously cancelled meal keeps its existing view below the newer cancellation');
    assert.notEqual(after[1].key, before[0].key, 'the changed meal must not reuse the uncancelled native card after sorting');
    assert.match(after[1].props.class, /\bis-finished\b/);
    assert.ok(nodes(after[1]).some(node => node.children === '已取消'));
    assert.ok(!nodes(after[1]).some(node => typeof node.children === 'string' && ['取消这一餐', '采购', '开饭', '加菜'].includes(node.children)));
    assert.deepEqual(Vue.toRaw(kitchen.state.value.inventory), inventory);
    assert.deepEqual(Vue.toRaw(kitchen.state.value.purchases), purchases);
  });
}

test('cancelling the confirmation leaves every card and order untouched', async () => {
  const kitchen = context();
  const before = kitchen.draw().map(node => [node.key, node.props.class]);
  kitchen.orderAction(kitchen.order(), 'cancelled');
  kitchen.modals[0].success({ confirm: false });
  await kitchen.settled();
  assert.deepEqual(kitchen.requests, []);
  assert.deepEqual(kitchen.messages, []);
  assert.deepEqual(kitchen.draw().map(node => [node.key, node.props.class]), before);
});

test('a failed cancellation does not falsely gray out a still-active meal', async () => {
  const kitchen = context({ fail: true });
  const before = kitchen.draw().map(node => [node.key, node.props.class]);
  kitchen.orderAction(kitchen.order(), 'cancelled');
  kitchen.modals[0].success({ confirm: true });
  await kitchen.settled();
  assert.equal(kitchen.order().status, 'pending');
  assert.deepEqual(kitchen.draw().map(node => [node.key, node.props.class]), before);
  assert.deepEqual(kitchen.messages, []);
  assert.equal(kitchen.orderFailure.value.message, '取消失败，请重试');
  assert.equal(kitchen.orderActionBusy.value, false);
});

test('the card changes as soon as cancellation succeeds without waiting for a tab switch', async () => {
  let complete;
  const wait = new Promise(resolve => { complete = resolve; });
  const kitchen = context({ wait, fridge: false, shopping: false });
  const before = kitchen.draw()[0];
  kitchen.orderAction(kitchen.order(), 'cancelled');
  kitchen.modals[0].success({ confirm: true });
  assert.equal(kitchen.draw()[0].key, before.key);
  assert.doesNotMatch(kitchen.draw()[0].props.class, /\bis-finished\b/);
  complete();
  await kitchen.settled();
  const cancelled = kitchen.draw()[2];
  assert.notEqual(cancelled.key, before.key);
  assert.match(cancelled.props.class, /\bis-finished\b/);
});

test('unchanged status keeps card identity across snapshots and unrelated updates', () => {
  const kitchen = context();
  const before = kitchen.draw().map(node => node.key);
  kitchen.state.value = structuredClone(Vue.toRaw(kitchen.state.value));
  kitchen.state.value.orders[0].note = '少放辣';
  kitchen.state.value.family.members[0].name = '新的昵称';
  assert.deepEqual(kitchen.draw().map(node => node.key), before);
  assert.equal(new Set(before).size, before.length);
});

for (const features of [{ fridge: false, shopping: false }, { fridge: true, shopping: false }, { fridge: false, shopping: true }, { fridge: true, shopping: true }]) {
  for (const initialStatus of ['pending', 'accepted']) {
    test(`preparation directly opens this ${initialStatus} meal independently of fridge settings: ${JSON.stringify(features)}`, () => {
      const kitchen = context({ ...features, initialStatus });
      const renderedCard = kitchen.draw()[0];
      const footer = nodes(renderedCard).find(node => node.props?.class === 'order-actions');
      const add = buttonWithLabel(renderedCard, '加菜');
      assert.equal(footer.children[0], add);
      assert.match(add.props.class, /order-add-button/);
      assert.equal(add.props['aria-label'], '给今天午餐加菜');
      assert.equal(add.props.disabled, false);
      assert.equal(nodes(add).find(node => node.type === 'AppIcon').props.name, 'plus');
      const progress = footer.children[1];
      assert.equal(progress.props.class, 'order-progress-actions');
      const preparation = buttonWithLabel(progress, '备菜 0/0');
      assert.ok(preparation);
      assert.equal(buttonWithLabel(progress, '采购'), undefined);
      const icon = nodes(preparation).find(node => node.type === 'AppIcon');
      assert.equal(icon.props.name, 'chef');
      assert.equal(icon.props.size, 16);
      preparation.props.onClick();
      assert.equal(kitchen.order().status, initialStatus);
      assert.deepEqual(kitchen.requests, []);
      assert.deepEqual(kitchen.redirects, [['preparation', 'lunch']]);
      const serve = buttonWithLabel(progress, '开饭');
      assert.match(serve.props.class, /primary-button/);
      assert.equal(serve.props.disabled, false);
      const serveIcon = nodes(serve).find(node => node.type === 'AppIcon');
      assert.equal(serveIcon.props.name, 'menu-inverse');
      assert.equal(serveIcon.props.size, 16);
      assert.equal(kitchen.orderActionBusy.value, false);
    });
  }
}

test('pending and accepted meals can complete without visiting procurement', async () => {
  for (const initialStatus of ['pending', 'accepted']) {
    const kitchen = context({ initialStatus });
    const stock = JSON.stringify(kitchen.state.value.inventory);
    const before = kitchen.draw()[0];
    assert.ok(nodes(before).some(node => node.children === '开饭'));
    await kitchen.orderAction(kitchen.order(), 'completed');
    assert.equal(kitchen.order().status, 'completed');
    const completed = kitchen.draw().find(node => node.key === 'lunch:completed');
    assert.match(completed.props.class, /\bis-finished\b/);
    assert.notEqual(completed.key, before.key);
    assert.deepEqual(kitchen.redirects, []);
    assert.deepEqual(kitchen.messages, []);
    assert.equal(JSON.stringify(kitchen.state.value.inventory), stock);
  }
});

test('tomorrow and the following day keep a tappable serve button that only shows a short toast', async () => {
  for (const initialStatus of ['pending', 'accepted']) {
    for (const mealDate of ['2026-10-22', '2026-10-23']) {
      const kitchen = context({ initialStatus, mealDate });
      const before = structuredClone(Vue.toRaw(kitchen.state.value));
      const renderedCard = kitchen.draw().find(node => node.key === `lunch:${initialStatus}`);
      const serve = buttonWithLabel(renderedCard, '开饭');
      assert.equal(serve.props.disabled, false);
      serve.props.onClick();
      await kitchen.settled();
      assert.deepEqual(kitchen.messages, ['只能当天开饭']);
      assert.deepEqual(kitchen.modals, []);
      assert.deepEqual(kitchen.requests, []);
      assert.deepEqual(kitchen.state.value, before);
      assert.equal(kitchen.orderActionBusy.value, false);
      assert.equal(kitchen.orderFailure.value, null);
    }
  }
});

test('serving refreshes the date before checking a kitchen left open across midnight', async () => {
  const yesterday = context({ initialStatus: 'accepted' });
  yesterday.advanceDay('2026-10-22');
  await yesterday.orderAction(yesterday.order(), 'completed');
  assert.deepEqual(yesterday.messages, ['只能当天开饭']);
  assert.deepEqual(yesterday.requests, []);
  assert.equal(yesterday.order().status, 'accepted');

  const tomorrow = context({ initialStatus: 'accepted', mealDate: '2026-10-22' });
  await tomorrow.orderAction(tomorrow.order(), 'completed');
  tomorrow.advanceDay('2026-10-22');
  await tomorrow.orderAction(tomorrow.order(), 'completed');
  assert.equal(tomorrow.order().status, 'completed');
  assert.equal(tomorrow.requests.length, 1);
  assert.deepEqual(tomorrow.messages, ['只能当天开饭']);
});

test('the serving date guard does not block cancelling a future meal', async () => {
  const kitchen = context({ initialStatus: 'accepted', mealDate: '2026-10-23' });
  const cancelling = kitchen.orderAction(kitchen.order(), 'cancelled');
  assert.equal(kitchen.modals.length, 1);
  kitchen.modals[0].success({ confirm: true });
  await cancelling;
  assert.equal(kitchen.order().status, 'cancelled');
  assert.deepEqual(kitchen.messages, []);
});

test('a failed serve stays preparing in the kitchen and keeps its inline retry feedback', async () => {
  const kitchen = context({ initialStatus: 'accepted', fail: true });
  await kitchen.orderAction(kitchen.order(), 'completed');
  assert.equal(kitchen.order().status, 'accepted');
  assert.doesNotMatch(kitchen.draw()[0].props.class, /\bis-finished\b/);
  assert.deepEqual(kitchen.redirects, []);
  assert.ok(kitchen.orderFailure.value);
  assert.equal(kitchen.orderActionBusy.value, false);
});

test('repeated taps while a kitchen update is pending cannot advance the same meal twice', async () => {
  let finish;
  const kitchen = context({ wait: new Promise(resolve => { finish = resolve; }) });
  const pending = kitchen.orderAction(kitchen.order(), 'completed');
  await kitchen.orderAction(kitchen.order(), 'completed');
  assert.equal(kitchen.requests.length, 1);
  const footer = nodes(kitchen.draw()[0]).find(node => node.props?.class === 'order-actions');
  for (const label of ['加菜', '备菜 0/0', '开饭']) assert.equal(buttonWithLabel(footer, label).props.disabled, true);
  finish();
  await pending;
  assert.equal(kitchen.order().status, 'completed');
});

test('add dishes shares the compact footer with right-aligned progress actions', () => {
  const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(styles, /\.order-tools\b/);
  assert.match(styles, /\.order-actions\s+\.text-button\s*\{[^}]*margin-right:\s*auto/);
  assert.match(styles, /\.order-progress-actions\s*\{[^}]*margin-left:\s*auto/);
  assert.match(styles, /\.order-add-button\s*\{[^}]*flex-shrink:\s*0;[^}]*padding:\s*0;/);
  assert.match(styles, /\.order-status\.pending,\s*\.order-status\.accepted\s*\{[^}]*background:\s*var\(--warning-light\)/);
});

test('kitchen notes stay above the single footer instead of splitting its actions', () => {
  const kitchen = context({ initialStatus: 'accepted' });
  kitchen.order().note = '少放辣';
  const children = kitchen.draw()[0].children;
  const noteIndex = children.findIndex(node => node.props?.class === 'order-note');
  const footerIndex = children.findIndex(node => node.props?.class === 'order-actions');
  assert.ok(noteIndex >= 0);
  assert.equal(footerIndex, noteIndex + 1);
});

test('fixed date and meal tones differ from every status tone with readable labels', () => {
  const sheet = postcss.parse(readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8'));
  const declarations = new Map();
  sheet.walkRules(rule => {
    for (const selector of rule.selectors) {
      if (!declarations.has(selector)) declarations.set(selector, new Map());
      rule.walkDecls(declaration => declarations.get(selector).set(declaration.prop, declaration.value));
    }
  });
  const palette = declarations.get(':root');
  function resolve(value) {
    const token = value.match(/^var\((--[\w-]+)\)$/);
    return token ? resolve(palette.get(token[1])) : value;
  }
  function tone(selector, property) { return resolve(declarations.get(selector).get(property)); }
  function luminance(hex) {
    const linear = hex.slice(1).match(/.{2}/g).map(channel => {
      const value = parseInt(channel, 16) / 255;
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    });
    return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
  }
  for (const property of ['color', 'background']) {
    const date = tone('.order-date-tag', property);
    const meal = tone('.order-meal-tag', property);
    assert.notEqual(date, meal);
    for (const status of ['pending', 'accepted', 'completed', 'cancelled']) {
      const value = tone(`.order-status.${status}`, property);
      assert.notEqual(value, date, `${status} must not use the date ${property}`);
      assert.notEqual(value, meal, `${status} must not use the meal ${property}`);
    }
  }
  for (const selector of ['.order-date-tag', '.order-meal-tag', ...['pending', 'accepted', 'completed', 'cancelled'].map(status => `.order-status.${status}`)]) {
    const contrast = (luminance(tone(selector, 'background')) + .05) / (luminance(tone(selector, 'color')) + .05);
    assert.ok(contrast >= 4.5, `${selector} contrast is ${contrast.toFixed(2)}`);
  }
});

test('finished cards share a click-through veil while keeping photo colors and readable semantic labels', () => {
  const sheet = postcss.parse(readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8'));
  function declarations(selector) {
    const values = new Map();
    sheet.walkRules(rule => {
      if (rule.selectors.includes(selector)) rule.walkDecls(declaration => values.set(declaration.prop, declaration.value));
    });
    return values;
  }
  assert.equal(declarations('.order-card').get('background'), 'var(--white)');
  assert.equal(declarations('.order-card').get('position'), 'relative');
  const finished = declarations('.order-card.is-finished');
  assert.equal(finished.get('background'), 'var(--paper)');
  assert.equal(finished.get('color'), 'var(--ink)');
  assert.equal(finished.get('isolation'), 'isolate');
  assert.equal(finished.has('opacity'), false);
  assert.equal(finished.has('filter'), false);
  assert.equal(declarations('.order-card::after').size, 0);
  const veil = declarations('.order-card.is-finished::after');
  assert.equal(veil.get('content'), "''");
  assert.equal(veil.get('position'), 'absolute');
  assert.equal(veil.get('inset'), '0');
  assert.equal(veil.get('z-index'), '1');
  assert.equal(veil.get('border-radius'), 'inherit');
  assert.equal(veil.get('background'), 'var(--paper)');
  assert.equal(veil.get('pointer-events'), 'none');
  const opacity = Number(veil.get('opacity'));
  assert.equal(opacity, .4);
  for (const selector of ['.order-tag', '.order-status', '.dish-set-tags > text', '.meal-dish-photo', '.dish-avatars', '.dish-avatar']) {
    assert.equal(declarations(`.order-card.is-finished ${selector}`).size, 0, `${selector} must share the veil, not a separate gray treatment`);
  }
  const palette = new Map([...declarations(':root'), ...finished]);
  function resolveColor(value) {
    const token = value.match(/^var\((--[\w-]+)\)$/);
    return token ? resolveColor(palette.get(token[1])) : value;
  }
  function channels(value) {
    return resolveColor(value).slice(1).match(/.{2}/g).map(channel => parseInt(channel, 16));
  }
  const veilColor = channels(veil.get('background'));
  function luminance(value) {
    const linear = channels(value).map((channel, index) => {
      const composited = (channel * (1 - opacity) + veilColor[index] * opacity) / 255;
      return composited <= .04045 ? composited / 12.92 : ((composited + .055) / 1.055) ** 2.4;
    });
    return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
  }
  const labelPairs = [
    ['dish title', 'var(--ink)', 'var(--paper)'],
    ['voters and notes', 'var(--muted)', 'var(--paper)'],
    ['set label', 'var(--green)', 'var(--paper)']
  ];
  for (const selector of ['.order-date-tag', '.order-meal-tag', '.order-status.completed', '.order-status.cancelled']) {
    const label = declarations(selector);
    labelPairs.push([selector, label.get('color'), label.get('background')]);
  }
  assert.notEqual(resolveColor(declarations('.order-status.completed').get('color')), resolveColor(declarations('.order-status.cancelled').get('color')));
  for (const [label, foreground, background] of labelPairs) {
    const contrast = (luminance(background) + .05) / (luminance(foreground) + .05);
    assert.ok(contrast >= 4.5, `${label} stays readable through the whole-card veil: ${contrast.toFixed(2)}`);
  }
});

test('revealing an order keeps its scroll anchor without a persistent selected-card border', () => {
  const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(styles, /\.order-card\.is-focused/);
  assert.doesNotMatch(card.loc.source, /is-focused|focusedOrderId/);
  assert.match(host.loc.source, /:id="kitchenOrderAnchor\(orderIndex\)"/);
  assert.match(source, /kitchenFocus\.focus\(orderId\)/);
});

for (const initialStatus of ['pending', 'accepted', 'completed', 'cancelled']) {
  test(`${initialStatus} meal deletion confirms the whole-family impact and removes only after success`, async () => {
    const kitchen = context({ initialStatus });
    const before = kitchen.draw().map(node => node.key);
    kitchen.orderAction(kitchen.order(), 'deleted');
    assert.equal(kitchen.modals.length, 1);
    assert.equal(kitchen.modals[0].title, '删除今天午餐？');
    assert.equal(kitchen.modals[0].confirmText, '删除');
    assert.equal(kitchen.modals[0].cancelText, '保留');
    assert.equal(kitchen.modals[0].confirmColor, NATIVE_UI_COLORS.danger);
    assert.match(kitchen.modals[0].content, /所有家人.*备菜.*开火记录.*菜谱和冰箱不受影响.*重新预定/);
    assert.deepEqual(kitchen.requests, []);
    assert.deepEqual(kitchen.draw().map(node => node.key), before);
    kitchen.modals[0].success({ confirm: true });
    await kitchen.settled();
    assert.deepEqual(kitchen.requests, [{ id: 'lunch', status: 'deleted' }]);
    assert.equal(kitchen.order(), undefined);
    assert.equal(kitchen.draw().length, before.length - 1);
    assert.deepEqual(kitchen.messages, []);
    assert.equal(kitchen.orderActionBusy.value, false);
  });
}

test('keeping a meal or failing to open deletion confirmation leaves all data unchanged', async () => {
  for (const outcome of ['keep', 'modal-failure']) {
    const kitchen = context();
    const before = JSON.stringify(kitchen.state.value);
    kitchen.orderAction(kitchen.order(), 'deleted');
    if (outcome === 'keep') kitchen.modals[0].success({ confirm: false });
    else kitchen.modals[0].fail();
    await kitchen.settled();
    assert.deepEqual(kitchen.requests, []);
    assert.equal(JSON.stringify(kitchen.state.value), before);
    assert.equal(kitchen.orderActionBusy.value, false);
  }
});

test('failed deletion keeps the original card and exposes an inline retry message', async () => {
  const kitchen = context({ fail: true });
  const before = JSON.stringify(kitchen.state.value);
  kitchen.orderAction(kitchen.order(), 'deleted');
  kitchen.modals[0].success({ confirm: true });
  await kitchen.settled();
  assert.equal(JSON.stringify(kitchen.state.value), before);
  assert.deepEqual(kitchen.orderFailure.value, { id: 'lunch', message: '删除失败，请重试' });
  assert.ok(nodes(kitchen.draw()[0]).some(node => node.props?.role === 'alert' && node.children === '删除失败，请重试'));
  assert.equal(kitchen.orderActionBusy.value, false);
});

test('pending deletion keeps its card visible and blocks a second mutation', async () => {
  let finish;
  const kitchen = context({ wait: new Promise(resolve => { finish = resolve; }) });
  const deletion = kitchen.orderAction(kitchen.order(), 'deleted');
  kitchen.modals[0].success({ confirm: true });
  await Vue.nextTick();
  await kitchen.orderAction(kitchen.order(), 'completed');
  assert.equal(kitchen.requests.length, 1);
  assert.ok(kitchen.order());
  assert.equal(kitchen.orderActionBusy.value, true);
  finish();
  await deletion;
  assert.equal(kitchen.order(), undefined);
});
