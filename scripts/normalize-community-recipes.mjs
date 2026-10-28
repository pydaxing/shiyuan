import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual, promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { assertStandardIngredient, standardizeIngredients } from './ingredient-standardization.mjs';
import { assertNoUnresolvedWrite, createIdeClient, readCollection } from './standardize-live-ingredients.mjs';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const executeFile = promisify(execFile);
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const saveNew = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
const saveJson = async (file, value) => {
  await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(`${file}.tmp`, file);
};
const at = (value, field) => field.split('.').reduce((result, key) => result?.[key], value);

export function applyRecipeFields(document, fields) {
  const next = structuredClone(document);
  for (const [field, value] of Object.entries(fields)) {
    assert.ok(/^(?:recipes\.\d+\.(?:minutes|ingredients|steps\.\d+\.title)|card\.recipes\.\d+\.minutes)$/.test(field), `禁止修改审核范围以外的字段：${field}`);
    const keys = field.split('.');
    const parent = keys.slice(0, -1).reduce((result, key) => result?.[key], next);
    assert.ok(parent && typeof parent === 'object', `字段位置不存在：${field}`);
    parent[keys.at(-1)] = structuredClone(value);
  }
  return next;
}

export function validateNormalizedRecipe(recipe) {
  assert.ok(Number.isInteger(recipe.minutes) && recipe.minutes >= 1 && recipe.minutes <= 600, `${recipe.title} 缺少有效预计时间`);
  assert.ok(Array.isArray(recipe.ingredients) && recipe.ingredients.length >= 1 && recipe.ingredients.length <= 30, `${recipe.title} 配料数量不符合约束`);
  recipe.ingredients.forEach(assertStandardIngredient);
  assert.ok(Array.isArray(recipe.steps));
  recipe.steps.forEach(step => assert.ok(typeof step.title === 'string' && step.title.trim() && step.title.length <= 40, `${recipe.title} 步骤标题为空或过长`));
}

export function buildNormalizationPlan(backup, reviews, amountReview) {
  const { digest: backupDigest, ...original } = backup;
  assert.equal(backupDigest, digest(original), '原始备份摘要不符');
  const entries = backup.collections.posts.filter(post => post.status === 'published').flatMap(post => (post.recipes || []).map((recipe, index) => ({ post, recipe, index, key: `${post._id}/${index}` })));
  assert.equal(reviews.length, entries.length, '必须逐份审核所有已发布菜谱');
  const reviewByKey = new Map(reviews.map(review => [review.key, review]));
  assert.equal(reviewByKey.size, entries.length, '语义审核有重复或遗漏');
  const operations = new Map();
  const inspected = [];
  for (const [reviewIndex, { post, recipe, index, key }] of entries.entries()) {
    const review = reviewByKey.get(key);
    assert.ok(review, `缺少审核：${key}`);
    assert.equal(review.index, reviewIndex, '审核索引与备份不一致');
    assert.equal(review.recipeDigest, digest(recipe), `审核对应的原菜谱已变化：${key}`);
    assert.equal(review.stepTitles.length, recipe.steps.length, `${recipe.title} 步骤标题数量不匹配`);
    assert.ok(typeof review.minuteReason === 'string' && review.minuteReason.length >= 6, '预计时间必须附估计依据');
    assert.ok(typeof review.ingredientReason === 'string' && review.ingredientReason.length >= 6, '食材必须附复核依据');
    const ingredients = review.ingredients || standardizeIngredients(recipe.ingredients, amountReview);
    const next = { ...recipe, minutes: review.minutes, ingredients, steps: recipe.steps.map((step, stepIndex) => ({ ...step, title: review.stepTitles[stepIndex] })) };
    validateNormalizedRecipe(next);
    if (Number.isInteger(recipe.minutes) && recipe.minutes >= 1 && recipe.minutes <= 600) assert.equal(next.minutes, recipe.minutes, `不得覆盖已存在的有效时间：${recipe.title}`);
    recipe.steps.forEach((step, stepIndex) => {
      if (step.title?.trim()) assert.equal(next.steps[stepIndex].title, step.title, `不得覆盖已有步骤标题：${recipe.title}`);
    });
    const fields = {};
    if (!isDeepStrictEqual(recipe.minutes, next.minutes)) fields[`recipes.${index}.minutes`] = next.minutes;
    const cardIndex = post.card?.recipes?.findIndex(entry => entry.id === recipe.id) ?? -1;
    if (cardIndex >= 0 && !isDeepStrictEqual(post.card.recipes[cardIndex].minutes, next.minutes)) fields[`card.recipes.${cardIndex}.minutes`] = next.minutes;
    if (!isDeepStrictEqual(recipe.ingredients, next.ingredients)) fields[`recipes.${index}.ingredients`] = next.ingredients;
    recipe.steps.forEach((step, stepIndex) => {
      if (step.title !== next.steps[stepIndex].title) fields[`recipes.${index}.steps.${stepIndex}.title`] = next.steps[stepIndex].title;
    });
    inspected.push({ key, title: recipe.title, stepCount: recipe.steps.length, fieldsChanged: Object.keys(fields).length, minutes: next.minutes, minuteReason: review.minuteReason, ingredientReason: review.ingredientReason });
    if (Object.keys(fields).length) {
      const operation = operations.get(post._id) || { collection: 'posts', documentId: post._id, before: post, fields: {}, changes: [] };
      Object.assign(operation.fields, fields);
      operation.changes.push(inspected.at(-1));
      operations.set(post._id, operation);
    }
  }
  const plan = {
    version: 1, target: backup.target, backupDigest, reviewDigest: digest(reviews), amountReviewDigest: digest(amountReview),
    preparedAt: new Date().toISOString(), scope: { status: 'published' },
    counts: { inspectedPosts: backup.collections.posts.length, publishedPosts: new Set(entries.map(entry => entry.post._id)).size, recipes: entries.length, steps: entries.reduce((sum, entry) => sum + entry.recipe.steps.length, 0), changedPosts: operations.size },
    inspected,
    operations: [...operations.values()].map(operation => ({ ...operation, after: applyRecipeFields(operation.before, operation.fields) })),
  };
  return { ...plan, digest: digest(plan) };
}

// Embedded-document equality depends on BSON key order. Match JSON structure and
// values explicitly, including object key counts, so new ingredient fields cannot
// be silently removed by an array replacement after the preflight read.
export function exactJsonCondition(expression, value, depth = 0) {
  if (value === null) return { $and: [{ $eq: [{ $type: expression }, 'null'] }, { $eq: [expression, { $literal: null }] }] };
  if (typeof value !== 'object') {
    assert.ok(['string', 'number', 'boolean'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value)), 'CAS 仅支持有限 JSON 值');
    return { $eq: [expression, { $literal: value }] };
  }
  const array = Array.isArray(value);
  const entries = Object.entries(value);
  if (!array) for (const [key] of entries) assert.ok(key && !/[.$\0]/.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key), `CAS 字段名不安全：${key}`);
  const variable = `snapshot${depth}`;
  const ref = `$$${variable}`;
  return { $let: { vars: { [variable]: expression }, in: { $cond: [
    { $eq: [{ $type: ref }, array ? 'array' : 'object'] },
    { $and: [
      { $eq: [{ $size: array ? ref : { $objectToArray: ref } }, entries.length] },
      ...entries.map(([key, child]) => exactJsonCondition(array ? { $arrayElemAt: [ref, Number(key)] } : `${ref}.${key}`, child, depth + 1)),
    ] },
    false,
  ] } } };
}

export function guardedRecipeUpdate(operation, current) {
  assert.equal(current?._id, operation.documentId, '目标菜谱不存在');
  assert.equal(current.status, 'published', '菜谱已撤回，停止更新');
  assert.equal(current.kind, operation.before.kind, '美食类型已变化');
  for (const field of ['id', 'familyId', 'familyItemId', 'publisherId']) assert.equal(current[field], operation.before[field], `分享归属已变化：${field}`);
  const fields = Object.keys(operation.fields);
  const matches = document => fields.every(field => isDeepStrictEqual(at(current, field), at(document, field)));
  const cardIndexes = [...new Set(fields.filter(field => field.startsWith('card.recipes.')).map(field => field.split('.')[2]))];
  for (const index of cardIndexes) assert.equal(current.card?.recipes?.[index]?.id, operation.before.card.recipes[index].id, '卡片内菜谱位置已变化');
  const cardRecipeIndexes = cardIndexes.map(index => {
    const recipeIndex = operation.before.recipes.findIndex(recipe => recipe.id === operation.before.card.recipes[index].id);
    assert.ok(recipeIndex >= 0, '卡片菜谱缺少对应正文');
    return String(recipeIndex);
  });
  const recipeIndexes = [...new Set([...fields.filter(field => field.startsWith('recipes.')).map(field => field.split('.')[1]), ...cardRecipeIndexes])];
  for (const index of recipeIndexes) {
    assert.equal(current.recipes?.[index]?.id, operation.before.recipes[index].id, '套餐内菜谱位置已变化');
    assert.equal(current.recipes[index].title, operation.before.recipes[index].title, '菜名已变化，需要重新审核');
    if (!fields.includes(`recipes.${index}.ingredients`)) assert.deepEqual(current.recipes[index].ingredients, operation.before.recipes[index].ingredients, '未修改的配料已变化，需要重新审核');
    if (!fields.includes(`recipes.${index}.minutes`)) assert.equal(current.recipes[index].minutes, operation.before.recipes[index].minutes, '主菜谱时间已变化，需要重新审核卡片');
    assert.equal(current.recipes[index].steps.length, operation.before.recipes[index].steps.length, '步骤数量已变化');
    current.recipes[index].steps.forEach((step, stepIndex) => {
      const { title: _currentTitle, ...currentBody } = step;
      const { title: _beforeTitle, ...beforeBody } = operation.before.recipes[index].steps[stepIndex];
      assert.deepEqual(currentBody, beforeBody, '步骤内容已变化，需要重新审核标题和时间');
    });
  }
  if (matches(operation.after)) return { alreadyApplied: true, expected: current };
  assert.ok(matches(operation.before), `相关字段已被修改，停止而不覆盖：${operation.documentId}`);
  const query = { _id: operation.documentId, status: 'published', kind: operation.before.kind };
  for (const field of ['id', 'familyId', 'familyItemId', 'publisherId']) if (current[field] !== undefined) query[field] = current[field];
  query.$expr = { $and: [
    exactJsonCondition('$recipes', current.recipes),
    ...(cardIndexes.length ? [exactJsonCondition('$card.recipes', current.card.recipes)] : []),
  ] };
  return { alreadyApplied: false, query, update: { $set: operation.fields }, expected: applyRecipeFields(current, operation.fields) };
}

export async function verifyPendingRecipeWrite(taskId, { queryTask, readback, expected, clearGuard, wait = delay, now = Date.now }) {
  assert.ok(typeof taskId === 'string' && taskId, '待确认写入缺少原任务 ID');
  const deadline = now() + 90000;
  try {
    while (now() < deadline) {
      await wait(Math.min(5000, deadline - now()));
      const remaining = deadline - now();
      if (remaining <= 0) break;
      const response = await queryTask(taskId, remaining);
      assert.equal(response?.ok, true, '原任务查询失败，保留待核对标记');
      assert.equal(response.result?.success, true, '原任务查询未确认成功，保留待核对标记');
      assert.equal(response.result.taskId, taskId, '原任务查询返回了不同任务 ID');
      if (response.result.status === 'pending') continue;
      // Only states observed from this tool are accepted. Unknown or failed states stop safely.
      assert.equal(response.result.status, 'success', '原任务未成功或状态未知，保留待核对标记');
      const after = await readback();
      assert.deepEqual(after, expected, '原任务已完成但数据库回读不符，保留待核对标记');
      await clearGuard(taskId);
      return after;
    }
    throw new Error('原任务90秒内未确认完成，保留待核对标记，不重发写入');
  } catch (error) {
    error.taskId = taskId;
    throw error;
  }
}

async function queryIdeTaskResult(taskId, responseFile, timeout) {
  const { stdout } = await executeFile('/usr/local/bin/wechatide', ['-c', 'Codex', 'polling_task_result', '--task-id', taskId], { encoding: 'utf8', maxBuffer: 2000000, timeout });
  const start = stdout.indexOf('{');
  assert.ok(start >= 0, '原任务查询没有返回 JSON');
  const response = JSON.parse(stdout.slice(start));
  await saveNew(responseFile, response);
  return response;
}

async function executePlan(output, planDigest, { canary = false, verifyOnly = false, reverse = false } = {}) {
  const backup = await readJson(path.join(output, 'backup.json'));
  const plan = await readJson(path.join(output, 'plan.json'));
  const { digest: savedDigest, ...planBody } = plan;
  assert.equal(savedDigest, planDigest, '必须明确提供审核计划摘要');
  assert.equal(savedDigest, digest(planBody), '计划内容已变化');
  assert.equal(plan.backupDigest, backup.digest, '计划不属于当前备份');
  const config = await readJson('cloudbaserc.json');
  assert.equal(plan.target.env, config.envId, '目标云环境不符');
  const appid = (await readFile('.env.production', 'utf8')).match(/^WEIXIN_APPID=(.+)$/m)?.[1].trim();
  assert.equal(plan.target.appid, appid, '目标 AppID 不符');
  await assertNoUnresolvedWrite(output);
  const lock = await open(path.join(output, 'write.lock'), 'wx', 0o600);
  const runDirectory = path.join(output, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const receipt = { target: plan.target, planDigest, canary, verifyOnly, startedAt: new Date().toISOString(), state: 'preflight', operations: [] };
  await mkdir(runDirectory, { mode: 0o700 });
  await lock.writeFile(JSON.stringify({ pid: process.pid, runDirectory }));
  const call = createIdeClient(plan.target, runDirectory, '/usr/local/bin/wechatide', output);
  const one = async id => {
    const records = await readCollection(call, 'posts', { _id: id });
    assert.equal(records.length, 1, '目标美食不存在或重复');
    return records[0];
  };
  try {
    const selected = canary ? plan.operations.slice(0, 1) : reverse ? plan.operations.toReversed() : plan.operations;
    const live = await readCollection(call, 'posts', plan.scope);
    const liveById = new Map(live.map(post => [post._id, post]));
    const expectedIds = backup.collections.posts.filter(post => post.status === 'published').map(post => post._id).sort();
    assert.deepEqual(live.map(post => post._id).sort(), expectedIds, '已发布美食范围变化，需要重新审核');
    for (const operation of selected) guardedRecipeUpdate(operation, liveById.get(operation.documentId));
    await saveNew(path.join(runDirectory, 'preflight-backup.json'), { target: plan.target, posts: live });
    for (const [index, operation] of selected.entries()) {
      // Resumed records were already read back after their original writes and
      // have just been checked again in this run's full preflight snapshot.
      // Only records requiring a write need another immediately preceding read.
      const preflightCurrent = liveById.get(operation.documentId);
      const current = guardedRecipeUpdate(operation, preflightCurrent).alreadyApplied ? preflightCurrent : await one(operation.documentId);
      const prepared = guardedRecipeUpdate(operation, current);
      if (verifyOnly) assert.equal(prepared.alreadyApplied, true, `菜谱仍有未执行的变更：${operation.documentId}`);
      if (!prepared.alreadyApplied) {
        const queryFile = path.join(runDirectory, `query-${index}.json`);
        const updateFile = path.join(runDirectory, `update-${index}.json`);
        await saveNew(queryFile, prepared.query);
        await saveNew(updateFile, prepared.update);
        receipt.operations.push({ documentId: operation.documentId, state: 'dispatched_outcome_unknown' });
        receipt.state = 'writing_not_verified';
        await saveJson(path.join(runDirectory, 'receipt.json'), receipt);
        let pendingTaskId;
        try {
          await call('cloud_db_write_doc', ['--action', 'update', '--collection-name', 'posts', '--query-file', queryFile, '--update-file', updateFile]);
        } catch (error) {
          if (!error.taskId) throw error;
          pendingTaskId = error.taskId;
        }
        if (pendingTaskId) {
          let attempt = 0;
          await verifyPendingRecipeWrite(pendingTaskId, {
            queryTask: (taskId, remaining) => queryIdeTaskResult(taskId, path.join(runDirectory, `pending-${index}-${++attempt}.json`), remaining),
            readback: () => one(operation.documentId),
            expected: prepared.expected,
            clearGuard: async taskId => {
              const guardFile = path.join(output, 'write-reconciliation-required.json');
              const guard = await readJson(guardFile);
              assert.equal(guard.taskId, taskId, '待核对标记不属于原写入任务');
              assert.deepEqual(guard.target, plan.target, '待核对标记的云环境已变化');
              await unlink(guardFile);
            },
          });
        } else {
          const after = await one(operation.documentId);
          assert.deepEqual(after, prepared.expected, '回读不符，停止后续写入');
        }
        receipt.operations.at(-1).state = 'verified';
      } else receipt.operations.push({ documentId: operation.documentId, state: 'already_verified' });
      await saveJson(path.join(runDirectory, 'receipt.json'), receipt);
      if ((index + 1) % 20 === 0 || index + 1 === selected.length) console.log(`${index + 1}/${selected.length} 已逐条回读核对`);
    }
    const after = await readCollection(call, 'posts', plan.scope);
    assert.deepEqual(after.map(post => post._id).sort(), expectedIds);
    const selectedIds = new Set(selected.map(operation => operation.documentId));
    for (const post of after) {
      const operation = selected.find(entry => entry.documentId === post._id);
      if (operation) assert.equal(guardedRecipeUpdate(operation, post).alreadyApplied, true);
      if (!canary || selectedIds.has(post._id)) post.recipes.forEach(validateNormalizedRecipe);
    }
    await saveNew(path.join(runDirectory, 'readback.json'), { target: plan.target, posts: after });
    Object.assign(receipt, { state: 'verified', completedAt: new Date().toISOString(), counts: plan.counts });
    await saveJson(path.join(runDirectory, 'receipt.json'), receipt);
    await saveJson(path.join(output, 'latest-run.json'), { runDirectory, ...receipt });
    console.log(JSON.stringify({ state: receipt.state, canary, verifyOnly, checked: receipt.operations.length, runDirectory }));
  } catch (error) {
    Object.assign(receipt, { state: 'stopped_needs_reconciliation', error: { message: error.message, taskId: error.taskId }, stoppedAt: new Date().toISOString() });
    await saveJson(path.join(runDirectory, 'receipt.json'), receipt);
    throw error;
  } finally {
    await lock.close();
    await unlink(path.join(output, 'write.lock'));
  }
}

async function main() {
  const option = name => process.argv[process.argv.indexOf(name) + 1];
  assert.ok(process.argv.includes('--output'));
  const output = path.resolve(option('--output'));
  assert.ok(output.startsWith(`${process.cwd()}${path.sep}artifacts${path.sep}`));
  if (process.argv.includes('--prepare')) {
    const backup = await readJson(path.join(output, 'backup.json'));
    const reviews = await readJson(path.join(output, 'semantic-review.json'));
    const amountReview = await readJson(path.join(output, 'amount-review.json'));
    const plan = buildNormalizationPlan(backup, reviews, amountReview);
    await saveNew(path.join(output, 'plan.json'), plan);
    await saveNew(path.join(output, 'review-summary.json'), { target: plan.target, digest: plan.digest, counts: plan.counts, inspected: plan.inspected });
    console.log(JSON.stringify({ state: 'planned_no_writes', digest: plan.digest, counts: plan.counts }));
    return;
  }
  assert.ok(process.argv.includes('--apply') || process.argv.includes('--verify'));
  assert.ok(process.argv.includes('--plan-digest'));
  await executePlan(output, option('--plan-digest'), { canary: process.argv.includes('--canary'), verifyOnly: process.argv.includes('--verify'), reverse: process.argv.includes('--reverse') });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
