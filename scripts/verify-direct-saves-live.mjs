import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { loadEnv } from 'vite';
import { createIdeEvaluator } from './publish-authorized-batch.mjs';

assert.ok(process.argv.includes('--live'), '必须显式传入 --live 才可创建临时验收记录');
const config = loadEnv('production', process.cwd(), '');
const root = path.resolve('artifacts/deployment/no-content-check-20260911');
const deployment = JSON.parse(await readFile(path.join(root, 'backend-deployed.json'), 'utf8'));
assert.equal(deployment.sha256, createHash('sha256').update(await readFile('cloudfunctions/kitchen/index.js')).digest('hex'));
assert.equal(deployment.environment, config.VITE_CLOUD_ENV);
const runId = `direct-save-${Date.now()}`;
const directory = path.join(root, runId);
await mkdir(directory, { recursive: true });
const evaluate = createIdeEvaluator(process.cwd(), directory);
const ledger = { runId, checks: [], createdRecipes: [], createdSets: [], requests: [] };
const persist = () => writeFile(path.join(directory, 'ledger.json'), JSON.stringify(ledger, null, 2));
let sequence = 0;
let current;

async function invoke(action, payload = {}) {
  sequence += 1;
  const label = `${sequence}-${payload.name || action}`;
  const argsPath = path.join(directory, `${label}-args.json`);
  await writeFile(argsPath, JSON.stringify([{ action, ...payload, diagnostics: true }, { name: config.VITE_CLOUD_FUNCTION, env: config.VITE_CLOUD_ENV }]));
  ledger.requests.push({ label, action, requestId: payload.requestId, state: 'dispatching' });
  await persist();
  const started = Date.now();
  const result = await evaluate('async function(data,target){var result=await wx.cloud.callFunction({name:target.name,config:{env:target.env},data:data});return {response:result.result,requestID:result.requestID};}', JSON.parse(await readFile(argsPath, 'utf8')));
  await writeFile(path.join(directory, `${label}.json`), JSON.stringify(result, null, 2));
  ledger.requests.at(-1).state = 'returned';
  ledger.requests.at(-1).durationMs = Date.now() - started;
  ledger.requests.at(-1).requestID = result.requestID;
  ledger.requests.at(-1).ok = result.response.ok;
  await persist();
  assert.equal(result.response.ok, true, JSON.stringify(result.response));
  assert.doesNotMatch(JSON.stringify(result.response.diagnostics), /moderation|msgSecCheck|imgSecCheck/i);
  console.log(JSON.stringify({ step: label, ok: true, durationMs: ledger.requests.at(-1).durationMs }));
  return result.response.data;
}

async function mutate(name, args) {
  const result = await invoke('command', { name, args, revision: current.revision, requestId: `${runId}-${sequence + 1}`, includeFeed: false, responseMode: 'changes' });
  current = result.snapshot ? result : { ...current, ...result, snapshot: { ...current.snapshot, ...result.changes } };
  assert.equal(current.familyId, ledger.familyId, '家庭已变更，停止验收');
  return current;
}

current = await invoke('bootstrap', { includeFeed: false });
assert.ok(current.familyId && current.snapshot);
ledger.familyId = current.familyId;
ledger.userId = current.userId;
ledger.before = current.snapshot;
await persist();
try {
  const bytes = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#e8cba1' } }).jpeg().toBuffer();
  const uploaded = await invoke('mediaUpload', { base64: bytes.toString('base64') });
  ledger.upload = uploaded;
  await persist();
  const image = await invoke('mediaContent', { fileId: uploaded.fileId });
  assert.equal(image.base64, bytes.toString('base64'));
  assert.equal(uploaded.protected, true);
  ledger.checks.push('真实图片上传、加密读取与原字节一致');
  for (const [name, category] of [['番茄汤', '汤羹'], ['拌黄瓜', '素菜']]) {
    const draft = { title: `验收${name}${runId.slice(-6)}`, category, servings: 2, minutes: 10, image: uploaded.fileId, ingredients: [{ name: name === '番茄汤' ? '番茄' : '黄瓜', quantity: 1, unit: '个' }, { name: '盐', quantity: null, unit: '', amountText: '适量' }], steps: [{ title: '准备', text: '食材洗净切块', images: [uploaded.fileId] }, { title: '完成', text: '番茄加水煮熟；黄瓜调味拌匀', images: [] }] };
    await mutate('saveRecipe', [draft]);
    const matches = current.snapshot.recipes.filter(recipe => recipe.title === draft.title);
    assert.equal(matches.length, 1);
    ledger.createdRecipes.push(matches[0]);
    await persist();
  }
  const mealSet = { title: `验收套餐${runId.slice(-6)}`, image: uploaded.fileId, recipeIds: ledger.createdRecipes.map(recipe => recipe.id) };
  await mutate('saveMealSet', [mealSet]);
  const created = current.snapshot.mealSets.filter(item => item.title === mealSet.title);
  assert.equal(created.length, 1);
  ledger.createdSets.push(created[0]);
  await persist();
  await mutate('saveMealSet', [{ ...mealSet, title: `${mealSet.title}更新` }, created[0].id]);
  ledger.createdSets[0] = current.snapshot.mealSets.find(item => item.id === created[0].id);
  await persist();
  assert.equal(ledger.createdSets[0].title, `${mealSet.title}更新`);
  ledger.checks.push('真实菜品及套餐创建、套餐编辑成功');
  const family = current.snapshot.family;
  await mutate('customizeFamily', [{ name: family.name, cover: family.cover || '', coverTitle: family.coverTitle || '' }]);
  ledger.checks.push('家庭表单保存成功，原名称与封面不变');
} catch (error) {
  ledger.error = error.message;
  throw error;
} finally {
  await persist();
  current = await invoke('bootstrap', { includeFeed: false });
  assert.equal(current.familyId, ledger.familyId, '家庭已变更，不能清理');
  for (const item of [...ledger.createdSets, ...ledger.createdRecipes]) {
    const kind = ledger.createdSets.includes(item) ? 'set' : 'dish';
    const saved = current.snapshot[kind === 'set' ? 'mealSets' : 'recipes'].find(entry => entry.id === item.id);
    if (!saved) continue;
    assert.deepEqual(saved, item, '临时记录被修改，停止清理');
    assert.ok(!current.snapshot.orders.some(order => order.items?.some(entry => entry.recipe?.id === item.id)), '临时菜品已用于订单，停止清理');
    if (kind === 'dish') assert.ok(!current.snapshot.mealSets.some(entry => entry.recipeIds.includes(item.id)), '临时菜品已用于套餐，停止清理');
    await mutate('removeFamilyEntry', [item.id, kind]);
  }
  ledger.after = current.snapshot;
  for (const field of ['recipes', 'mealSets', 'orders', 'inventory', 'purchases']) assert.deepEqual(current.snapshot[field], ledger.before[field], `原有${field}发生变更，请核对`);
  const familyContent = ({ revision, updatedAt, ...value }) => value;
  assert.deepEqual(familyContent(current.snapshot.family), familyContent(ledger.before.family));
  ledger.cleanedBusinessRecords = true;
  await persist();
}
ledger.completed = true;
await persist();
console.log(JSON.stringify({ directory, checks: ledger.checks, cleanedBusinessRecords: true, imageFileId: ledger.upload.fileId }));
