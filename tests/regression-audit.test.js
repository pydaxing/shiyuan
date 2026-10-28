import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { watch, nextTick } from 'vue';
import { parse } from '@vue/compiler-sfc';
import { baseParse } from '@vue/compiler-dom';
import { useSheetScroll } from '../src/composables/useSheetScroll.js';
import { registerSheet, sheetOpen } from '../src/composables/sheetStack.js';
import { createSeed } from '../src/data/seed.js';
import { emptySnapshot } from '../src/domain/empty.js';
import { kitchenOrders, sortMealOrders, mealDateLabel, normalizeSnapshot, dateOffset } from '../src/domain/kitchen.js';

test('manual scroll events never write back scroll-top or trigger reactive renders', async () => {
  const scroll = useSheetScroll();
  let updates = 0;
  const stop = watch(scroll.scrollTop, () => { updates += 1; }, { flush: 'sync' });
  for (let position = 0; position < 2400; position += 4) scroll.onScroll({ detail: { scrollTop: position } });
  await nextTick();
  assert.equal(updates, 0);
  assert.equal(scroll.scrollTop.value, 0);
  stop();
});

test('explicit family subpage reset reaches top and cancels pending keyboard reveal', async () => {
  const scroll = useSheetScroll();
  scroll.onScroll({ detail: { scrollTop: 600 } });
  const reveal = scroll.reveal({ top: 390, bottom: 490 }, { top: 100, bottom: 400 });
  const reset = scroll.reset();
  await Promise.all([reveal, reset]);
  assert.ok(scroll.scrollTop.value <= .1);
  scroll.onScroll({ detail: { scrollTop: 500 } });
  await scroll.reset();
  assert.ok(scroll.scrollTop.value <= .1);
});

test('keyboard reveal uses the observed scroll offset and can revisit the same target', async () => {
  const scroll = useSheetScroll();
  const viewport = { top: 100, bottom: 400 };
  scroll.onScroll({ detail: { scrollTop: 300 } });
  await scroll.reveal({ top: 360, bottom: 440 }, viewport);
  assert.equal(scroll.scrollTop.value, 360);
  scroll.onScroll({ detail: { scrollTop: 300 } });
  const updates = [];
  const stop = watch(scroll.scrollTop, (value) => updates.push(value), { flush: 'sync' });
  await scroll.reveal({ top: 360, bottom: 440 }, viewport);
  assert.deepEqual(updates, [360.1]);
  stop();
});

test('a new finger scroll cancels an outdated keyboard reveal request', async () => {
  const scroll = useSheetScroll();
  scroll.onScroll({ detail: { scrollTop: 100 } });
  const pending = scroll.reveal({ top: 460, bottom: 520 }, { top: 100, bottom: 400 });
  scroll.onScroll({ detail: { scrollTop: 110 } });
  await pending;
  assert.equal(scroll.scrollTop.value, 0);
});

test('revealing a field issues only its destination, not an intermediate scroll reset', async () => {
  const scroll = useSheetScroll();
  scroll.onScroll({ detail: { scrollTop: 500 } });
  const updates = [];
  const stop = watch(scroll.scrollTop, (value) => updates.push(value), { flush: 'sync' });
  await scroll.reveal({ top: 350, bottom: 430 }, { top: 100, bottom: 400, scrollTop: 520 });
  assert.deepEqual(updates, [570]);
  stop();
});

test('fresh measured offsets override delayed native scroll notifications', async () => {
  const scroll = useSheetScroll();
  scroll.onScroll({ detail: { scrollTop: 100 } });
  await scroll.reveal({ top: 350, bottom: 430 }, { top: 100, bottom: 400, scrollTop: 480 });
  assert.equal(scroll.scrollTop.value, 530);
});

test('nested sheets keep the page locked until the final sheet closes', () => {
  const editor = registerSheet();
  const picker = registerSheet();
  assert.equal(sheetOpen.value, true);
  assert.equal(editor.isTop(), false);
  assert.equal(picker.isTop(), true);
  picker.close();
  assert.equal(editor.isTop(), true);
  assert.equal(sheetOpen.value, true);
  editor.close();
  editor.close();
  assert.equal(sheetOpen.value, false);
});

test('kitchen shows only its three-day window while the underlying meal ordering preserves all records', () => {
  for (const today of ['2026-09-08', '2026-12-31', '2027-01-01', '2024-02-28', '2024-03-01']) {
    const base = new Date(`${today}T12:00:00`);
    const orders = [-20, -2, -1, 0, 1, 2, 30].map((offset) => ({ id: offset, date: dateOffset(offset, base), meal: '晚餐', status: 'pending' }));
    const before = structuredClone(orders);
    assert.deepEqual(kitchenOrders(orders, today).map((order) => order.id), [0, 1, 2]);
    assert.deepEqual(sortMealOrders(orders, today).map((order) => order.id), [0, 1, 2, 30, -20, -2, -1]);
    assert.equal(mealDateLabel(orders[2].date, today), '昨天');
    assert.deepEqual(orders, before);
  }
});

test('fresh defaults disable fridge, shopping and chef without overriding existing saved choices', () => {
  const previous = createSeed();
  const fresh = normalizeSnapshot(previous);
  assert.deepEqual(fresh.family.features, { fridge: false, shopping: false });
  assert.deepEqual(emptySnapshot().family.features, fresh.family.features);
  assert.ok(fresh.family.members.every((member) => member.isChef === false));
  fresh.family.members[0].isChef = true;
  for (const fridge of [false, true]) for (const shopping of [false, true]) {
    fresh.family.features = { fridge, shopping };
    assert.deepEqual(normalizeSnapshot(fresh), fresh);
  }
  assert.equal(previous.family.features, undefined);
});

test('dish and family portraits omit the removed chef feature while preserving family ownership', () => {
  const component = (name) => readFileSync(new URL(`../src/components/${name}.vue`, import.meta.url), 'utf8');
  assert.doesNotMatch(component('MealDishList'), /isChef|chef-mark|chef-hat/);
  assert.doesNotMatch(component('FamilyView'), /isChef|chef-hat|我是大厨/);
  assert.match(component('FamilyView'), /v-if="state.family.headMemberId === member.id" class="head-crown"/);
});

test('component event handlers are not shadowed by repeated item aliases', () => {
  const directory = new URL('../src/components/', import.meta.url);
  for (const filename of readdirSync(directory).filter((entry) => entry.endsWith('.vue'))) {
    const template = parse(readFileSync(new URL(filename, directory), 'utf8')).descriptor.template;
    if (!template) continue;
    function walk(node, aliases = []) {
      if (node.type !== 1) return;
      const loop = node.props.find((prop) => prop.name === 'for');
      const scope = loop ? [...aliases, ...loop.exp.content.split(/\s+(?:in|of)\s+/)[0].replace(/[()]/g, '').split(',').map((entry) => entry.trim())] : aliases;
      for (const prop of node.props.filter((entry) => entry.name === 'on')) {
        assert.ok(!scope.includes(prop.exp?.content), `${filename}: @${prop.arg.content} binds repeated item ${prop.exp?.content}`);
      }
      node.children.forEach((child) => walk(child, scope));
    }
    baseParse(template.content).children.forEach((node) => walk(node));
  }
});
