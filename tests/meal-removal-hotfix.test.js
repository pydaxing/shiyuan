import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildMealRemovalHotfix } from '../scripts/build-meal-removal-hotfix.mjs';

const baseline = `var actionNames = ["submitOrder", "addOrderDishes", "updateOrder", "removeOrder"];
var clone = value => JSON.parse(JSON.stringify(value));
var privateDeliveryEnabled = true;
var ingredientUnitsProtocol = { retained: true };
function assertMealEditable(order) {}
function localDate() {}
function rebuildMealOrder(order) {}
function validateReservation(order) {}
function createKitchenActions() {
  function submitOrder() {}
  function addOrderDishes() {}
  function updateOrder(orderId, action) {}
  function removeOrder() {}
  return { submitOrder, addOrderDishes, updateOrder, removeOrder };
}
function normalizeCommand(name, args) {
    if (["removeOrder", "removeStock", "toggleCommentLike", "deleteCommunityPost"].includes(name)) return [id(args[0])];
}
var commandLists = {
  addOrderDishes: ["recipes", "mealSets", "orders"]
};
`;

test('the removal hotfix adds the canonical implementation without overwriting unrelated production behavior', async () => {
  const code = await buildMealRemovalHotfix(baseline);
  const context = vm.createContext({});
  vm.runInContext(code, context);
  assert.equal(context.privateDeliveryEnabled, true);
  assert.equal(context.ingredientUnitsProtocol.retained, true);
  assert.deepEqual(Array.from(context.actionNames), ['submitOrder', 'addOrderDishes', 'updateOrder', 'removeOrder', 'removeOrderDish']);
  assert.deepEqual(Array.from(context.commandLists.removeOrderDish), ['orders', 'purchases']);
  assert.deepEqual(Array.from(context.commandLists.addOrderDishes), ['recipes', 'mealSets', 'orders']);
  assert.equal(typeof context.createKitchenActions().removeOrderDish, 'function');
  assert.match(code, /function removeDishFromOrder\(/);
  assert.doesNotMatch(code, /wx-server-sdk|UpdateFunctionCode/);
});

test('changed, duplicated, and already patched production anchors block the removal hotfix', async () => {
  await assert.rejects(buildMealRemovalHotfix(baseline.replace('var actionNames', 'var changedNames')), /操作列表不符/);
  await assert.rejects(buildMealRemovalHotfix(baseline.replace('var commandLists = {', 'var changedLists = {')), /锚点不唯一/);
  await assert.rejects(buildMealRemovalHotfix(`${baseline}\n${baseline}`), /锚点不唯一/);
  await assert.rejects(buildMealRemovalHotfix(await buildMealRemovalHotfix(baseline)), /已支持减菜/);
});
