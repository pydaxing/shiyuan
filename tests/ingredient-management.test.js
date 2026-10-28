import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nextTick, ref } from 'vue';
import { createPreferenceUpdates } from '../src/services/preference-updates.js';
import { hasIngredientManagement, mainNavigation } from '../src/domain/navigation.js';
import { createKitchenActions } from '../src/domain/actions.js';
import { createSeed } from '../src/data/seed.js';
import { normalizeSnapshot } from '../src/domain/kitchen.js';

const flush = () => new Promise(resolve => setTimeout(resolve, 5));
function navigationFixture(currentTab = 'menu') {
  const source = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8');
  assert.match(source, /@click="selectNavigation\(item\.id\)"/);
  const handlers = ['selectNavigation', 'openIngredients'].map(name => source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0]).join('\n');
  const tab = ref(currentTab);
  const ingredientSection = ref('inventory');
  const shoppingFocusRequest = ref({ id: 'previous-meal' });
  const preparingOrderId = ref('');
  const scrolls = [];
  const actions = new Function('tab', 'ingredientSection', 'shoppingFocusRequest', 'preparingOrderId', 'tapFeedback', 'dismissFocusedKeyboard', 'uni', `${handlers}; return { selectNavigation, openIngredients };`)(tab, ingredientSection, shoppingFocusRequest, preparingOrderId, () => {}, () => {}, { pageScrollTo: options => scrolls.push(options) });
  return { ...actions, tab, ingredientSection, shoppingFocusRequest, scrolls };
}

test('the bottom ingredients entry always opens shopping instead of the last fridge section', () => {
  for (const previousTab of ['menu', 'kitchen', 'community', 'family', 'ingredients']) {
    const current = navigationFixture(previousTab);
    current.selectNavigation('ingredients');
    assert.equal(current.tab.value, 'ingredients');
    assert.equal(current.ingredientSection.value, 'shopping');
    assert.equal(current.shoppingFocusRequest.value, null);
    if (previousTab === 'ingredients') assert.deepEqual(current.scrolls, [{ scrollTop: 0, duration: 0 }]);
  }
});

test('ordinary navigation leaves fridge state untouched until the ingredients entry is tapped', () => {
  const current = navigationFixture('ingredients');
  current.selectNavigation('kitchen');
  assert.equal(current.tab.value, 'kitchen');
  assert.equal(current.ingredientSection.value, 'inventory');
  current.selectNavigation('ingredients');
  assert.equal(current.ingredientSection.value, 'shopping');
});

test('explicit ingredient navigation retains the requested section and meal focus', () => {
  const current = navigationFixture('kitchen');
  current.openIngredients('shopping', 'selected-meal');
  assert.equal(current.tab.value, 'ingredients');
  assert.equal(current.ingredientSection.value, 'shopping');
  assert.deepEqual(current.shoppingFocusRequest.value, { id: 'selected-meal' });
  current.openIngredients('inventory');
  assert.equal(current.ingredientSection.value, 'inventory');
  assert.equal(current.shoppingFocusRequest.value, null);
});

function fixture() {
  const scope = ref('first-family:me');
  const busy = ref(false);
  const saved = { fridge: false, shopping: false };
  const requests = [];
  const updates = createPreferenceUpdates({
    getScope: () => scope.value,
    isBusy: () => busy.value,
    debounceMs: 0,
    sendBatch: values => new Promise((resolve, reject) => requests.push({ values, resolve() { Object.assign(saved, values); resolve(); }, reject })),
  });
  const features = () => ({ fridge: updates.value('fridge', saved.fridge), shopping: updates.value('shopping', saved.shopping) });
  return { scope, busy, saved, requests, updates, features };
}

test('one ingredient switch updates both visible features immediately and saves one command', async () => {
  const current = fixture();
  const saving = current.updates.updateMany({ fridge: true, shopping: true });
  assert.deepEqual(current.features(), { fridge: true, shopping: true });
  assert.equal(mainNavigation(current.features()).length, 5);
  assert.deepEqual(current.saved, { fridge: false, shopping: false });
  await flush();
  assert.equal(current.requests.length, 1);
  assert.deepEqual(current.requests[0].values, { fridge: true, shopping: true });
  current.requests[0].resolve();
  assert.equal(await saving, true);
  assert.deepEqual(current.updates.pending.value, {});
  assert.equal(hasIngredientManagement(current.features()), true);
});

test('a failed legacy grouped preference change restores both values without hiding procurement', async () => {
  const current = fixture();
  const saving = current.updates.updateMany({ fridge: true, shopping: true });
  const failed = assert.rejects(saving, /保存失败/);
  await flush();
  current.requests[0].reject(new Error('保存失败'));
  await failed;
  assert.deepEqual(current.features(), { fridge: false, shopping: false });
  assert.equal(mainNavigation(current.features()).length, 5);
  assert.equal(mainNavigation(current.features())[3].label, '采购');
  assert.deepEqual(current.updates.pending.value, {});
});

test('turning off while turning on is in flight never splits the grouped features', async () => {
  const current = fixture();
  const turningOn = current.updates.updateMany({ fridge: true, shopping: true });
  await flush();
  const turningOff = current.updates.updateMany({ fridge: false, shopping: false });
  assert.deepEqual(current.features(), { fridge: false, shopping: false });
  assert.equal(current.requests.length, 1);
  current.requests[0].resolve();
  await turningOn;
  assert.equal(current.requests.length, 2);
  assert.deepEqual(current.requests[1].values, { fridge: false, shopping: false });
  assert.equal(mainNavigation(current.features()).length, 5);
  assert.equal(mainNavigation(current.features())[3].label, '采购');
  current.requests[1].resolve();
  await turningOff;
  assert.deepEqual(current.saved, { fridge: false, shopping: false });
});

test('pending settings from the old family never apply to the next family', async () => {
  const current = fixture();
  current.busy.value = true;
  const saving = current.updates.updateMany({ fridge: true, shopping: true });
  await flush();
  current.scope.value = 'second-family:me';
  assert.equal(hasIngredientManagement(current.features()), false);
  current.busy.value = false;
  await nextTick();
  assert.equal(await saving, false);
  assert.equal(current.requests.length, 0);
  assert.deepEqual(current.updates.pending.value, {});
});

test('the existing grouped command toggles access without erasing inventory or meal data', () => {
  let snapshot = normalizeSnapshot(createSeed());
  const before = JSON.stringify({ inventory: snapshot.inventory, orders: snapshot.orders, recipes: snapshot.recipes });
  const actions = createKitchenActions({ getState: () => snapshot, commit: next => { snapshot = next; }, newId: prefix => `${prefix}-unused` });
  for (const enabled of [true, false, true]) {
    actions.setPreferences({ fridge: enabled, shopping: enabled });
    assert.deepEqual(snapshot.family.features, { fridge: enabled, shopping: enabled });
    assert.equal(JSON.stringify({ inventory: snapshot.inventory, orders: snapshot.orders, recipes: snapshot.recipes }), before);
  }
});
