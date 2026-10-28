import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify, isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { UNITS, validateIngredient } from '../src/domain/kitchen.js';
import { INGREDIENT_UNITS_VERSION } from '../src/domain/ingredient-units.js';
import { documentDigest, assertStagedRecipe } from './admin-recipe-import.mjs';
import { assertStandardIngredient, standardizeIngredient } from './ingredient-standardization.mjs';
import { reviewedIngredientEntry } from './reviewed-ingredient-imports.mjs';

const execute = promisify(execFile);
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const saveNewJson = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const importKind = 'authorized_recipe_staging_v1';
const getAt = (value, field) => field.split('.').reduce((current, key) => current?.[key], value);
const saveJson = async (file, value) => {
  await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(`${file}.tmp`, file);
};

export function setIngredientFields(document, fields) {
  const next = structuredClone(document);
  for (const [field, value] of Object.entries(fields)) {
    assert.ok(/^(?:value\.ingredients|recipes\.\d+\.ingredients|recipeDraft\.ingredients|post\.recipes\.\d+\.ingredients|contentDigest)$/.test(field), `禁止修改非食材字段：${field}`);
    const keys = field.split('.');
    const parent = keys.slice(0, -1).reduce((current, key) => current[key], next);
    assert.ok(parent, `字段不存在：${field}`);
    parent[keys.at(-1)] = structuredClone(value);
  }
  return next;
}

export function makeIngredientOperation(collection, before, review) {
  const fields = {};
  const changes = [];
  for (const { field, recipe } of ingredientRecipes(collection, before)) {
    const ingredients = recipe.ingredients.flatMap((ingredient, index) => {
      const result = standardizeIngredient(ingredient, review);
      if (!isDeepStrictEqual([ingredient], result.ingredients)) changes.push({ recipeId: recipe.id, title: recipe.title, field: `${field}.ingredients.${index}`, before: ingredient, after: result.ingredients, kind: result.kind, reason: result.reason });
      return result.ingredients;
    });
    assert.ok(ingredients.length > 0 && ingredients.length <= 30, '标准化后的配料行数不符合菜谱限制');
    ingredients.forEach(assertStandardIngredient);
    if (!isDeepStrictEqual(ingredients, recipe.ingredients)) fields[`${field}.ingredients`] = ingredients;
  }
  if (!Object.keys(fields).length) return null;
  let after = setIngredientFields(before, fields);
  if (collection === 'imports') {
    assertStagedRecipe(before);
    fields.contentDigest = documentDigest(after);
    after = setIngredientFields(before, fields);
    assertStagedRecipe(after);
  }
  assert.equal(before._id, after._id);
  return { collection, documentId: before._id, familyId: collection === 'recipes' ? before.familyId : undefined, before, after, fields, changes };
}

export function ingredientUpdate(operation, current, rollback = false) {
  const from = rollback ? operation.after : operation.before;
  const to = rollback ? operation.before : operation.after;
  assert.equal(current?._id, operation.documentId, '目标记录已不存在');
  const fieldNames = Object.keys(operation.fields);
  if (operation.collection === 'recipes') assert.equal(current.familyId, operation.familyId, '菜谱家庭归属已变化');
  if (operation.collection === 'posts') {
    assert.equal(current.status, 'published', '已撤回的美食不更新');
    assert.equal(current.kind, from.kind);
  }
  if (operation.collection === 'imports') assertStagedRecipe(current);
  for (const field of fieldNames.filter(field => field.endsWith('.ingredients'))) {
    const identifierField = `${field.slice(0, -'.ingredients'.length)}.id`;
    assert.equal(getAt(current, identifierField), getAt(from, identifierField), '套餐内菜品顺序已变化');
  }
  const matches = document => fieldNames.every(field => isDeepStrictEqual(getAt(current, field), getAt(document, field)));
  if (matches(to)) return { alreadyApplied: true, expected: current };
  assert.ok(matches(from), `线上食材已被修改，停止而不覆盖：${operation.collection}/${operation.documentId}`);
  const query = { _id: operation.documentId };
  const fields = {};
  for (const field of fieldNames) {
    query[field] = getAt(from, field);
    fields[field] = getAt(to, field);
    if (field.endsWith('.ingredients')) {
      const parent = field.slice(0, -'.ingredients'.length);
      const identifier = getAt(from, `${parent}.id`);
      if (identifier !== undefined) {
        assert.equal(getAt(current, `${parent}.id`), identifier, '套餐内菜品顺序已变化');
        query[`${parent}.id`] = identifier;
      }
    }
  }
  if (operation.collection === 'posts') {
    query.status = 'published';
    query.kind = current.kind;
  }
  if (operation.collection === 'imports') {
    assert.deepEqual(current, from, '暂存来源已变化，不计算过期的内容摘要');
  }
  const expected = setIngredientFields(current, fields);
  return { alreadyApplied: false, query, update: { $set: fields }, expected };
}

export function ingredientRecipes(collection, document) {
  if (collection === 'recipes') return document.value ? [{ field: 'value', recipe: document.value }] : [];
  if (collection === 'posts') return (document.recipes || []).map((recipe, index) => ({ field: `recipes.${index}`, recipe }));
  if (collection === 'imports') return document.kind === importKind && document.recipeDraft ? [{ field: 'recipeDraft', recipe: document.recipeDraft }] : [];
  if (collection === 'shares') return (document.post?.recipes || []).map((recipe, index) => ({ field: `post.recipes.${index}`, recipe }));
  return [];
}

export function inventoryIngredients(collections) {
  const counts = {};
  const amounts = new Map();
  const invalidNumeric = [];
  for (const [collection, documents] of Object.entries(collections)) {
    if (collection === 'families') continue;
    counts[collection] = { documents: documents.length, recipes: 0, ingredients: 0, measured: 0, text: 0 };
    for (const document of documents) {
      for (const { field, recipe } of ingredientRecipes(collection, document)) {
        assert.ok(Array.isArray(recipe.ingredients), `${collection}/${document._id}/${field} 缺少食材数组`);
        counts[collection].recipes += 1;
        for (const [index, ingredient] of recipe.ingredients.entries()) {
          counts[collection].ingredients += 1;
          const location = { collection, documentId: document._id, field: `${field}.ingredients.${index}`, recipeId: recipe.id, title: recipe.title, name: ingredient.name };
          if (ingredient.amountText !== undefined) {
            counts[collection].text += 1;
            const key = JSON.stringify(ingredient.amountText);
            const group = amounts.get(key) || { amountText: ingredient.amountText, count: 0, locations: [] };
            group.count += 1;
            group.locations.push(location);
            amounts.set(key, group);
          } else {
            counts[collection].measured += 1;
            try { validateIngredient(ingredient); }
            catch { invalidNumeric.push({ ...location, ingredient }); }
          }
        }
      }
    }
  }
  return { counts, configuredUnits: UNITS, textPresets: ['适量', '少许'], distinctTextAmounts: [...amounts.values()].sort((first, second) => second.count - first.count), invalidNumeric };
}

export async function assertNoUnresolvedWrite(directory) {
  let pending;
  try { pending = await readJson(path.join(directory, 'write-reconciliation-required.json')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw Object.assign(new Error('上次写入结果未确认，必须查询原任务并核对数据库，禁止重新发起写入'), { taskId: pending.taskId, pending });
}

export function createIdeClient(target, output, executable = '/usr/local/bin/wechatide', safetyDirectory = output) {
  let requestIndex = 0;
  return async (tool, args) => {
    const responseFile = path.join(output, `response-${String(++requestIndex).padStart(4, '0')}.json`);
    const writing = tool === 'cloud_db_write_doc';
    const guardFile = path.join(safetyDirectory, 'write-reconciliation-required.json');
    const intent = { target, tool, args, responseFile, state: 'dispatching', startedAt: new Date().toISOString() };
    if (writing) {
      await assertNoUnresolvedWrite(safetyDirectory);
      await saveNewJson(guardFile, intent);
    }
    let stdout;
    try {
      ({ stdout } = await execute(executable, ['-c', 'Codex', tool, '--appid', target.appid, '--env', target.env, ...args], { encoding: 'utf8', maxBuffer: 64000000, timeout: 90000 }));
    } catch (error) {
      await saveNewJson(responseFile, { state: 'outcome_unknown', message: error.message, stdout: error.stdout || '', stderr: error.stderr || '' });
      if (writing) await saveJson(guardFile, { ...intent, state: 'outcome_unknown', error: error.message });
      throw error;
    }
    const start = stdout.indexOf('{');
    assert.ok(start >= 0, '开发者工具没有返回 JSON');
    let response;
    try { response = JSON.parse(stdout.slice(start)); }
    catch {
      await saveNewJson(responseFile, { state: writing ? 'outcome_unknown' : 'incomplete_read_response', tool, returnedBytes: Buffer.byteLength(stdout) });
      throw Object.assign(new Error('开发者工具截断了大响应，缩小只读分页后再查询'), { code: 'INCOMPLETE_IDE_JSON' });
    }
    await saveNewJson(responseFile, response);
    if (response.pending || response.taskId || response.result?.pending || response.result?.taskId) {
      const taskId = response.taskId || response.result?.taskId;
      if (writing) await saveJson(guardFile, { ...intent, state: 'pending', taskId });
      throw Object.assign(new Error('开发者工具需要确认，停止而不重发'), { taskId });
    }
    assert.equal(response.ok, true, `开发者工具失败：${response.errorType || response.message}`);
    assert.equal(response.result?.success, true, `云端操作失败：${response.result?.message}`);
    if (writing) await unlink(guardFile);
    return response.result;
  };
}

export async function readCollection(call, collection, query = {}, projection) {
  const records = [];
  let expectedTotal;
  let limit = 5;
  while (records.length < 10000) {
    let result;
    try {
      result = await call('cloud_db_read_doc', ['--collection-name', collection, '--query', JSON.stringify(query), '--sort', '[{"key":"_id","direction":1}]', '--limit', String(limit), '--offset', String(records.length), ...(projection ? ['--projection', JSON.stringify(projection)] : [])]);
    } catch (error) {
      if (error.code !== 'INCOMPLETE_IDE_JSON' || limit === 1) throw error;
      limit = Math.max(1, Math.floor(limit / 2));
      continue;
    }
    assert.ok(Array.isArray(result.data), '查询没有返回数组');
    assert.ok(Number.isSafeInteger(result.total) && result.total >= 0, '查询没有返回有效总数');
    if (expectedTotal === undefined) expectedTotal = result.total;
    assert.equal(result.total, expectedTotal, `${collection} 读取中记录总数变化，请重新扫描`);
    records.push(...result.data);
    assert.ok(result.data.every(document => typeof document._id === 'string' && document._id), '查询记录缺少 ID');
    assert.equal(new Set(records.map(document => document._id)).size, records.length, `${collection} 分页重复`);
    if (result.data.length < limit || records.length === expectedTotal) {
      assert.equal(records.length, expectedTotal, `${collection} 分页不完整`);
      return records;
    }
  }
  throw new Error(`${collection} 超出单次核对容量`);
}

async function scan(target, output) {
  await mkdir(output, { recursive: false, mode: 0o700 });
  const call = createIdeClient(target, output);
  const startedAt = new Date().toISOString();
  const scopes = { recipes: {}, posts: { status: 'published' }, imports: { kind: importKind }, shares: { expiresAt: { $gt: Date.parse(startedAt) } } };
  const collections = {};
  for (const [collection, query] of Object.entries(scopes)) {
    collections[collection] = await readCollection(call, collection, query);
    await saveNewJson(path.join(output, `${collection}-before.json`), { target, query, records: collections[collection] });
    console.log(`${collection}: ${collections[collection].length} 条已备份，只读。`);
  }
  const familyIds = [...new Set(collections.recipes.map(document => document.familyId))];
  assert.ok(familyIds.every(id => typeof id === 'string' && id));
  collections.families = [];
  for (const familyId of familyIds) collections.families.push(...await readCollection(call, 'families', { _id: familyId }, { _id: 1, id: 1, revision: 1, updatedAt: 1, deletedAt: 1 }));
  assert.equal(collections.families.length, familyIds.length, '存在找不到家庭的菜谱，停止');
  const backup = { target, startedAt, completedAt: new Date().toISOString(), scopes, collections };
  backup.digest = hash(backup);
  await saveNewJson(path.join(output, 'backup.json'), backup);
  const inventory = inventoryIngredients(collections);
  await saveNewJson(path.join(output, 'inventory.json'), { target, backupDigest: backup.digest, ...inventory });
  console.log(JSON.stringify({ state: 'backed_up_no_writes', target, counts: inventory.counts, distinctTextAmounts: inventory.distinctTextAmounts.length, invalidNumeric: inventory.invalidNumeric.length, output }, null, 2));
}

async function prepare(target, output) {
  const backup = await readJson(path.join(output, 'backup.json'));
  const { digest, ...content } = backup;
  assert.equal(digest, hash(content), '备份内容已变化');
  assert.deepEqual(backup.target, target);
  const review = await readJson(path.join(output, 'semantic-review.json'));
  const reviewedKeys = [...review.amounts.map(entry => entry.from), ...review.groups.flatMap(entry => entry.from)];
  assert.equal(new Set(reviewedKeys).size, reviewedKeys.length, '重复的用量复核规则');
  const operations = [];
  const counts = {};
  const expectedCollections = structuredClone(backup.collections);
  for (const [collection, documents] of Object.entries(backup.collections)) {
    if (collection === 'families') continue;
    counts[collection] = { checkedDocuments: documents.length, changedDocuments: 0, changedIngredients: 0, additionalIngredientRows: 0 };
    for (const [index, document] of documents.entries()) {
      const operation = makeIngredientOperation(collection, document, review);
      if (!operation) continue;
      operations.push(operation);
      expectedCollections[collection][index] = operation.after;
      counts[collection].changedDocuments += 1;
      counts[collection].changedIngredients += operation.changes.length;
      counts[collection].additionalIngredientRows += operation.changes.reduce((sum, change) => sum + change.after.length - 1, 0);
    }
  }
  const inventory = inventoryIngredients(expectedCollections);
  assert.equal(inventory.invalidNumeric.length, 0);
  assert.ok(inventory.distinctTextAmounts.every(entry => ['适量', '少许'].includes(entry.amountText)));
  const plan = { version: 1, preparedAt: new Date().toISOString(), target, backupDigest: digest, reviewDigest: hash(review), configuredUnits: UNITS, scopes: backup.scopes, counts, operations };
  plan.digest = hash(plan);
  await saveNewJson(path.join(output, 'plan.json'), plan);
  await saveNewJson(path.join(output, 'changes.json'), operations.flatMap(operation => operation.changes.map(change => ({ collection: operation.collection, documentId: operation.documentId, ...change }))));
  await saveNewJson(path.join(output, 'expected-inventory.json'), inventory);
  console.log(JSON.stringify({ state: 'planned_no_cloud_writes', digest: plan.digest, counts, operations: operations.length, remainingNonStandardAmounts: 0 }, null, 2));
}

async function readOne(call, collection, documentId, projection) {
  const records = await readCollection(call, collection, { _id: documentId }, projection);
  assert.equal(records.length, 1, `${collection}/${documentId} 未找到唯一记录`);
  return records[0];
}

async function syncReviewedImports(target, output) {
  const plan = await readJson(path.join(output, 'plan.json'));
  const { digest, ...content } = plan;
  assert.equal(digest, hash(content), '执行计划已变化');
  assert.deepEqual(plan.target, target);
  const backup = await readJson(path.join(output, 'backup.json'));
  assert.equal(backup.digest, plan.backupDigest);
  const { digest: backupDigest, ...backupContent } = backup;
  assert.equal(backupDigest, hash(backupContent), '备份摘要不一致');
  const root = path.join(process.cwd(), 'artifacts/recipe-full');
  const overrides = { version: 1, planDigest: digest, recipes: {} };
  for (const document of backup.collections.imports) {
    const operation = plan.operations.find(entry => entry.collection === 'imports' && entry.documentId === document._id);
    const current = operation?.after || document;
    assertStagedRecipe(current);
    const sourceId = new URL(current.sourceUrl).pathname.split('/').filter(Boolean).at(-1);
    assert.match(sourceId, /^\d+$/);
    const raw = await readJson(path.join(root, 'recipes', sourceId, 'source.json'));
    assert.equal(raw.sourceUrl, current.sourceUrl);
    assert.ok(!Object.hasOwn(overrides.recipes, current.sourceUrl), '来源重复，不能覆盖复核结果');
    overrides.recipes[current.sourceUrl] = reviewedIngredientEntry(raw, current.recipeDraft.ingredients);
  }
  const file = path.join(root, 'ingredient-standardization.json');
  await saveNewJson(file, overrides);
  await saveNewJson(path.join(output, 'imports-sync.json'), { file, planDigest: digest, sha256: hash(overrides), sources: Object.keys(overrides.recipes).length });
  console.log(JSON.stringify({ state: 'local_import_rules_prepared', sources: Object.keys(overrides.recipes).length, file }));
}

async function refreshFamily(call, familyId, runDirectory, receipt) {
  const current = await readOne(call, 'families', familyId, { _id: 1, revision: 1, updatedAt: 1, deletedAt: 1 });
  assert.ok(!current.deletedAt && Number.isSafeInteger(current.revision), '家庭不可用，不更改状态');
  const update = { $inc: { revision: 1 }, $set: { updatedAt: Date.now() } };
  receipt.familyRefreshes.push({ familyId, before: current, update, state: 'dispatched_outcome_unknown' });
  await saveJson(path.join(runDirectory, 'receipt.json'), receipt);
  await call('cloud_db_write_doc', ['--action', 'update', '--collection-name', 'families', '--query', JSON.stringify({ _id: familyId, revision: current.revision }), '--update', JSON.stringify(update)]);
  const after = await readOne(call, 'families', familyId, { _id: 1, revision: 1, updatedAt: 1, deletedAt: 1 });
  assert.equal(after.revision, current.revision + 1, '家庭版本刷新出现并发冲突，需要重新核验');
  assert.equal(after.updatedAt, update.$set.updatedAt);
  Object.assign(receipt.familyRefreshes.at(-1), { state: 'verified', after });
  await saveJson(path.join(runDirectory, 'receipt.json'), receipt);
}

async function apply(target, output, { canary = false, rollback = false, verifyOnly = false, expectedDigest }) {
  if (!verifyOnly) await assertNoUnresolvedWrite(output);
  const plan = await readJson(path.join(output, 'plan.json'));
  const { digest, ...content } = plan;
  assert.equal(digest, hash(content), '执行计划已变化');
  assert.equal(digest, expectedDigest, '必须指定已核对计划的 --plan-digest');
  assert.deepEqual(plan.target, target);
  assert.equal(hash(await readJson(path.join(output, 'semantic-review.json'))), plan.reviewDigest);
  assert.deepEqual(plan.configuredUnits, UNITS, '单位配置已变化，需要重新准备计划');
  if (!verifyOnly && !rollback) {
    const readiness = await readJson(path.join(output, 'backend-unit-validation.json'));
    assert.equal(readiness.state, 'verified', '写入前必须验证线上支持全部单位');
    assert.equal(readiness.environment, target.env);
    assert.equal(readiness.appid, target.appid);
    assert.equal(readiness.cleaned, true, '线上单位验证尚未清理完毕');
    assert.equal(readiness.legacyCompatible, true, '必须验证旧客户端的读取和编辑兼容性');
    assert.equal(readiness.ingredientUnitsVersion, INGREDIENT_UNITS_VERSION);
    assert.deepEqual(readiness.units, UNITS);
  }
  const lockPath = path.join(output, 'write.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  const runDirectory = path.join(output, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(runDirectory, { mode: 0o700 });
  await lock.writeFile(JSON.stringify({ pid: process.pid, runDirectory }));
  const call = createIdeClient(target, runDirectory, '/usr/local/bin/wechatide', output);
  const operations = canary ? [plan.operations.find(operation => operation.collection === 'posts')] : plan.operations;
  assert.ok(operations.length && operations.every(Boolean));
  const receipt = { target, planDigest: digest, canary, rollback, verifyOnly, startedAt: new Date().toISOString(), state: 'preflight', operations: [], familyRefreshes: [] };
  const saveReceipt = () => saveJson(path.join(runDirectory, 'receipt.json'), receipt);
  try {
    const currentCollections = {};
    if (!canary) {
      const backup = await readJson(path.join(output, 'backup.json'));
      for (const [collection, query] of Object.entries(plan.scopes)) {
        currentCollections[collection] = await readCollection(call, collection, query);
        assert.deepEqual(currentCollections[collection].map(document => document._id).sort(), backup.collections[collection].map(document => document._id).sort(), `${collection} 范围变化，需要重新扫描`);
      }
    }
    const pending = [];
    for (const operation of operations) {
      const current = canary ? await readOne(call, operation.collection, operation.documentId) : currentCollections[operation.collection].find(document => document._id === operation.documentId);
      const result = ingredientUpdate(operation, current, rollback);
      if (verifyOnly) assert.equal(result.alreadyApplied, true, '仍有未执行的食材变更');
      if (!result.alreadyApplied) pending.push(operation);
    }
    await saveNewJson(path.join(runDirectory, 'before.json'), { target, currentCollections, pendingIds: pending.map(operation => [operation.collection, operation.documentId]) });
    receipt.state = 'preflight_complete';
    await saveReceipt();
    const touchedFamilies = new Set();
    for (const [index, operation] of pending.entries()) {
      const current = await readOne(call, operation.collection, operation.documentId);
      const prepared = ingredientUpdate(operation, current, rollback);
      if (prepared.alreadyApplied) continue;
      const queryPath = path.join(runDirectory, `query-${index}.json`);
      const updatePath = path.join(runDirectory, `update-${index}.json`);
      await saveNewJson(queryPath, prepared.query);
      await saveNewJson(updatePath, prepared.update);
      const entry = { collection: operation.collection, documentId: operation.documentId, state: 'dispatched_outcome_unknown' };
      receipt.operations.push(entry);
      receipt.state = 'writing_not_verified';
      await saveReceipt();
      const result = await call('cloud_db_write_doc', ['--action', 'update', '--collection-name', operation.collection, '--query-file', queryPath, '--update-file', updatePath]);
      entry.requestId = result.requestId;
      const after = await readOne(call, operation.collection, operation.documentId);
      assert.deepEqual(after, prepared.expected, `回读不符：${operation.collection}/${operation.documentId}`);
      entry.state = 'verified';
      if (operation.familyId) touchedFamilies.add(operation.familyId);
      await saveReceipt();
      console.log(`${index + 1}/${pending.length} ${operation.collection}/${operation.documentId} 已回读核对`);
      const next = pending[index + 1];
      if (operation.familyId && next?.familyId !== operation.familyId) {
        await refreshFamily(call, operation.familyId, runDirectory, receipt);
        touchedFamilies.delete(operation.familyId);
      }
    }
    for (const familyId of touchedFamilies) await refreshFamily(call, familyId, runDirectory, receipt);
    if (!canary) {
      const afterCollections = {};
      for (const [collection, query] of Object.entries(plan.scopes)) {
        afterCollections[collection] = await readCollection(call, collection, query);
        const expected = currentCollections[collection].map(document => {
          const operation = plan.operations.find(entry => entry.collection === collection && entry.documentId === document._id);
          return operation ? ingredientUpdate(operation, document, rollback).expected : document;
        });
        assert.deepEqual(afterCollections[collection], expected, `${collection} 最终全量回读不符`);
      }
      if (!rollback) {
        const inventory = inventoryIngredients(afterCollections);
        assert.equal(inventory.invalidNumeric.length, 0);
        assert.ok(inventory.distinctTextAmounts.every(entry => ['适量', '少许'].includes(entry.amountText)));
        receipt.inventory = { counts: inventory.counts, remainingNonStandardAmounts: 0 };
      }
      await saveNewJson(path.join(runDirectory, 'after.json'), { target, collections: afterCollections });
    }
    Object.assign(receipt, { state: canary ? 'canary_verified' : rollback ? 'rollback_verified' : 'verified', completedAt: new Date().toISOString(), changedDocuments: receipt.operations.length });
    await saveReceipt();
    await saveJson(path.join(output, 'latest-run.json'), { runDirectory, ...receipt });
    console.log(JSON.stringify({ state: receipt.state, changedDocuments: receipt.changedDocuments, runDirectory, inventory: receipt.inventory }, null, 2));
  } catch (error) {
    Object.assign(receipt, { state: 'stopped_needs_reconciliation', error: { message: error.message, taskId: error.taskId }, stoppedAt: new Date().toISOString() });
    await saveReceipt();
    throw error;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

async function run() {
  const option = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
  const config = await readJson(path.join(process.cwd(), 'cloudbaserc.json'));
  const source = await readFile(path.join(process.cwd(), '.env.production'), 'utf8');
  const target = { env: option('--env'), appid: source.match(/^WEIXIN_APPID=(.+)$/m)?.[1].trim() };
  assert.ok(target.appid && target.env && target.env === config.envId, '必须明确指定与生产配置一致的 --env');
  const output = path.resolve(option('--output') || '');
  assert.ok(option('--output') && output.startsWith(`${process.cwd()}${path.sep}artifacts${path.sep}`), '输出必须位于项目 artifacts 目录');
  if (process.argv.includes('--scan')) return scan(target, output);
  if (process.argv.includes('--prepare')) return prepare(target, output);
  if (process.argv.includes('--sync-imports')) return syncReviewedImports(target, output);
  if (process.argv.includes('--apply') || process.argv.includes('--verify') || process.argv.includes('--rollback')) return apply(target, output, { canary: process.argv.includes('--canary'), rollback: process.argv.includes('--rollback'), verifyOnly: process.argv.includes('--verify'), expectedDigest: option('--plan-digest') });
  throw new Error('使用 --scan 备份、--prepare 核对、--apply --canary 小批验证、--apply 执行、--verify 回读；--rollback 仅用于明确要求回滚时');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
