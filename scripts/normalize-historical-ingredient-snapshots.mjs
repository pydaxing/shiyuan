import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual, promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { SELECTABLE_UNITS, kitchenOrders, localDate, normalizedIngredient, rebuildMealOrder, requirementSignature, shoppingOrders, validatePurchase, validateRecipe } from '../src/domain/kitchen.js';
import { dishPreparationSignature } from '../src/domain/meal-preparation.js';
import { shoppingEditSignature } from '../src/domain/meal-shopping.js';
import { createIdeClient, readCollection, assertNoUnresolvedWrite } from './standardize-live-ingredients.mjs';
import { digest, exactJsonCondition, verifyPendingRecipeWrite } from './normalize-community-recipes.mjs';
import { strictIngredient, assertStrictIngredient } from './strict-ingredient-amounts.mjs';

const execute = promisify(execFile);
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const readOptional = async file => { try { return await readJson(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const saveNew = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const save = async (file, value) => { await writeFile(file + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(file + '.tmp', file); };
const at = (value, field) => field.split('.').reduce((current, key) => current?.[key], value);
const collections = ['orders', 'shares', 'purchases'];
const sortable = rows => [...rows].sort((a, b) => a._id.localeCompare(b._id));
const strict = ingredient => { try { assertStrictIngredient(ingredient); return true; } catch { return false; } };
const defaultOutput = 'artifacts/strict-historical-ingredient-amounts-20261027';
const defaultShareAudit = 'artifacts/strict-ingredient-amounts-20261027/expired-share-audit/records.json';

function assertUniqueRows(rows, collection) {
  assert.ok(Array.isArray(rows), `${collection} 不是完整记录数组`);
  assert.ok(rows.every(row => typeof row?._id === 'string' && row._id), `${collection} 记录缺少 ID`);
  assert.equal(new Set(rows.map(row => row._id)).size, rows.length, `${collection} 记录 ID 重复`);
}

function ingredientCopies(collection, document) {
  if (collection === 'shares') {
    assert.ok(Array.isArray(document.post?.recipes), '分享缺少菜谱正文');
    return document.post.recipes.map((recipe, index) => ({ field: `post.recipes.${index}.ingredients`, recipe }));
  }
  assert.equal(collection, 'orders', '只允许历史订单和失效分享');
  assert.ok(Array.isArray(document.value?.items) && Array.isArray(document.value?.selections), '订单缺少完整 items/selections 双副本');
  return [
    ...document.value.items.map((item, index) => ({ field: `value.items.${index}.recipe.ingredients`, recipe: item.recipe })),
    ...document.value.selections.flatMap((selection, selected) => {
      assert.ok(Array.isArray(selection.items), '订单选择缺少完整 items');
      return selection.items.map((item, index) => ({ field: `value.selections.${selected}.items.${index}.recipe.ingredients`, recipe: item.recipe }));
    }),
  ];
}

function assertEmptyDerivedState(document) {
  for (const field of ['preparationEdits', 'preparedDishes', 'shoppingDrafts']) {
    const records = document.value[field];
    assert.ok(records === undefined || Array.isArray(records) && records.length === 0, `订单有新增或已有 ${field}，停止而不改签名`);
  }
}

function assertOrderCopies(document) {
  const items = document.value.items;
  const byId = new Map(items.map(item => [item.recipe.id, item.recipe.ingredients]));
  assert.equal(byId.size, items.length, '订单 items 内菜谱 ID 重复');
  const selectionIds = new Set();
  for (const selection of document.value.selections) for (const item of selection.items) {
    assert.deepEqual(item.recipe.ingredients, byId.get(item.recipe.id), '订单 items/selections 食材副本不一致');
    selectionIds.add(item.recipe.id);
  }
  assert.deepEqual([...selectionIds].sort(), [...byId.keys()].sort(), '订单双副本菜谱范围不一致');
  const rebuilt = rebuildMealOrder(document.value);
  assert.deepEqual(rebuilt.items.map(item => [item.recipe.id, item.recipe.ingredients]), items.map(item => [item.recipe.id, item.recipe.ingredients]), '重建订单会覆盖规范后的食材');
}

export function setHistoricalIngredientFields(collection, document, fields) {
  assert.ok(['orders', 'shares'].includes(collection), '禁止修改订单/分享以外的集合');
  assert.ok(fields && typeof fields === 'object' && !Array.isArray(fields) && Object.keys(fields).length, '缺少允许更新的字段');
  const allowed = collection === 'orders'
    ? /^value\.(?:items\.\d+|selections\.\d+\.items\.\d+)\.recipe\.ingredients$/
    : /^post\.recipes\.\d+\.ingredients$/;
  const next = structuredClone(document);
  for (const [field, ingredients] of Object.entries(fields)) {
    assert.ok(allowed.test(field), `禁止修改非历史食材字段：${field}`);
    assert.ok(Array.isArray(at(document, field)), `食材字段不存在：${field}`);
    assert.ok(Array.isArray(ingredients) && ingredients.length > 0 && ingredients.length <= 30, '食材行数必须为 1～30');
    ingredients.forEach(assertStrictIngredient);
    const keys = field.split('.');
    const parent = keys.slice(0, -1).reduce((current, key) => current?.[key], next);
    assert.ok(parent && Object.hasOwn(parent, 'ingredients'), `食材字段不存在：${field}`);
    parent.ingredients = structuredClone(ingredients);
  }
  return next;
}

export function historicalIngredientUpdate(operation, current) {
  assert.ok(['orders', 'shares'].includes(operation.collection), '禁止修改订单/分享以外的集合');
  assert.equal(current?._id, operation.documentId, '历史记录已不存在');
  assert.equal(operation.before._id, operation.documentId);
  assert.equal(operation.before.familyId, operation.familyId);
  assert.deepEqual(setHistoricalIngredientFields(operation.collection, operation.before, operation.fields), operation.after, '冻结 after 超出允许字段');
  if (operation.collection === 'orders') {
    assertEmptyDerivedState(operation.before);
    assertEmptyDerivedState(current);
    assertOrderCopies(operation.before);
    assertOrderCopies(operation.after);
  } else {
    assert.ok(Number.isFinite(operation.expiredAtCutoff) && Number.isFinite(operation.before.expiresAt) && operation.before.expiresAt <= operation.expiredAtCutoff, '只允许冻结时已失效的原分享');
  }
  if (isDeepStrictEqual(current, operation.after)) return { alreadyApplied: true, expected: structuredClone(operation.after) };
  assert.deepEqual(current, operation.before, '历史记录出现计划外变化或双副本半更新，停止而不覆盖');
  const query = { _id: operation.documentId, familyId: operation.familyId };
  if (operation.collection === 'orders') query.$expr = exactJsonCondition('$value', operation.before.value);
  else {
    query.expiresAt = operation.before.expiresAt;
    query.revoked = Object.hasOwn(operation.before, 'revoked') ? operation.before.revoked : { $exists: false };
    query.$expr = exactJsonCondition('$$ROOT', operation.before);
  }
  return { alreadyApplied: false, query, update: { $set: structuredClone(operation.fields) }, expected: structuredClone(operation.after) };
}

function purchaseAudit(purchases, orders, projectedOrders) {
  return purchases.map(document => {
    validatePurchase(document.value);
    if (document.value.kind !== 'confirmation') return { documentId: document._id, kind: document.value.kind || 'numeric', preserved: true };
    const purchase = document.value;
    assert.equal(purchase.orderIds.length, 1, '历史确认必须对应原单餐');
    const order = orders.find(row => row.familyId === document.familyId && row.value.id === purchase.orderIds[0]);
    assert.ok(order, '历史采购确认缺少原订单');
    const after = projectedOrders.find(row => row._id === order._id);
    const key = normalizedIngredient(purchase).key;
    return { documentId: document._id, name: purchase.name, amountText: purchase.amountText, orderDocumentId: order._id, orderDate: order.value.date, orderStatus: order.value.status, oldKey: key, storedSignature: purchase.signature, originalSignatureMatches: purchase.signature === requirementSignature(order.value, key), projectedSignatureForOldKey: requirementSignature(after.value, key), preserved: true, reason: '历史确认不计作数字购买数量；保留完整 kind、用量、orderIds 和原 signature。' };
  });
}

export function makeHistoricalPlan(backup, preparedAt = new Date().toISOString()) {
  const { digest: backupDigest, ...body } = backup;
  assert.equal(backupDigest, digest(body), '历史完整备份摘要不符');
  assert.ok(Number.isFinite(backup.referenceAt) && /^\d{4}-\d{2}-\d{2}$/.test(backup.date), '缺少固定审计时间');
  for (const collection of collections) assertUniqueRows(backup.collections[collection], collection);
  assert.deepEqual(backup.scopes.orders, {});
  assert.deepEqual(backup.scopes.purchases, {});
  const shareIds = [...backup.sourceShareIds].sort();
  assert.deepEqual(shareIds, backup.collections.shares.map(row => row._id).sort(), '失效分享超出原审计 ID 范围');
  assert.deepEqual(backup.scopes.shares, { _id: { $in: shareIds } });
  const operations = [];
  const counts = {};
  const derivedSignatures = [];
  for (const collection of ['orders', 'shares']) {
    counts[collection] = { checkedDocuments: backup.collections[collection].length, changedDocuments: 0, checkedIngredients: 0, changedIngredients: 0, changedArrayFields: 0, additionalRows: 0, invalidBefore: 0, invalidAfter: 0 };
    for (const before of sortable(backup.collections[collection])) {
      assert.ok(typeof before.familyId === 'string' && before.familyId, '历史记录缺少家庭归属');
      if (collection === 'shares') assert.ok(Number.isFinite(before.expiresAt) && before.expiresAt <= backup.referenceAt, '原审计分享尚未失效');
      const fields = {};
      const changes = [];
      for (const { field, recipe } of ingredientCopies(collection, before)) {
        validateRecipe(recipe);
        const ingredients = recipe.ingredients.flatMap((ingredient, index) => {
          counts[collection].checkedIngredients += 1;
          if (!strict(ingredient)) counts[collection].invalidBefore += 1;
          const result = strictIngredient(ingredient, { recipe });
          result.ingredients.forEach(assertStrictIngredient);
          if (!isDeepStrictEqual([ingredient], result.ingredients)) changes.push({ field: `${field}.${index}`, recipeId: recipe.id, title: recipe.title, before: ingredient, after: result.ingredients, kind: result.kind, reason: result.reason });
          return result.ingredients;
        });
        assert.ok(ingredients.length > 0 && ingredients.length <= 30, '规范后食材行数不符合菜谱限制');
        validateRecipe({ ...recipe, ingredients });
        assert.deepEqual(ingredients.flatMap(ingredient => strictIngredient(ingredient, { recipe: { ...recipe, ingredients } }).ingredients), ingredients, '转换不幂等');
        if (!isDeepStrictEqual(ingredients, recipe.ingredients)) fields[field] = ingredients;
      }
      if (!Object.keys(fields).length) continue;
      const after = setHistoricalIngredientFields(collection, before, fields);
      const operation = { collection, documentId: before._id, familyId: before.familyId, ...(collection === 'shares' ? { expiredAtCutoff: backup.referenceAt } : {}), before, after, fields, changes };
      historicalIngredientUpdate(operation, before);
      if (collection === 'orders') for (const [index, item] of before.value.items.entries()) {
        const prior = dishPreparationSignature(item);
        const next = dishPreparationSignature(after.value.items[index]);
        if (prior !== next) derivedSignatures.push({ documentId: before._id, recipeId: item.recipe.id, quantity: item.quantity, scale: item.scale ?? 1, beforeSignature: prior, afterSignature: next, shoppingEditSignatureChanged: shoppingEditSignature(before.value, item.recipe.id) !== shoppingEditSignature(after.value, item.recipe.id), persistedSignatureFieldsChanged: [] });
      }
      operations.push(operation);
      counts[collection].changedDocuments += 1;
      counts[collection].changedIngredients += changes.length;
      counts[collection].changedArrayFields += Object.keys(fields).length;
      counts[collection].additionalRows += changes.reduce((sum, change) => sum + change.after.length - 1, 0);
    }
  }
  const projected = Object.fromEntries(collections.map(collection => [collection, backup.collections[collection].map(document => operations.find(operation => operation.collection === collection && operation.documentId === document._id)?.after || document)]));
  assert.deepEqual(kitchenOrders(projected.orders.map(row => row.value), backup.date), kitchenOrders(backup.collections.orders.map(row => row.value), backup.date), '附加计划会改变当前厨房窗口');
  assert.deepEqual(shoppingOrders(projected.orders.map(row => row.value), backup.date), shoppingOrders(backup.collections.orders.map(row => row.value), backup.date), '附加计划会改变当前采购窗口');
  const plan = { version: 1, kind: 'strict_historical_ingredient_snapshots_v1', preparedAt, target: backup.target, date: backup.date, referenceAt: backup.referenceAt, scopes: backup.scopes, sourceShareIds: shareIds, backupDigest, allowedUnits: SELECTABLE_UNITS, textPresets: ['适量', '少许'], counts, operations, audit: { derivedSignatures, purchases: purchaseAudit(backup.collections.purchases, backup.collections.orders, projected.orders), purchaseDocumentsUnchanged: backup.collections.purchases.length, currentWindowUnchanged: true, noFamilyRevisionOrTimestampWrites: true } };
  return { ...plan, digest: digest(plan) };
}

export function validateHistoricalPlan(plan, backup, expectedDigest = plan.digest) {
  const { digest: savedDigest, ...body } = plan;
  assert.equal(savedDigest, expectedDigest, '必须明确提供冻结计划摘要');
  assert.equal(savedDigest, digest(body), '冻结计划摘要不符');
  assert.equal(plan.backupDigest, backup.digest, '计划与完整备份不匹配');
  assert.deepEqual(plan, makeHistoricalPlan(backup, plan.preparedAt), '计划不符合当前严格转换和允许字段');
  return plan;
}

export function verifyHistoricalCollections(plan, backup, current, { allowBefore = false, today = plan.date } = {}) {
  const result = { orders: 0, shares: 0, purchases: 0, alreadyApplied: 0, unapplied: 0, ingredientRows: 0, currentWindowUnchanged: true, purchasesUnchanged: true };
  for (const collection of collections) {
    assertUniqueRows(current[collection], collection);
    assert.deepEqual(current[collection].map(row => row._id).sort(), backup.collections[collection].map(row => row._id).sort(), `${collection} 冻结范围有新增或删除，需要重审`);
    for (const document of current[collection]) {
      const operation = plan.operations.find(entry => entry.collection === collection && entry.documentId === document._id);
      if (operation) {
        const state = historicalIngredientUpdate(operation, document);
        if (!allowBefore) assert.equal(state.alreadyApplied, true, '仍有未应用的历史食材字段');
        result[state.alreadyApplied ? 'alreadyApplied' : 'unapplied'] += 1;
      } else assert.deepEqual(document, backup.collections[collection].find(row => row._id === document._id), `${collection} 非迁移记录变化，停止而不覆盖`);
      result[collection] += 1;
      if (collection !== 'purchases') for (const { recipe } of ingredientCopies(collection, document)) {
        validateRecipe(recipe);
        result.ingredientRows += recipe.ingredients.length;
        if (!allowBefore || !operation) recipe.ingredients.forEach(assertStrictIngredient);
      }
    }
  }
  assert.deepEqual(sortable(current.purchases), sortable(backup.collections.purchases), '采购确认必须完整不变');
  for (const date of new Set([plan.date, today])) {
    assert.deepEqual(kitchenOrders(current.orders.map(row => row.value), date), kitchenOrders(backup.collections.orders.map(row => row.value), date), '当前厨房窗口变化');
    assert.deepEqual(shoppingOrders(current.orders.map(row => row.value), date), shoppingOrders(backup.collections.orders.map(row => row.value), date), '当前采购窗口变化');
  }
  return result;
}

export async function resumeHistoricalPendingWrite(guard, plan, { readPayload = readJson, queryTask, readback, clearGuard, wait, now } = {}) {
  assert.equal(guard?.tool, 'cloud_db_write_doc', '待核对任务不是数据库写入');
  assert.deepEqual(guard.target, plan.target, '待核对任务目标不属于本计划');
  assert.ok(typeof guard.taskId === 'string' && guard.taskId && guard.state === 'pending', '写入结果未知且无原 pending taskId，保留标记，不重发');
  assert.ok(Array.isArray(guard.args) && guard.args.length === 8, '待核对写入参数不完整');
  const [actionFlag, action, collectionFlag, collection, queryFlag, queryFile, updateFlag, updateFile] = guard.args;
  assert.deepEqual([actionFlag, action, collectionFlag, queryFlag, updateFlag], ['--action', 'update', '--collection-name', '--query-file', '--update-file'], '待核对操作不属于安全更新');
  assert.ok(['orders', 'shares'].includes(collection), '待核对集合不在历史范围');
  assert.ok(typeof queryFile === 'string' && typeof updateFile === 'string', '缺少原写入文件');
  const [query, update] = await Promise.all([readPayload(queryFile), readPayload(updateFile)]);
  const operation = plan.operations.find(entry => entry.collection === collection && entry.documentId === query._id);
  assert.ok(operation, '原任务不属于冻结计划');
  const expected = historicalIngredientUpdate(operation, operation.before);
  assert.deepEqual(query, expected.query, '原任务 query 与冻结完整前像不一致');
  assert.deepEqual(update, expected.update, '原任务 update 与冻结计划不一致');
  await verifyPendingRecipeWrite(guard.taskId, { queryTask, readback: () => readback(collection, operation.documentId), expected: operation.after, clearGuard, ...(wait ? { wait } : {}), ...(now ? { now } : {}) });
  return { collection, documentId: operation.documentId, taskId: guard.taskId, state: 'resumed_pending_verified' };
}

async function configuredTarget() {
  const config = await readJson(path.resolve('cloudbaserc.json'));
  const source = await readFile(path.resolve('.env.production'), 'utf8');
  const target = { env: config.envId, appid: source.match(/^WEIXIN_APPID=(.+)$/m)?.[1].trim() };
  assert.ok(target.env && target.appid, '缺少生产目标配置');
  assert.equal(source.match(/^VITE_DATA_MODE=(.+)$/m)?.[1].trim(), 'cloud', '必须使用真实云数据模式');
  return target;
}

async function prepare(output, shareAuditFile) {
  const target = await configuredTarget();
  const shareAudit = await readJson(shareAuditFile);
  assert.deepEqual(shareAudit.target, target, '失效分享审计目标不匹配');
  assertUniqueRows(shareAudit.records, '原失效分享');
  const sourceShareIds = shareAudit.records.map(row => row._id).sort();
  assert.ok(sourceShareIds.length > 0, '缺少原失效分享范围');
  await mkdir(output, { mode: 0o700 });
  const call = createIdeClient(target, output);
  const referenceAt = Date.now();
  const scopes = { orders: {}, shares: { _id: { $in: sourceShareIds } }, purchases: {} };
  const snapshots = {};
  for (const collection of collections) {
    snapshots[collection] = await readCollection(call, collection, scopes[collection]);
    await saveNew(path.join(output, `${collection}-before.json`), { target, query: scopes[collection], records: snapshots[collection] });
    console.log(JSON.stringify({ state: 'read_only_backup', collection, documents: snapshots[collection].length }));
  }
  assert.deepEqual(sortable(snapshots.shares), sortable(shareAudit.records), '原失效分享在审计后变化，需要重审');
  const body = { version: 1, target, referenceAt, date: localDate(new Date(referenceAt)), startedAt: new Date(referenceAt).toISOString(), completedAt: new Date().toISOString(), sourceShareAudit: path.resolve(shareAuditFile), sourceShareAuditDigest: digest(shareAudit), sourceShareIds, scopes, collections: snapshots };
  const backup = { ...body, digest: digest(body) };
  await saveNew(path.join(output, 'backup.json'), backup);
  const plan = makeHistoricalPlan(backup);
  validateHistoricalPlan(plan, backup);
  const projected = Object.fromEntries(collections.map(collection => [collection, snapshots[collection].map(document => plan.operations.find(operation => operation.collection === collection && operation.documentId === document._id)?.after || document)]));
  const validation = verifyHistoricalCollections(plan, backup, projected);
  await saveNew(path.join(output, 'plan.json'), plan);
  await saveNew(path.join(output, 'changes.json'), plan.operations.flatMap(operation => operation.changes.map(change => ({ collection: operation.collection, documentId: operation.documentId, ...change }))));
  await saveNew(path.join(output, 'audit.json'), plan.audit);
  await saveNew(path.join(output, 'validator.json'), { state: 'prepared_and_locally_validated_no_writes', validationSource: 'in_memory_projected_after_not_live_readback', applicationNotRun: true, planDigest: plan.digest, validation, preparedAt: plan.preparedAt });
  console.log(JSON.stringify({ state: 'prepared_no_writes', digest: plan.digest, operations: plan.operations.length, counts: plan.counts, validation }, null, 2));
}

export async function acquireHistoricalLock(output, resume, metadata = {}) {
  const file = path.join(output, 'write.lock');
  const create = async () => {
    const handle = await open(file, 'wx', 0o600);
    const owner = randomUUID();
    await handle.writeFile(JSON.stringify({ ...metadata, pid: process.pid, owner }));
    return { file, handle, owner };
  };
  try { return await create(); }
  catch (error) {
    if (error.code !== 'EEXIST' || !resume) throw error;
    // Serialize stale-lock recovery. Without this, two resumers can rename
    // each other's newly acquired live lock after observing the same dead PID.
    const recoveryFile = path.join(output, 'lock-recovery.lock');
    const recovery = await open(recoveryFile, 'wx', 0o600);
    const recoveryOwner = randomUUID();
    await recovery.writeFile(JSON.stringify({ pid: process.pid, owner: recoveryOwner }));
    try {
      const old = await readJson(file);
      assert.ok(Number.isInteger(old.pid) && old.pid > 0 && old.pid !== process.pid, '无法安全确认旧锁进程或原进程仍存在');
      let alive = true;
      try { process.kill(old.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; else throw probe; }
      assert.equal(alive, false, '原迁移进程仍存在，禁止并行执行');
      await rename(file, path.join(output, `stale-lock-${Date.now()}-${randomUUID()}.json`));
      return await create();
    } finally {
      await recovery.close();
      assert.equal((await readJson(recoveryFile)).owner, recoveryOwner, '恢复锁归属变化，禁止删除');
      await unlink(recoveryFile);
    }
  }
}

export async function releaseHistoricalLock(lock) {
  assert.equal((await readJson(lock.file)).owner, lock.owner, '写锁归属变化，禁止删除其他进程的锁');
  await lock.handle.close();
  await unlink(lock.file);
}

async function executePlan(output, expectedDigest, { verifyOnly = false, resume = false } = {}) {
  assert.ok(expectedDigest, '执行或核验必须提供 --plan-digest');
  const [plan, backup, target] = await Promise.all([readJson(path.join(output, 'plan.json')), readJson(path.join(output, 'backup.json')), configuredTarget()]);
  validateHistoricalPlan(plan, backup, expectedDigest);
  assert.deepEqual(plan.target, target, '冻结目标与当前生产配置不一致');
  const directory = path.join(output, `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
  const lock = await acquireHistoricalLock(output, resume, { planDigest: plan.digest, runDirectory: directory });
  const receipt = { planDigest: plan.digest, target, runDirectory: directory, verifyOnly, resumed: resume, state: 'preflight', startedAt: new Date().toISOString(), operations: [], recoveries: [] };
  const saveReceipt = async () => { await save(path.join(directory, 'receipt.json'), receipt); await save(path.join(output, 'latest-run.json'), receipt); };
  try {
    await mkdir(directory, { mode: 0o700 });
    const call = createIdeClient(target, directory, '/usr/local/bin/wechatide', output);
    const guardFile = path.join(output, 'write-reconciliation-required.json');
    let readIndex = 0;
    let pollIndex = 0;
    const one = async (collection, id) => {
      const rows = await readCollection(call, collection, { _id: id });
      assert.equal(rows.length, 1, '目标历史记录已不存在');
      await saveNew(path.join(directory, `document-readback-${++readIndex}.json`), { collection, documentId: id, document: rows[0] });
      return rows[0];
    };
    const queryTask = async (taskId, remaining) => {
      const { stdout } = await execute('/usr/local/bin/wechatide', ['-c', 'Codex', 'polling_task_result', '--task-id', taskId], { encoding: 'utf8', timeout: Math.min(30000, remaining), maxBuffer: 2000000 });
      assert.ok(stdout.indexOf('{') >= 0, '原任务查询没有返回 JSON');
      const response = JSON.parse(stdout.slice(stdout.indexOf('{')));
      await saveNew(path.join(directory, `pending-${++pollIndex}.json`), { taskId, response });
      return response;
    };
    const reconcile = async guard => {
      for (const file of [guard.responseFile, guard.args?.[5], guard.args?.[7]]) assert.ok(typeof file === 'string' && path.resolve(file).startsWith(output + path.sep), '原任务证据不在本迁移目录');
      const recovery = await resumeHistoricalPendingWrite(guard, plan, {
        queryTask, readback: one, wait: milliseconds => delay(Math.min(milliseconds, 1000)),
        clearGuard: async taskId => {
          const actual = await readJson(guardFile);
          assert.equal(actual.taskId, taskId);
          assert.deepEqual(actual, guard, '待核对标记在恢复时变化');
          await saveNew(path.join(directory, `reconciled-${receipt.recoveries.length + 1}.json`), { planDigest: plan.digest, guard, verifiedAt: new Date().toISOString() });
          await unlink(guardFile);
        },
      });
      receipt.recoveries.push(recovery);
      await saveReceipt();
      return recovery;
    };
    const outstanding = await readOptional(guardFile);
    if (outstanding) {
      assert.ok(resume, '存在原待核对任务；请带 --resume 仅轮询原 task，禁止重发');
      await reconcile(outstanding);
    }
    await assertNoUnresolvedWrite(output);
    const readScope = async () => {
      const current = {};
      for (const collection of collections) current[collection] = await readCollection(call, collection, plan.scopes[collection]);
      return current;
    };
    const preflight = await readScope();
    await saveNew(path.join(directory, 'before.json'), { target, collections: preflight });
    receipt.preflight = verifyHistoricalCollections(plan, backup, preflight, { allowBefore: !verifyOnly, today: localDate() });
    receipt.state = 'preflight_complete';
    await saveReceipt();
    for (const [index, operation] of plan.operations.entries()) {
      const current = await one(operation.collection, operation.documentId);
      const prepared = historicalIngredientUpdate(operation, current);
      const entry = { collection: operation.collection, documentId: operation.documentId, state: prepared.alreadyApplied ? 'already_verified' : 'prepared', beforeDigest: digest(current), expectedDigest: digest(prepared.expected) };
      receipt.operations.push(entry);
      await saveNew(path.join(directory, `before-${index}.json`), current);
      await saveNew(path.join(directory, `expected-${index}.json`), prepared.expected);
      if (verifyOnly) assert.equal(prepared.alreadyApplied, true, '仍有未应用历史字段');
      if (!prepared.alreadyApplied) {
        const queryFile = path.join(directory, `query-${index}.json`);
        const updateFile = path.join(directory, `update-${index}.json`);
        await saveNew(queryFile, prepared.query);
        await saveNew(updateFile, prepared.update);
        Object.assign(entry, { state: 'dispatched_outcome_unknown', queryFile, updateFile });
        receipt.state = 'writing_not_verified';
        await saveReceipt();
        try {
          await call('cloud_db_write_doc', ['--action', 'update', '--collection-name', operation.collection, '--query-file', queryFile, '--update-file', updateFile]);
        } catch (error) {
          if (!error.taskId) throw error;
          const guard = await readJson(guardFile);
          assert.equal(guard.taskId, error.taskId, '写入错误与原任务不一致');
          entry.taskId = error.taskId;
          await saveReceipt();
          await reconcile(guard);
        }
        const actual = await one(operation.collection, operation.documentId);
        await saveNew(path.join(directory, `after-${index}.json`), actual);
        assert.deepEqual(actual, prepared.expected, '写后完整文档回读不符，停止后续写入');
        entry.state = 'verified';
      } else await saveNew(path.join(directory, `after-${index}.json`), current);
      entry.verifiedAt = new Date().toISOString();
      await saveReceipt();
      console.log(JSON.stringify({ checked: index + 1, total: plan.operations.length, collection: operation.collection, state: entry.state }));
    }
    const after = await readScope();
    await saveNew(path.join(directory, 'after.json'), { target, collections: after });
    receipt.validation = verifyHistoricalCollections(plan, backup, after, { today: localDate() });
    Object.assign(receipt, { state: 'verified', completedAt: new Date().toISOString(), changedDocuments: receipt.operations.filter(entry => entry.state === 'verified').length, alreadyAppliedDocuments: receipt.operations.filter(entry => entry.state === 'already_verified').length });
    await saveReceipt();
    console.log(JSON.stringify({ state: receipt.state, planDigest: plan.digest, changedDocuments: receipt.changedDocuments, alreadyAppliedDocuments: receipt.alreadyAppliedDocuments, validation: receipt.validation, runDirectory: directory }, null, 2));
  } catch (error) {
    Object.assign(receipt, { state: 'stopped_needs_reconciliation', stoppedAt: new Date().toISOString(), error: { message: error.message, taskId: error.taskId } });
    await saveReceipt();
    throw error;
  } finally {
    await releaseHistoricalLock(lock);
  }
}

async function run() {
  const option = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
  const modes = ['--prepare', '--apply', '--verify', '--validate-plan'].filter(mode => process.argv.includes(mode));
  assert.equal(modes.length, 1, '必须选择一个 --prepare/--apply/--verify/--validate-plan 模式');
  const output = path.resolve(option('--output') || defaultOutput);
  assert.ok(output.startsWith(path.join(process.cwd(), 'artifacts') + path.sep), '输出必须位于本项目 artifacts 内');
  if (modes[0] === '--prepare') return prepare(output, path.resolve(option('--share-audit') || defaultShareAudit));
  if (modes[0] === '--validate-plan') {
    const [plan, backup] = await Promise.all([readJson(path.join(output, 'plan.json')), readJson(path.join(output, 'backup.json'))]);
    validateHistoricalPlan(plan, backup, option('--plan-digest') || plan.digest);
    console.log(JSON.stringify({ state: 'frozen_plan_valid_no_cloud_calls', digest: plan.digest, operations: plan.operations.length, counts: plan.counts }, null, 2));
    return;
  }
  return executePlan(output, option('--plan-digest'), { verifyOnly: modes[0] === '--verify', resume: process.argv.includes('--resume') });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await run();
