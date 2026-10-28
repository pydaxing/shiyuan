import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { loadEnv } from 'vite';
import { UNITS } from '../src/domain/kitchen.js';
import { INGREDIENT_UNITS_VERSION } from '../src/domain/ingredient-units.js';
import { createIdeEvaluator } from './publish-authorized-batch.mjs';

assert.ok(process.argv.includes('--live'), '传入 --live 才会创建临时验收菜品');
const config = loadEnv('production', process.cwd(), '');
const outputIndex = process.argv.indexOf('--output');
const root = path.resolve(outputIndex < 0 ? 'artifacts/deployment/ingredient-amounts-20260911' : process.argv[outputIndex + 1]);
const deployment = JSON.parse(await readFile(path.join(root, 'backend-deployed.json'), 'utf8'));
const deployedArtifact = deployment.artifactPath || 'cloudfunctions/kitchen/index.js';
assert.equal(deployment.sha256, createHash('sha256').update(await readFile(deployedArtifact)).digest('hex'));
assert.equal(deployment.environment, config.VITE_CLOUD_ENV);
const runId = `ingredient-amounts-${Date.now()}`;
const directory = path.join(root, runId);
await mkdir(directory, { recursive: true });
const evaluate = createIdeEvaluator(process.cwd(), directory);
const ledger = { runId, checks: [], requests: [] };
const persist = () => writeFile(path.join(directory, 'ledger.json'), JSON.stringify(ledger, null, 2));
let current;

async function invoke(action, payload = {}, ingredientUnitsVersion = INGREDIENT_UNITS_VERSION) {
  const label = `${ledger.requests.length + 1}-${payload.name || action}`;
  ledger.requests.push({ label, action, requestId: payload.requestId, state: 'dispatching' });
  await persist();
  const result = await evaluate('async function(data,target){var result=await wx.cloud.callFunction({name:target.name,config:{env:target.env},data:data});return {response:result.result,requestID:result.requestID};}', [{ action, ...payload, ingredientUnitsVersion }, { name: config.VITE_CLOUD_FUNCTION, env: config.VITE_CLOUD_ENV }]);
  await writeFile(path.join(directory, `${label}.json`), JSON.stringify(result, null, 2));
  Object.assign(ledger.requests.at(-1), { state: 'returned', requestID: result.requestID, ok: result.response.ok });
  await persist();
  assert.equal(result.response.ok, true, JSON.stringify(result.response));
  console.log(JSON.stringify({ step: label, ok: true }));
  return result.response.data;
}

async function mutate(name, args, ingredientUnitsVersion = INGREDIENT_UNITS_VERSION) {
  const result = await invoke('command', { name, args, revision: current.revision, requestId: `${runId}-${ledger.requests.length + 1}`, includeFeed: false, responseMode: 'changes' }, ingredientUnitsVersion);
  current = result.snapshot ? result : { ...current, ...result, snapshot: { ...current.snapshot, ...result.changes } };
  assert.equal(current.familyId, ledger.familyId);
}

current = await invoke('bootstrap', { includeFeed: false });
assert.ok(current.familyId && current.snapshot);
ledger.familyId = current.familyId;
ledger.before = current.snapshot;
const unitIngredients = UNITS.map((unit, index) => ({ name: `原料${index + 1}`, quantity: 0.5, unit }));
const draft = { title: `用量验收${runId.slice(-8)}`, category: '其他', servings: 2, minutes: null, image: '', nutrition: '', steps: [], ingredients: unitIngredients.slice(0, 30) };
ledger.draft = draft;
await persist();
assert.ok(!current.snapshot.recipes.some(recipe => recipe.title === draft.title));
try {
  await mutate('saveRecipe', [draft]);
  ledger.created = current.snapshot.recipes.find(recipe => recipe.title === draft.title);
  assert.ok(ledger.created);
  await persist();
  current = await invoke('bootstrap', { includeFeed: false });
  assert.deepEqual(current.snapshot.recipes.find(recipe => recipe.id === ledger.created.id).ingredients, draft.ingredients);
  for (let offset = 30; offset < unitIngredients.length; offset += 30) {
    const ingredients = unitIngredients.slice(offset, offset + 30);
    await mutate('saveRecipe', [{ ...draft, ingredients }, ledger.created.id]);
    ledger.created = current.snapshot.recipes.find(recipe => recipe.id === ledger.created.id);
    await persist();
    current = await invoke('bootstrap', { includeFeed: false });
    assert.deepEqual(current.snapshot.recipes.find(recipe => recipe.id === ledger.created.id).ingredients, ingredients);
  }
  ledger.checks.push(`${UNITS.length}种单位分批真实保存和重新读取成功`);
  const measured = structuredClone(ledger.created.ingredients);
  const legacy = await invoke('bootstrap', { includeFeed: false }, 1);
  const legacyRecipe = legacy.snapshot.recipes.find(recipe => recipe.id === ledger.created.id);
  assert.ok(legacyRecipe.ingredients.every(ingredient => ingredient.quantity === null && ingredient.unit === '' && typeof ingredient.amountText === 'string'));
  await mutate('saveRecipe', [legacyRecipe, ledger.created.id], 1);
  current = await invoke('bootstrap', { includeFeed: false });
  ledger.created = current.snapshot.recipes.find(recipe => recipe.id === ledger.created.id);
  assert.deepEqual(ledger.created.ingredients, measured);
  ledger.legacyCompatible = true;
  ledger.checks.push('旧版可读取新增单位，保存后仍保留数据库标准数值及单位');
  for (const ingredients of [
    [{ name: '盐', quantity: null, unit: '', amountText: '适量' }, { name: '胡椒', quantity: null, unit: '', amountText: '少许' }, { name: '糖', quantity: null, unit: '', amountText: '半茶匙' }],
    [{ name: '啤酒', quantity: 0.5, unit: '瓶' }],
  ]) {
    await mutate('saveRecipe', [{ ...draft, ingredients }, ledger.created.id]);
    ledger.created = current.snapshot.recipes.find(recipe => recipe.id === ledger.created.id);
    await persist();
    current = await invoke('bootstrap', { includeFeed: false });
    assert.deepEqual(current.snapshot.recipes.find(recipe => recipe.id === ledger.created.id).ingredients, ingredients);
  }
  ledger.checks.push('适量、少许、历史文字用量及数字单位保存后重新读取一致');
} catch (error) {
  ledger.error = error.message;
  throw error;
} finally {
  await persist();
  current = await invoke('bootstrap', { includeFeed: false });
  assert.equal(current.familyId, ledger.familyId, '家庭已变更，停止清理');
  const matches = current.snapshot.recipes.filter(recipe => recipe.id === ledger.created?.id || recipe.title === draft.title);
  assert.ok(matches.length <= 1, '测试记录不唯一，需手动核对');
  for (const saved of matches) {
    assert.ok(ledger.created, '写入回执不完整，保留测试记录待核对');
    assert.deepEqual(saved, ledger.created, '测试记录被修改，停止清理');
    assert.ok(!current.snapshot.orders.some(order => order.items?.some(item => item.recipe?.id === saved.id)));
    assert.ok(!current.snapshot.mealSets.some(set => set.recipeIds.includes(saved.id)));
    await mutate('removeFamilyEntry', [saved.id, 'dish']);
  }
  for (const field of ['recipes', 'mealSets', 'orders', 'inventory', 'purchases']) assert.deepEqual(current.snapshot[field], ledger.before[field]);
  const familyContent = ({ revision, updatedAt, ...value }) => value;
  assert.deepEqual(familyContent(current.snapshot.family), familyContent(ledger.before.family));
  ledger.cleaned = true;
  await persist();
}
ledger.completed = true;
await persist();
await writeFile(path.join(root, 'backend-unit-validation.json'), JSON.stringify({ state: 'verified', environment: config.VITE_CLOUD_ENV, functionName: config.VITE_CLOUD_FUNCTION, appid: config.WEIXIN_APPID, units: UNITS, ingredientUnitsVersion: INGREDIENT_UNITS_VERSION, legacyCompatible: ledger.legacyCompatible, verifiedAt: new Date().toISOString(), cleaned: ledger.cleaned, ledger: path.join(directory, 'ledger.json') }, null, 2));
console.log(JSON.stringify({ directory, checks: ledger.checks, cleaned: ledger.cleaned }));
