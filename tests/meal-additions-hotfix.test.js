import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { buildMealAdditionsHotfix } from '../scripts/build-meal-additions-hotfix.mjs';

const baseline = `var actionNames = ["submitOrder", "updateOrder", "addStock"];
var UNITS = ["g", "头"];
var privateDeliveryEnabled = true;
var ingredientUnitsProtocol = { retained: true };
function createKitchenActions() {
  function submitOrder() {
    if (index < 0 && next.orders.some((order) => order.date === selection.date && order.meal === selection.meal && order.status === "completed")) throw new Error("closed");
  }
  function updateOrder(orderId, action) {}
  function addStock() {}
  return { submitOrder, updateOrder, addStock, };
}
function normalizeCommand(name, args) {
    if (name === "submitOrder") {
      const cart = object(args[0]);
      const selection = pick(object(args[1]), ["date", "meal"]);
      return [cart, selection];
    }
}
var commandLists = {
  saveRecipe: ["recipes"]
};
function command(name, revision, family) {
  const social = false;
  if (!social && name !== "submitOrder" && revision !== family.revision) throw new Error("stale");
  try { return invoke(); } catch (error) {
        fail4(error.message);
  }
}
`;

test('meal additions hotfix keeps unrelated image and unit behavior and embeds the shared append implementation', async () => {
  const code = await buildMealAdditionsHotfix(baseline);
  const context = vm.createContext({});
  vm.runInContext(code, context);
  assert.equal(context.privateDeliveryEnabled, true);
  assert.deepEqual(Array.from(context.UNITS), ['g', '头']);
  assert.equal(context.ingredientUnitsProtocol.retained, true);
  assert.deepEqual(Array.from(context.actionNames), ['submitOrder', 'updateOrder', 'addStock', 'addOrderDishes']);
  assert.deepEqual(Array.from(context.commandLists.addOrderDishes), ['recipes', 'mealSets', 'orders']);
  assert.deepEqual(Array.from(context.commandLists.saveRecipe), ['recipes']);
  assert.equal(typeof context.mealAdditionPatch.appendOrderDishes, 'function');
  for (const status of ['pending', 'accepted']) assert.doesNotThrow(() => context.mealAdditionPatch.assertMealEditable({ status }));
  for (const status of ['completed', 'cancelled']) assert.throws(() => context.mealAdditionPatch.assertMealEditable({ status }), /已结束或已取消/);
  assert.match(code, /!\["submitOrder", "addOrderDishes"\]\.includes\(name\)/);
  assert.match(code, /if \(index >= 0\) mealAdditionPatch\.assertMealEditable/);
  assert.doesNotMatch(code, /wx-server-sdk|encryptionKey|IMAGE_DELIVERY_PRIVATE/);
});

test('meal additions hotfix stops for changed, duplicated or already patched production anchors', async () => {
  await assert.rejects(buildMealAdditionsHotfix(baseline.replace('var actionNames', 'var changedActions')), /操作列表不符/);
  await assert.rejects(buildMealAdditionsHotfix(`${baseline}\n${baseline}`), /锚点不唯一/);
  await assert.rejects(buildMealAdditionsHotfix(baseline.replace('var commandLists = {', 'var changedLists = {')), /锚点不唯一/);
  await assert.rejects(buildMealAdditionsHotfix(baseline.replace('["submitOrder", "updateOrder", "addStock"]', '["submitOrder", "addOrderDishes"]')), /已经支持加菜/);
  await assert.rejects(buildMealAdditionsHotfix(await buildMealAdditionsHotfix(baseline)), /已经包含加菜补丁/);
});

test('meal additions release requires an exact production hash and cannot overwrite its prepared artifact', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'meal-additions-hotfix-'));
  try {
    const file = path.join(directory, 'baseline.js');
    await writeFile(file, baseline);
    const args = ['scripts/build-meal-additions-hotfix.mjs', '--baseline', file, '--output', directory, '--expected-baseline-sha'];
    assert.throws(() => execFileSync(process.execPath, [...args, 'incorrect'], { stdio: 'pipe' }));
    assert.deepEqual(await readdir(directory), ['baseline.js']);
    const hash = createHash('sha256').update(baseline).digest('hex');
    const receipt = JSON.parse(execFileSync(process.execPath, [...args, hash], { encoding: 'utf8' }));
    const artifact = await readFile(receipt.artifactPath, 'utf8');
    assert.equal(receipt.state, 'prepared_not_deployed');
    assert.equal(receipt.baselineSha256, hash);
    assert.equal(receipt.sha256, createHash('sha256').update(artifact).digest('hex'));
    assert.deepEqual(await readdir(path.dirname(receipt.artifactPath)), ['index.js']);
    assert.throws(() => execFileSync(process.execPath, [...args, hash], { stdio: 'pipe' }));
    assert.equal(await readFile(receipt.artifactPath, 'utf8'), artifact);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
