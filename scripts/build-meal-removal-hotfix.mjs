import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');

export async function buildMealRemovalHotfix(baseline) {
  assert.ok(!baseline.includes('removeOrderDish'), '生产代码已支持减菜，请重新核对');
  const built = await build({ entryPoints: [path.join(root, 'src/domain/actions.js')], bundle: true, write: false, platform: 'node', target: 'node18', format: 'cjs' });
  const source = built.outputFiles[0].text;
  const declaration = (name, indent = '') => {
    const matches = [...source.matchAll(new RegExp(`^${indent}function ${name}\\([^]*?^${indent}}`, 'gm'))];
    assert.equal(matches.length, 1, `${name} 定义不唯一`);
    return matches[0][0];
  };
  for (const name of ['assertMealEditable', 'localDate', 'rebuildMealOrder', 'validateReservation']) assert.match(baseline, new RegExp(`^function ${name}\\(`, 'm'), `生产代码缺少 ${name}`);
  assert.match(baseline, /^var clone = /m, '生产代码缺少 clone');
  const replacements = [];
  let patched = baseline;
  const replace = (before, after) => {
    assert.equal(patched.split(before).length, 2, `生产代码锚点不唯一：${before.slice(0, 90)}`);
    patched = patched.replace(before, () => after);
    replacements.push({ before, after });
  };
  const actions = baseline.match(/^var actionNames = (\[[^\n]+\]);$/m);
  assert.ok(actions, '生产操作列表不符');
  replace(actions[0], `var actionNames = ${JSON.stringify([...JSON.parse(actions[1]), 'removeOrderDish'])};`);
  replace('function createKitchenActions(', `${declaration('removeDishFromOrder')}\nfunction createKitchenActions(`);
  replace('  function updateOrder(orderId, action) {', `${declaration('removeOrderDish', '  ')}\n  function updateOrder(orderId, action) {`);
  replace('  return { submitOrder, addOrderDishes, updateOrder,', '  return { submitOrder, addOrderDishes, removeOrderDish, updateOrder,');
  const validation = '    if (["removeOrder", "removeStock", "toggleCommentLike", "deleteCommunityPost"].includes(name))';
  replace(validation, `    if (name === "removeOrderDish") return [id(args[0]), id(args[1])];\n${validation}`);
  replace('var commandLists = {', 'var commandLists = {\n  removeOrderDish: ["orders", "purchases"],');
  let restored = patched;
  for (const { before, after } of replacements.toReversed()) restored = restored.replace(after, () => before);
  assert.equal(restored, baseline, '不得修改减菜以外的线上代码');
  return patched;
}

async function run() {
  const option = name => {
    const index = process.argv.indexOf(name);
    assert.ok(index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--'), `缺少参数 ${name}`);
    return process.argv[index + 1];
  };
  const baselinePath = path.resolve(option('--baseline'));
  const output = path.resolve(option('--output'));
  const baseline = await readFile(baselinePath, 'utf8');
  assert.equal(sha256(baseline), option('--expected-baseline-sha'), '生产代码摘要不一致');
  const code = await buildMealRemovalHotfix(baseline);
  const directory = path.join(output, 'meal-removal-hotfix/kitchen-v2');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const artifactPath = path.join(directory, 'index.js');
  await writeFile(artifactPath, code, { flag: 'wx', mode: 0o600 });
  const receipt = { state: 'prepared_not_deployed', method: 'production_baseline_meal_removal_only', baselinePath, baselineSha256: sha256(baseline), artifactPath, sha256: sha256(code) };
  await writeFile(path.join(output, 'meal-removal-hotfix-prepared.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(receipt, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run().catch(error => { console.error(error); process.exitCode = 1; });
