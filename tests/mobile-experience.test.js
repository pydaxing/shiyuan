import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@vue/compiler-sfc';
import { baseParse } from '@vue/compiler-dom';
import { compile } from '@dcloudio/uni-mp-compiler';
import { createSeed } from '../src/data/seed.js';
import { MEALS, reservationDays, validateReservation, mealDateLabel, kitchenOrders, shoppingOrders, validateRecipe, normalizeSnapshot, makeOrder } from '../src/domain/kitchen.js';
import { cleanSteps, stepImages } from '../src/domain/presentation.js';
import { fieldScrollTop, keyboardLayout } from '../src/domain/mobile.js';
import { cookingMonth } from '../src/domain/cooking-diary.js';
import { portableShare } from '../src/services/sharing.js';

const recipe = createSeed().recipes[0];
const image = '/static/tomato.png';

test('reservation labels cover exactly three local days across months, years and leap days', () => {
  assert.deepEqual(reservationDays('2026-12-31'), [{ label: '今天', date: '2026-12-31' }, { label: '明天', date: '2027-01-01' }, { label: '后天', date: '2027-01-02' }]);
  assert.equal(reservationDays('2024-02-28')[1].date, '2024-02-29');
  assert.equal(reservationDays('2025-02-28')[1].date, '2025-03-01');
  assert.equal(mealDateLabel('2027-01-01', '2026-12-31'), '明天');
});

test('reservation guard accepts late-night meals and rejects past or out-of-window slots', () => {
  assert.deepEqual(MEALS, ['早餐', '午餐', '晚餐', '宵夜']);
  for (const { date } of reservationDays('2026-09-08')) for (const meal of MEALS) assert.doesNotThrow(() => validateReservation({ date, meal }, '2026-09-08'));
  for (const date of ['2026-09-07', '2026-09-11', '2026-02-30', 'tomorrow']) assert.throws(() => validateReservation({ date, meal: '宵夜' }, '2026-09-08'), /只能预订/);
  assert.throws(() => validateReservation({ date: '2026-09-08', meal: '下午茶' }, '2026-09-08'), /餐次/);
});

test('kitchen sorts unfinished meals chronologically and keeps both ended states at the end of the visible window', () => {
  const orders = [{ id: 'tomorrow', date: '2026-09-09', meal: '晚餐', status: 'pending' }, { id: 'history', date: '2026-09-07', meal: '午餐', status: 'completed' }, { id: 'late', date: '2026-09-08', meal: '宵夜', status: 'accepted' }, { id: 'lunch', date: '2026-09-08', meal: '午餐', status: 'pending' }, { id: 'cancel', date: '2026-09-08', meal: '早餐', status: 'cancelled', cancelledAt: '2026-09-08T08:00:00Z' }, { id: 'cooked', date: '2026-09-08', meal: '晚餐', status: 'completed', completedAt: '2026-09-08T09:00:00Z' }];
  assert.deepEqual(kitchenOrders(orders, '2026-09-08').map((order) => order.id), ['lunch', 'late', 'tomorrow', 'cooked', 'cancel']);
  assert.equal(orders[0].id, 'tomorrow');
});

test('all three days use breakfast-to-late-night order followed by mixed finished meals in reverse operation order', () => {
  for (const today of ['2026-10-22', '2026-12-31', '2024-02-28']) {
    const days = reservationDays(today);
    const scheduled = days.flatMap(({ date }, dayIndex) => MEALS.map((meal, mealIndex) => ({ id: `scheduled-${date}-${meal}`, date, meal, status: ['pending', 'accepted'][(dayIndex + mealIndex) % 2] })));
    const finished = scheduled.map((order, index) => ({ ...order, id: `finished-${order.id}`, status: index % 2 ? 'cancelled' : 'completed', [index % 2 ? 'cancelledAt' : 'completedAt']: new Date(Date.parse(`${today}T00:00:00Z`) + index * 60000).toISOString() }));
    const expected = [...scheduled, ...finished.reverse()];
    const input = Object.freeze([...expected].reverse().map(order => Object.freeze(order)));
    const before = JSON.stringify(input);
    const sorted = kitchenOrders(input, today);
    assert.deepEqual(sorted.map(order => order.id), expected.map(order => order.id));
    assert.equal(JSON.stringify(input), before);
    assert.ok(sorted.every(order => input.includes(order)), 'sorting preserves existing card objects and all member data');
    assert.deepEqual(shoppingOrders(input, today).map(order => order.id), scheduled.map(order => order.id));
  }
});

test('kitchen includes every status only on today, tomorrow and the day after without removing stored records', () => {
  for (const today of ['2026-10-26', '2026-12-31', '2024-02-28']) {
    const days = reservationDays(today);
    const dates = ['2023-12-31', ...days.map(day => day.date), '2027-12-31'];
    const orders = Object.freeze(dates.flatMap(date => ['pending', 'accepted', 'completed', 'cancelled'].map(status => Object.freeze({
      id: `${date}-${status}`, date, status, meal: '午餐', completedAt: `${today}T10:00:00Z`, cancelledAt: `${today}T11:00:00Z`,
    }))));
    const before = JSON.stringify(orders);
    const visible = kitchenOrders(orders, today);
    assert.equal(visible.length, 12);
    assert.deepEqual(new Set(visible.map(order => order.date)), new Set(days.map(day => day.date)));
    for (const day of days) {
      assert.equal(visible.filter(order => order.date === day.date).length, 4);
      assert.equal(mealDateLabel(day.date, today), day.label);
    }
    assert.ok(visible.every(order => orders.includes(order)));
    assert.equal(JSON.stringify(orders), before);
  }
});

test('kitchen window and relative day labels advance together across midnight', () => {
  const orders = ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'].map(date => ({ id: date, date, meal: '晚餐', status: 'pending' }));
  assert.deepEqual(kitchenOrders(orders, '2026-10-26').map(order => order.id), ['2026-10-26', '2026-10-27', '2026-10-28']);
  const nextDay = kitchenOrders(orders, '2026-10-27');
  assert.deepEqual(nextDay.map(order => order.id), ['2026-10-27', '2026-10-28', '2026-10-29']);
  assert.deepEqual(nextDay.map(order => mealDateLabel(order.date, '2026-10-27')), ['今天', '明天', '后天']);
  assert.equal(orders.length, 5);
});

for (const status of ['cancelled', 'completed']) test(`${status} moves a meal behind all unfinished days and ahead of previously ended meals`, () => {
  const today = '2026-10-22';
  const orders = [
    { id: 'today-dinner', date: today, meal: '晚餐', status: 'pending' },
    { id: 'tomorrow-breakfast', date: '2026-10-23', meal: '早餐', status: 'accepted' },
    { id: 'day-after-breakfast', date: '2026-10-24', meal: '早餐', status: 'pending' },
    { id: 'cancelled-tomorrow', date: '2026-10-23', meal: '午餐', status: 'cancelled', cancelledAt: '2026-10-22T03:00:00Z' },
    { id: 'completed-today', date: today, meal: '午餐', status: 'completed', completedAt: '2026-10-22T02:00:00Z' },
  ];
  const updated = orders.map(order => order.id === 'today-dinner' ? { ...order, status, [status === 'cancelled' ? 'cancelledAt' : 'completedAt']: '2026-10-22T04:00:00Z' } : order);
  assert.deepEqual(kitchenOrders(updated, today).map(order => order.id), ['tomorrow-breakfast', 'day-after-breakfast', 'today-dinner', 'cancelled-tomorrow', 'completed-today']);
  assert.equal(orders[0].status, 'pending');
});

test('late-night orders survive persistence and appear in cooking diary', () => {
  const seed = createSeed();
  const order = { ...makeOrder({ id: 'late', recipes: seed.recipes, cart: { tomato: 1 }, member: seed.family.members[0], date: '2026-09-08', meal: '宵夜' }), status: 'completed' };
  const saved = normalizeSnapshot({ ...seed, orders: [order] });
  assert.equal(saved.orders[0].meal, '宵夜');
  assert.equal(cookingMonth(saved.orders, '2026-09').days[7].meals[0].name, '宵夜');
});

test('multi-photo steps retain order, accept photo-only steps and preserve old single photos', () => {
  const steps = cleanSteps([{ title: ' 洗净 ', images: [image, '/static/chicken.png'] }, { images: [image] }, { image }, { images: [] }]);
  assert.equal(steps.length, 3);
  assert.deepEqual(steps[0].images, [image, '/static/chicken.png']);
  assert.doesNotThrow(() => validateRecipe({ ...recipe, steps }));
  assert.deepEqual(stepImages(steps[2]), [image]);
  assert.deepEqual(stepImages({ image, images: [] }), []);
  const snapshot = normalizeSnapshot({ ...createSeed(), recipes: [{ ...recipe, steps }] });
  assert.deepEqual(snapshot.recipes[0].steps, steps);
});

test('step image validation rejects more than nine images and invalid paths or types', () => {
  assert.doesNotThrow(() => validateRecipe({ ...recipe, steps: [{ images: Array(9).fill(image) }] }));
  for (const images of [Array(10).fill(image), ['wxfile://tmp/gone.jpg'], [null], [''], [42], 'bad', {}]) assert.throws(() => validateRecipe({ ...recipe, steps: [{ title: '做法', images }] }));
});

test('portable sharing embeds every step photo rather than leaving device-local paths', async () => {
  const paths = [];
  const platform = { getFileSystemManager: () => ({ readFile(options) { paths.push(options.filePath); options.success({ data: 'YWJj' }); } }) };
  const shared = JSON.parse(await portableShare({ ...recipe, steps: [{ images: ['wxfile://usr/one.jpg', 'wxfile://usr/two.png', image] }] }, [], '家人', 'dish', platform));
  assert.deepEqual(paths, ['wxfile://usr/one.jpg', 'wxfile://usr/two.png']);
  assert.deepEqual(shared.recipes[0].steps[0].images, ['data:image/jpeg;base64,YWJj', 'data:image/png;base64,YWJj', image]);
});

test('keyboard layout leaves status-bar space and restores when keyboard closes', () => {
  assert.deepEqual(keyboardLayout(844, 336, 54), { bottom: 336, maxHeight: 454 });
  assert.deepEqual(keyboardLayout(667, 300, 24), { bottom: 300, maxHeight: 343 });
  assert.deepEqual(keyboardLayout(844, 0, 54), { bottom: 0, maxHeight: 790 });
});

test('input reveal scrolls only as far as necessary and aligns oversized fields at their top', () => {
  const viewport = { top: 120, bottom: 430 };
  assert.equal(fieldScrollTop(100, { top: 170, bottom: 230 }, viewport), 100);
  assert.equal(fieldScrollTop(100, { top: 360, bottom: 470 }, viewport), 160);
  assert.equal(fieldScrollTop(100, { top: 85, bottom: 180 }, viewport), 45);
  assert.equal(fieldScrollTop(100, { top: 220, bottom: 700 }, viewport), 180);
  assert.equal(fieldScrollTop(100, null, viewport), 100);
});

test('WeChat fields stay in the scroll layer and declare fixed textarea coordinates inside sheets', () => {
  const source = readFileSync(new URL('../src/components/FormField.vue', import.meta.url), 'utf8');
  let markup = '';
  const compiled = compile(parse(source).descriptor.template.content, { filename: 'FormField.vue', mode: 'function', isNativeTag: () => true, miniProgram: { directive: 'wx:', class: { array: true }, event: { key: true }, emitFile: (file) => { markup = file.source; } } });
  const render = new Function('Vue', compiled.code)({ o: (handler) => handler, e: Object.assign, n: (value) => value });
  for (const sheet of [null, {}]) for (const multiline of [true, false]) {
const bindings = render({ sheet, multiline, fieldClass: 'input', variant: '', focused: false, error: '', modelValue: '内容', placeholder: '', ariaLabel: '输入', maxlength: 30, disabled: false, focus: true, type: 'text', onInput() {}, onCompositionStart() {}, onCompositionEnd() {}, onFocus() {}, onBlur() {}, touchField() {}, keyboardChange() {}, $emit() {} }, []);
    const fields = [];
    function walk(node) { if (node.type !== 1) return; if (node.tag === (multiline ? 'textarea' : 'input')) fields.push(node); node.children.forEach(walk); }
    baseParse(markup).children.forEach(walk);
    const props = fields[0].props;
    const adjust = props.find((prop) => prop.name === 'adjust-position').value.content.slice(2, -2);
    assert.equal(bindings[adjust], !sheet);
    assert.ok(props.some((prop) => prop.name === 'bindkeyboardheightchange'));
    assert.ok(props.some((prop) => prop.name === 'bindfocus'));
    const hold = props.find((prop) => prop.name === 'hold-keyboard').value.content.slice(2, -2);
    assert.equal(hold, 'false', 'native outside taps must be allowed to dismiss the keyboard');
    const coordinateProp = props.find((prop) => prop.name === (multiline ? 'fixed' : 'always-embed'));
    assert.ok(coordinateProp, multiline ? 'fixed sheets need fixed textarea coordinates' : 'iOS input must not detach into an independent native layer on focus');
    const coordinateBinding = coordinateProp.value.content.slice(2, -2);
    assert.equal(coordinateBinding === 'true' ? true : bindings[coordinateBinding], multiline ? Boolean(sheet) : true);
  }
});

test('all sheet forms use shared keyboard-aware fields and all buttons have immediate pressed feedback', () => {
  const names = ['RecipeEditor', 'CommunityView', 'FamilyEditor', 'StockEditor', 'SetEditor'];
  for (const name of names) {
    const source = readFileSync(new URL(`../src/components/${name}.vue`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /<(input|textarea)\b/);
    assert.match(source, /FormField/);
    function walk(node) {
      if (node.type !== 1) return;
      if (node.tag === 'button') assert.ok(node.props.some((prop) => prop.name === 'hover-class' && prop.value?.content === 'touch-feedback'));
      node.children.forEach(walk);
    }
    baseParse(parse(source).descriptor.template.content).children.forEach(walk);
  }
  const field = readFileSync(new URL('../src/components/FormField.vue', import.meta.url), 'utf8');
  assert.match(field, /:adjust-position="!sheet"/);
  assert.match(field, /keyboardheightchange="keyboardChange"/);
  assert.doesNotMatch(field, /v-bind="\$attrs"/);
});

test('community share avoids capsule, procurement follows meal headings, diary is horizontal and collapsed', () => {
  const component = (name) => readFileSync(new URL(`../src/components/${name}.vue`, import.meta.url), 'utf8');
  assert.match(component('CommunityView'), /<PageHeader title="美食">/);
  assert.doesNotMatch(component('CommunityView'), /layout-switch|columns/);
  const shopping = component('ShoppingView');
  assert.ok(shopping.indexOf('class="shopping-meal-heading"') >= 0);
  assert.ok(shopping.indexOf('class="shopping-meal-heading"') < shopping.indexOf('class="shopping-package"'));
  assert.doesNotMatch(shopping, /买好|copy-list-button/);
  const diary = component('CookingDiary');
  assert.match(diary, /expanded = ref\(false\)/);
  assert.match(diary, /scroll-view scroll-x/);
  assert.doesNotMatch(diary, /diary-grid/);
  assert.doesNotMatch(component('FamilyView'), /♨/);
});
