import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { preflightBatch, resolveCreatedRecipe, canRemoveImportedRecipe, deferredIdeSource, readDeferredIdeJob, isRetryableUploadError, runImageLanes, invokeBoundCommand, cloudResultError, invokeImportCommand } from '../scripts/publish-authorized-batch.mjs';

test('permanent server errors retain diagnostics and stop without retries', async () => {
  const error = cloudResultError({ error: '没有权限', code: 'FORBIDDEN', serviceCode: 401 });
  assert.equal(error.code, 'FORBIDDEN');
  assert.equal(error.serviceCode, 401);
  assert.equal(error.cloudResponse, true);
  assert.equal(cloudResultError({ value: 'ok' }), null);
  let calls = 0;
  await assert.rejects(invokeBoundCommand(async () => { calls += 1; throw error; }, {}, async () => assert.fail('权限错误不能重试')), { code: 'FORBIDDEN' });
  assert.equal(calls, 1);
});

test('import command keeps normal identity and the complete server error envelope', async () => {
  const calls = [];
  const cloud = { cloudStatus: { value: { familyId: 'family-test' } } };
  const app = {};
  const runtime = { cloud: { async callFunction(options) { calls.push(options); return { result: { ok: false, code: 'INTERNAL', message: '服务暂不可用', serviceCode: 500 } }; } } };
  const invoke = new Function('require', 'getApp', 'wx', `return (${invokeImportCommand.toString()});`)(() => cloud, () => app, runtime);
  const target = { env: 'configured-env', name: 'configured-function' };
  const payload = { name: 'saveRecipe', requestId: 'bound-request', args: [] };
  assert.equal((await invoke(payload, 'family-test', target)).serviceCode, 500);
  assert.deepEqual(calls, [{ name: target.name, config: { env: target.env }, data: { ...payload, action: 'command', ingredientUnitsVersion: 2 } }]);
  await assert.rejects(invoke(payload, 'other-family', target), /家庭已变更/);
  app.__communityFixture = true;
  await assert.rejects(invoke(payload, 'family-test', target), /测试夹具/);
  assert.equal(calls.length, 1);
});

test('confirmed transient command failures retry the identical bound request only', async () => {
  const payload = { requestId: 'stable-request', name: 'saveRecipe', args: [{ title: '菜' }], revision: 8 };
  const calls = [];
  const result = await invokeBoundCommand(async (action, received) => {
    calls.push(structuredClone(received));
    assert.equal(action, 'command');
    if (calls.length === 1) {
      received.args[0].title = 'mutated response adapter';
      throw Object.assign(new Error('temporary'), { code: 'INTERNAL', cloudResponse: true });
    }
    return { value: 'replayed-same-request' };
  }, payload, async () => {});
  assert.equal(result.value, 'replayed-same-request');
  assert.deepEqual(calls, [payload, payload]);
});

test('unknown command outcomes and format failures are not automatically replayed', async () => {
  for (const error of [Object.assign(new Error('unknown'), { code: 'INTERNAL' }), Object.assign(new Error('format'), { code: 'IMAGE_FORMAT', cloudResponse: true })]) {
    let calls = 0;
    await assert.rejects(invokeBoundCommand(async () => { calls += 1; throw error; }, {}, async () => {}), failure => failure === error);
    assert.equal(calls, 1);
  }
  let attempts = 0;
  await assert.rejects(invokeBoundCommand(async () => { attempts += 1; throw Object.assign(new Error('down'), { code: 'INTERNAL', cloudResponse: true }); }, {}, async () => {}), { code: 'COMMAND_RETRY_EXHAUSTED' });
  assert.equal(attempts, 3);
});

test('image lanes are bounded and drain in-flight work before propagating failures', async () => {
  const completed = [];
  let active = 0;
  let peak = 0;
  await assert.rejects(runImageLanes([0, 1, 2, 3, 4], async value => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, value === 0 ? 1 : 20));
    active -= 1;
    if (value === 0) throw new Error('unknown upload');
    completed.push(value);
  }), /unknown upload/);
  assert.equal(active, 0);
  assert.equal(peak, 2);
  assert.deepEqual(completed, [1]);
});

test('image runtime lanes do not overwrite or replay one another', async () => {
  const app = {};
  for (const lane of ['image0', 'image1']) {
    const dispatch = new Function('getApp', `return (${deferredIdeSource('async function(value){return value;}', lane)});`)(() => app);
    dispatch(`op-${lane}`, `hash-${lane}`, [lane]);
  }
  await new Promise(resolve => setImmediate(resolve));
  const call = async (source, args) => new Function('getApp', `return (${source});`)(() => app)(...args);
  assert.equal((await readDeferredIdeJob(call, 'op-image0', 'image0')).value, 'image0');
  assert.equal((await readDeferredIdeJob(call, 'op-image1', 'image1')).value, 'image1');
  assert.throws(() => deferredIdeSource('async function(){}', 'injected'), /match/);
});

test('only explicit storage rejection is retryable, never an unknown API or IDE outcome', () => {
  const failure = { cloudResponse: true, code: 'ESOCKETTIMEDOUT', message: 'uploadFile:fail request timeout' };
  assert.equal(isRetryableUploadError(failure), true);
  assert.equal(isRetryableUploadError({ ...failure, cloudResponse: false }), false);
  assert.equal(isRetryableUploadError({ ...failure, message: 'database write timeout' }), false);
  assert.equal(isRetryableUploadError({ ...failure, code: 'IDE_OPERATION_UNKNOWN' }), false);
  assert.equal(isRetryableUploadError({ code: 'IMAGE_FORMAT' }), false);
});

test('large IDE results are read completely in bounded fragments without replaying writes', async () => {
  const expected = { operationId: 'operation', payloadHash: 'payload', status: 'completed', value: { text: '完整图文菜谱🍲'.repeat(20000) } };
  const app = { __authorizedImportJob: structuredClone(expected) };
  let calls = 0;
  const call = async (source, args) => {
    calls += 1;
    const result = new Function('getApp', `return (${source});`)(() => app)(...args);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 64000);
    return result;
  };
  assert.deepEqual(await readDeferredIdeJob(call, 'operation'), expected);
  assert.ok(calls > 2);
  await assert.rejects(readDeferredIdeJob(call, 'other-operation'), /记录已丢失/);
  app.__authorizedImportJob = { operationId: 'pending', payloadHash: 'payload', status: 'running' };
  assert.equal((await readDeferredIdeJob(call, 'pending')).status, 'running');
});

test('deferred IDE execution returns promptly and does not repeat a dispatched cloud operation', async () => {
  const app = {};
  let executions = 0;
  let complete;
  const invoke = () => { executions += 1; return new Promise(resolve => { complete = resolve; }); };
  const dispatch = new Function('getApp', 'invoke', `return (${deferredIdeSource('async function(value){return await invoke(value);}')});`)(() => app, invoke);
  assert.deepEqual(dispatch('operation-1', 'hash-1', ['content']), { operationId: 'operation-1' });
  await Promise.resolve();
  assert.equal(executions, 1);
  assert.equal(app.__authorizedImportJob.status, 'running');
  assert.deepEqual(dispatch('operation-1', 'hash-1', ['content']), { operationId: 'operation-1' });
  assert.throws(() => dispatch('operation-1', 'changed', []), /内容已变更/);
  assert.throws(() => dispatch('operation-2', 'hash-2', []), /执行中/);
  complete({ fileId: 'cloud://test/image' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(executions, 1);
  assert.equal(app.__authorizedImportJob.status, 'completed');
  assert.deepEqual(app.__authorizedImportJob.value, { fileId: 'cloud://test/image' });
});

test('deferred IDE execution preserves cloud errors without resending', async () => {
  const app = {};
  const dispatch = new Function('getApp', `return (${deferredIdeSource('async function(){throw Object.assign(new Error("图片格式不支持"),{code:"IMAGE_FORMAT"});}')});`)(() => app);
  dispatch('operation', 'hash', []);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(app.__authorizedImportJob.error, { message: '图片格式不支持', code: 'IMAGE_FORMAT' });
  assert.equal(app.__authorizedImportJob.status, 'failed');
});

test('only uniquely attributable creations may be cleaned up after publication', () => {
  const sourceUrl = 'https://www.xiachufang.com/recipe/10000/';
  const userRecipe = { id: 'user-created', provenance: { url: sourceUrl } };
  const created = { id: 'batch-created', provenance: { url: sourceUrl } };
  assert.equal(resolveCreatedRecipe([userRecipe, created], ['user-created'], sourceUrl).id, 'batch-created');
  assert.throws(() => resolveCreatedRecipe([created], ['batch-created'], sourceUrl), /无法唯一确认/);
  assert.throws(() => resolveCreatedRecipe([userRecipe, created], [], sourceUrl), /无法唯一确认/);
  assert.throws(() => resolveCreatedRecipe([userRecipe], ['user-created'], sourceUrl), /无法唯一确认/);
});

test('temporary recipe cleanup preserves all user edits, meal sets and orders', () => {
  const recipe = { id: 'created', title: '菜', nutrition: '' };
  const record = { createdForBatch: true, creationSnapshot: recipe };
  const baseline = { mealSets: [], orders: [] };
  assert.equal(canRemoveImportedRecipe(recipe, record, baseline), true);
  assert.equal(canRemoveImportedRecipe({ ...recipe, nutrition: '用户补充' }, record, baseline), false);
  assert.equal(canRemoveImportedRecipe(recipe, record, { ...baseline, mealSets: [{ recipeIds: ['created'] }] }), false);
  assert.equal(canRemoveImportedRecipe(recipe, record, { ...baseline, orders: [{ items: [{ recipe }] }] }), false);
  assert.equal(canRemoveImportedRecipe(recipe, { createdForBatch: true }, baseline), false);
});

test('batch preflight accounts for every archive without approving incomplete or rejected sources', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'authorized-batch-'));
  try {
    const entries = [
      { sourceId: '10001', fullContentCollected: false },
      { sourceId: '10002', fullContentCollected: true },
      { sourceId: '10003', fullContentCollected: true },
      { sourceId: '10004', fullContentCollected: true, duplicateOf: 'https://www.xiachufang.com/recipe/10002/' },
      { sourceId: '10005', fullContentCollected: true },
    ].map(entry => ({ ...entry, title: '来源', sourceUrl: `https://www.xiachufang.com/recipe/${entry.sourceId}/`, archiveDirectory: path.join(root, 'recipes', entry.sourceId) }));
    await writeFile(path.join(root, 'queue.json'), JSON.stringify({ entries }));
    for (const entry of entries) await mkdir(entry.archiveDirectory, { recursive: true });
    await writeFile(path.join(entries[2].archiveDirectory, 'review.json'), JSON.stringify({ approved: false, category: '其他', notes: '广告，不是菜谱' }));
    await writeFile(path.join(entries[4].archiveDirectory, 'review.json'), JSON.stringify({ approved: true, category: '素菜', notes: '缺少归档文件，不能发布' }));
    const report = await preflightBatch(root);
    assert.equal(report.records.length, entries.length);
    assert.deepEqual(report.counts, { incomplete_source: 1, awaiting_review: 1, review_rejected: 1, duplicate_source: 1, preflight_failed: 1 });
    assert.equal(report.records[2].reason, '广告，不是菜谱');
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'import-preflight.json'), 'utf8')), report);
  } finally { await rm(root, { recursive: true, force: true }); }
});
