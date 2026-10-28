import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');

export async function buildMealAdditionsHotfix(baseline) {
  assert.ok(!baseline.includes('mealAdditionPatch'), '生产代码已经包含加菜补丁，请重新核对版本');
  const actions = baseline.match(/^var actionNames = (\[[^\n]+\]);$/m);
  assert.ok(actions, '生产操作列表不符，停止热修复');
  const actionNames = JSON.parse(actions[1]);
  assert.ok(!actionNames.includes('addOrderDishes'), '生产代码已经支持加菜，不应重复打补丁');
  const replacements = [];
  let patched = baseline;
  function replace(before, after) {
    assert.equal(patched.split(before).length, 2, `生产代码锚点不唯一，停止热修复：${before.slice(0, 90)}`);
    patched = patched.replace(before, after);
    replacements.push({ before, after });
  }
  replace(actions[0], `var actionNames = ${JSON.stringify([...actionNames, 'addOrderDishes'])};`);
  const updateOrder = '  function updateOrder(orderId, action) {';
  const additionAction = `  function addOrderDishes(orderId, cart) {
    const next = clone(state.value);
    const index = next.orders.findIndex((order) => order.id === orderId);
    const order = next.orders[index];
    next.orders[index] = mealAdditionPatch.appendOrderDishes(order, { recipes: next.recipes, mealSets: next.mealSets, cart, member: activeMember.value, today: today() });
    commit(next);
    return order.id;
  }
`;
  replace(updateOrder, `${additionAction}${updateOrder}`);
  replace('  return { submitOrder, updateOrder, addStock,', '  return { submitOrder, addOrderDishes, updateOrder, addStock,');
  replace('    if (name === "submitOrder") {\n      const cart = object(args[0]);', '    if (name === "submitOrder" || name === "addOrderDishes") {\n      const cart = object(args[name === "addOrderDishes" ? 1 : 0]);');
  const selection = '      const selection = pick(object(args[1]), ["date", "meal"]);';
  replace(selection, `      if (name === "addOrderDishes") {
        if (!Object.keys(cart).length) invalid("先选几道想吃的菜吧");
        return [id(args[0]), cart];
      }
${selection}`);
  replace('var commandLists = {', 'var commandLists = {\n  addOrderDishes: ["recipes", "mealSets", "orders"],');
  replace('if (!social && name !== "submitOrder" && revision !== family.revision)', 'if (!social && !["submitOrder", "addOrderDishes"].includes(name) && revision !== family.revision)');
  const completedGuard = '    if (index < 0 && next.orders.some((order) => order.date === selection.date && order.meal === selection.meal && order.status === "completed"))';
  replace(completedGuard, `    if (index >= 0) mealAdditionPatch.assertMealEditable(next.orders[index]);\n${completedGuard}`);
  replace('        fail4(error.message);', '        fail4(error.message, ["addOrderDishes", "submitOrder"].includes(name) && error.code === "CONFLICT" ? "CONFLICT" : "INVALID");');
  let restored = patched;
  for (const { before, after } of [...replacements].reverse()) restored = restored.replace(after, before);
  assert.equal(restored, baseline, '热修复改动超出加菜入口和开餐锁定范围');
  const module = await build({
    stdin: { contents: 'export { appendOrderDishes } from "./src/domain/meal-additions.js"; export { assertMealEditable } from "./src/domain/kitchen.js";', resolveDir: root },
    bundle: true, write: false, platform: 'node', target: 'node18', format: 'iife', globalName: 'mealAdditionPatch', charset: 'ascii', legalComments: 'none',
  });
  return `${patched}\n${module.outputFiles[0].text}`;
}

async function run() {
  function option(name) {
    const index = process.argv.indexOf(name);
    assert.ok(index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--'), `缺少参数 ${name}`);
    return process.argv[index + 1];
  }
  const baselinePath = path.resolve(option('--baseline'));
  const output = path.resolve(option('--output'));
  const baseline = await readFile(baselinePath, 'utf8');
  assert.equal(sha256(baseline), option('--expected-baseline-sha'), '生产代码校验值已变化，停止热修复');
  const code = await buildMealAdditionsHotfix(baseline);
  const directory = path.join(output, 'meal-additions-hotfix/kitchen-v2');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'index.js');
  await writeFile(file, code, { flag: 'wx', mode: 0o600 });
  const receipt = { state: 'prepared_not_deployed', method: 'production_baseline_meal_additions_only', baselinePath, baselineSha256: sha256(baseline), artifactPath: file, sha256: sha256(code) };
  await writeFile(path.join(output, 'meal-additions-hotfix-prepared.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(receipt, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run().catch(error => { console.error(error); process.exitCode = 1; });
