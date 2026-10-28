import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { readFile, writeFile, rename, open, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv } from 'vite';
import { prepareSource, assertSavedRecipe, sameRecipeMethod, uploadArchivedImage, materializePreparedSource } from './import-authorized-community.mjs';
import { createImageTransport, uploadLocalImage } from './authorized-import-transport.mjs';

const execute = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const saveJson = async (file, value) => { await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`); await rename(`${file}.tmp`, file); };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let ideCallStarts = Promise.resolve();
let lastIdeCall = 0;
const waitForIdeSlot = () => ideCallStarts = ideCallStarts.then(async () => {
  await delay(Math.max(0, 1250 - (Date.now() - lastIdeCall)));
  lastIdeCall = Date.now();
});
async function optionalJson(file) {
  try { return await readJson(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

export function resolveCreatedRecipe(recipes, beforeCreationIds, sourceUrl) {
  const matching = recipes.filter(recipe => recipe.provenance?.url === sourceUrl);
  const candidates = matching.filter(recipe => !beforeCreationIds.includes(recipe.id));
  assert.equal(candidates.length, 1, '无法唯一确认本次创建的菜品，停止操作，不删除任何家庭菜品');
  return candidates[0];
}

export function canRemoveImportedRecipe(saved, record, baseline) {
  return Boolean(record.createdForBatch && record.creationSnapshot && isDeepStrictEqual(saved, record.creationSnapshot)
    && !baseline.mealSets.some(mealSet => mealSet.recipeIds.includes(saved.id))
    && !baseline.orders.some(order => order.items?.some(item => item.recipe?.id === saved.id)));
}

export function isRetryableUploadError(error) {
  return error.cloudResponse === true && error.code === 'ESOCKETTIMEDOUT'
    && error.message === 'uploadFile:fail request timeout';
}

export function cloudResultError(value) {
  if (!value?.error) return null;
  return Object.assign(new Error(value.error), {
    code: value.code,
    ...(Number.isInteger(value.serviceCode) ? { serviceCode: value.serviceCode } : {}),
    cloudResponse: true,
  });
}

export async function invokeImportCommand(payload, familyId, target) {
  const cloud = require('services/cloud.js');
  if (getApp().__communityFixture) throw new Error('存在测试夹具');
  if (!familyId || cloud.cloudStatus.value.familyId !== familyId) throw new Error('家庭已变更');
  const response = await wx.cloud.callFunction({ name: target.name, config: { env: target.env }, data: { ...payload, action: 'command', ingredientUnitsVersion: 2 } });
  if (!response.result?.ok) return { error: response.result?.message || '云端未返回有效结果', code: response.result?.code, serviceCode: response.result?.serviceCode };
  return response.result.data;
}

export async function invokeBoundCommand(invoke, payload, wait = delay) {
  const serialized = JSON.stringify(payload);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await invoke('command', JSON.parse(serialized)); }
    catch (error) {
      if (error.cloudResponse !== true || !['INTERNAL', 'RATE_LIMIT'].includes(error.code)) throw error;
      if (attempt === 2) throw Object.assign(new Error(`原请求重试3次仍失败：${error.message}`), { code: 'COMMAND_RETRY_EXHAUSTED', cause: error });
      await wait(error.code === 'RATE_LIMIT' ? 61000 : 5000 * (attempt + 1));
    }
  }
}

function jobProperty(channel) {
  assert.match(channel, /^(?:image[01])?$/);
  return `__authorizedImportJob${channel ? `_${channel}` : ''}`;
}

export async function runImageLanes(files, worker) {
  let firstError;
  await Promise.all([0, 1].map(async lane => {
    for (let index = lane; index < files.length && !firstError; index += 2) {
      try { await worker(files[index], lane); }
      catch (error) { firstError ||= error; }
    }
  }));
  if (firstError) throw firstError;
}

export function deferredIdeSource(source, channel = '') {
  const property = jobProperty(channel);
  return `function(operationId,payloadHash,args){
    const app=getApp();
    const previous=app.${property};
    if(previous&&previous.operationId===operationId){if(previous.payloadHash!==payloadHash)throw new Error('任务内容已变更');return {operationId};}
    if(previous&&previous.status==='running')throw new Error('已有导入操作执行中，不能重发');
    const job=app.${property}={operationId,payloadHash,status:'running'};
    Promise.resolve().then(()=>(${source})(...args)).then(value=>{job.value=value;job.status='completed';},error=>{job.error={message:String(error.message||error),code:error.code};job.status='failed';});
    return {operationId};
  }`;
}

export function createIdeCaller(projectRoot, root, channel = '') {
  jobProperty(channel);
  return async (source, args) => {
    const argsFile = path.join(root, `cloud-operation-args${channel ? `-${channel}` : ''}.json`);
    await saveJson(argsFile, args);
    await waitForIdeSlot();
    let stdout;
    try { ({ stdout } = await execute('/usr/local/bin/wechatide', ['-c', 'Codex', 'automation_evaluate', '--project', path.join(projectRoot, 'dist/release'), '--fn-source', source, '--args-file', argsFile], { encoding: 'utf8', timeout: 90000, maxBuffer: 12000000 })); }
    catch (error) {
      if (error.stdout) throw Object.assign(new Error(error.stdout), { code: 'IDE_OPERATION_UNKNOWN' });
      throw error;
    }
    const result = JSON.parse(stdout.slice(stdout.indexOf('{')));
    if (result.pending || result.taskId || result.result?.pending || result.result?.taskId) {
      const pending = { tool: 'automation_evaluate', taskId: result.taskId || result.result?.taskId, status: 'pending', at: new Date().toISOString() };
      await saveJson(path.join(root, 'import-pending-task.json'), pending);
      throw Object.assign(new Error('需要在开发者工具确认；不重发操作'), { code: 'IDE_CONFIRMATION' });
    }
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result?.success, true, JSON.stringify(result));
    return result.result?.result?.result;
  };
}

export async function readDeferredIdeJob(rawCall, operationId, channel = '') {
  const property = jobProperty(channel);
  const call = (source, args) => rawCall(source.replaceAll('__authorizedImportJob', property), args);
  const metadata = await call('function(operationId){const job=getApp().__authorizedImportJob;if(!job||job.operationId!==operationId)throw new Error("运行任务记录已丢失，需核对云端结果");if(job.status!=="running"&&!job.serialized)job.serialized=JSON.stringify({operationId:job.operationId,payloadHash:job.payloadHash,status:job.status,value:job.value,error:job.error});return {operationId:job.operationId,payloadHash:job.payloadHash,status:job.status,length:job.serialized?.length||0,inline:job.serialized?.length<=8000?job.serialized:null};}', [operationId]);
  assert.equal(metadata?.operationId, operationId);
  if (metadata.status === 'running') return metadata;
  assert.ok(Number.isSafeInteger(metadata.length) && metadata.length > 0 && metadata.length <= 12000000, '运行回执长度无效，停止核对');
  let serialized = metadata.inline || '';
  if (serialized) assert.equal(serialized.length, metadata.length);
  for (let offset = serialized.length; offset < metadata.length; offset += 8000) {
    const fragment = await call('function(operationId,offset){const job=getApp().__authorizedImportJob;if(!job||job.operationId!==operationId||!job.serialized)throw new Error("运行回执已丢失");return {operationId,offset,length:job.serialized.length,text:job.serialized.slice(offset,offset+8000)};}', [operationId, offset]);
    assert.equal(fragment.operationId, operationId);
    assert.equal(fragment.offset, offset);
    assert.equal(fragment.length, metadata.length);
    assert.equal(fragment.text.length, Math.min(8000, metadata.length - offset));
    serialized += fragment.text;
  }
  const job = JSON.parse(serialized);
  assert.equal(job.operationId, operationId);
  assert.equal(job.payloadHash, metadata.payloadHash);
  assert.equal(job.status, metadata.status);
  return job;
}

export function createIdeEvaluator(projectRoot, root, channel = '') {
  jobProperty(channel);
  const suffix = channel ? `-${channel}` : '';
  const pendingPath = path.join(root, `import-runtime-pending${suffix}.json`);
  const call = createIdeCaller(projectRoot, root, channel);
  return async (source, args = []) => {
    let value;
    if (/^\s*async\s+function\b/.test(source)) {
      assert.ok(!await optionalJson(pendingPath), '旧运行任务待核对，不能重新发送云端操作');
      const operationId = randomUUID();
      const payloadHash = hash(JSON.stringify({ source, args }));
      await saveJson(pendingPath, { operationId, payloadHash, status: 'dispatching', startedAt: new Date().toISOString() });
      const accepted = await call(deferredIdeSource(source, channel), [operationId, payloadHash, args]);
      assert.equal(accepted?.operationId, operationId, '运行任务没有返回匹配回执，不重发');
      const deadline = Date.now() + 90000;
      let job;
      do {
        await delay(100);
        job = await readDeferredIdeJob(call, operationId, channel);
        assert.equal(job?.operationId, operationId);
        assert.equal(job.payloadHash, payloadHash);
      } while (job.status === 'running' && Date.now() < deadline);
      assert.ok(['completed', 'failed'].includes(job.status), '云端任务仍未返回结果，停止并保留任务，不重复执行');
      await saveJson(path.join(root, `import-runtime-last-result${suffix}.json`), { ...job, receivedAt: new Date().toISOString() });
      await unlink(pendingPath);
      if (job.status === 'failed') throw Object.assign(new Error(job.error.message), { code: job.error.code });
      value = job.value;
    } else value = await call(source, args);
    const failure = cloudResultError(value);
    if (failure) throw failure;
    return value;
  };
}

export async function preflightBatch(root) {
  const queue = await readJson(path.join(root, 'queue.json'));
  const results = [];
  for (const entry of queue.entries.filter(item => item.archiveDirectory)) {
    const sourceId = new URL(entry.sourceUrl).pathname.split('/').filter(Boolean).at(-1);
    const review = await optionalJson(path.join(root, 'recipes', sourceId, 'review.json'));
    const result = { sourceId, sourceUrl: entry.sourceUrl, title: review?.importOverrides?.displayTitle || entry.title, category: review?.category || null };
    if (!entry.fullContentCollected) Object.assign(result, { status: 'incomplete_source', reason: '来源未提供完整图文用料和步骤' });
    else if (entry.duplicateOf) Object.assign(result, { status: 'duplicate_source', reason: entry.duplicateOf });
    else if (review?.approved !== true) Object.assign(result, { status: review ? 'review_rejected' : 'awaiting_review', reason: review?.notes || '尚未完成来源及分类核对' });
    else {
      try {
        const prepared = await prepareSource(root, sourceId);
        Object.assign(result, { status: 'ready', images: prepared.files.size, steps: prepared.normalized.recipe.steps.length });
      } catch (error) { Object.assign(result, { status: 'preflight_failed', reason: error.message }); }
    }
    results.push(result);
  }
  const report = { generatedAt: new Date().toISOString(), records: results, counts: Object.fromEntries([...new Set(results.map(item => item.status))].map(status => [status, results.filter(item => item.status === status).length])) };
  await saveJson(path.join(root, 'import-preflight.json'), report);
  return report;
}

async function run() {
  const projectRoot = process.cwd();
  const root = path.join(projectRoot, 'artifacts/recipe-full');
  if (!process.argv.includes('--live')) {
    console.log(JSON.stringify((await preflightBatch(root)).counts, null, 2));
    return;
  }
  const plan = await readJson(path.join(root, 'import-preflight.json'));
  const config = loadEnv('production', projectRoot, '');
  const cloudTarget = { name: config.VITE_CLOUD_FUNCTION || 'kitchen', env: config.VITE_CLOUD_ENV };
  const project = await readJson(path.join(projectRoot, 'dist/release/project.config.json'));
  assert.equal(project.appid, config.WEIXIN_APPID, '正式构建与目标小程序不一致');
  assert.ok(cloudTarget.env && (await readdir(path.join(projectRoot, 'dist/release/cloudfunctions'))).includes(cloudTarget.name), '正式云函数配置不完整');
  assert.ok(!plan.records.some(item => item.status === 'awaiting_review'), '必须先核对全部来源');
  const deployment = await optionalJson(path.join(root, 'import-deployment-pending.json'));
  assert.ok(!deployment || deployment.status === 'success', '请先确认云函数更新并核验部署结果，再开始批量导入');
  assert.ok(!await optionalJson(path.join(root, 'import-pending-task.json')), '有开发者工具待确认任务，先核对旧任务，不重发');
  assert.ok(!(await readdir(root)).some(name => /^import-runtime-pending(?:-image[01])?\.json$/.test(name)), '有未核对结果的运行任务，先核对结果，不重发');
  const selectedIds = process.argv.slice(2).filter(value => /^\d+$/.test(value));
  const selected = plan.records.filter(item => item.status === 'ready' && (!selectedIds.length || selectedIds.includes(item.sourceId)));
  const receiptPath = path.join(root, 'publication-receipt.json');
  const ledgerPath = path.join(root, 'batch-publication-results.json');
  const lockPath = path.join(root, 'publication.lock');
  const lock = await open(lockPath, 'wx');
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), mode: 'authorized-community-batch' }));
  const receipt = await optionalJson(receiptPath) || { createdAt: new Date().toISOString(), familyId: '', uploads: {}, recipes: {} };
  const ledger = await optionalJson(ledgerPath) || { createdAt: new Date().toISOString(), records: {} };
  const evaluate = createIdeEvaluator(projectRoot, root);
  const imageEvaluators = [0, 1].map(lane => createIdeEvaluator(projectRoot, root, `image${lane}`));
  let transport;
  let baseline;
  let lastUpload = 0;
  let useLocalTransport = !process.argv.includes('--ide-transfer');
  let persistence = Promise.resolve();
  const persist = () => persistence = persistence.then(async () => {
    receipt.updatedAt = new Date().toISOString();
    ledger.updatedAt = receipt.updatedAt;
    await saveJson(receiptPath, receipt);
    await saveJson(ledgerPath, ledger);
  });
  let uploadStarts = Promise.resolve();
  const waitForUploadSlot = () => uploadStarts = uploadStarts.then(async () => {
    await delay(Math.max(0, 1700 - (Date.now() - lastUpload)));
    lastUpload = Date.now();
  });
  const invoke = (action, payload = {}) => action === 'command'
    ? evaluate(invokeImportCommand.toString(), [payload, baseline?.familyId || '', cloudTarget])
    : evaluate('async function(action,payload,familyId){const cloud=require("services/cloud.js");if(getApp().__communityFixture)throw new Error("存在测试夹具");if(familyId&&cloud.cloudStatus.value.familyId!==familyId)throw new Error("家庭已变更");try{return await cloud.invokeCloud(action,payload);}catch(error){return {error:error.message,code:error.code,serviceCode:error.serviceCode};}}', [action, payload, baseline?.familyId || '']);
  const refresh = async () => {
    const snapshot = await invoke('bootstrap', { includeFeed: false });
    if (baseline) assert.equal(snapshot.familyId, baseline.familyId, '家庭已变更');
    baseline = { familyId: snapshot.familyId, revision: snapshot.revision, recipes: snapshot.snapshot.recipes, mealSets: snapshot.snapshot.mealSets, orders: snapshot.snapshot.orders };
    return baseline;
  };
  const command = async (name, args, record) => {
    const payloadHash = hash(JSON.stringify({ name, args }));
    const previous = record.requestPayloads?.[name];
    if (previous) assert.equal(previous.payloadHash, payloadHash, '已提交请求的内容不能在恢复时修改');
    const requestId = previous?.requestId || `authorized-${hash(`${baseline.familyId}:${record.sourceUrl}:${name}:${JSON.stringify(args)}`).slice(0, 56)}`;
    record.requests = { ...record.requests, [name]: requestId };
    record.requestPayloads = { ...record.requestPayloads, [name]: previous || { requestId, payloadHash, args: structuredClone(args) } };
    await persist();
    const result = await invokeBoundCommand(invoke, { name, args, requestId, revision: baseline.revision, includeFeed: false, responseMode: 'changes' });
    assert.equal(result.familyId, baseline.familyId);
    if (previousBlocker?.status === 'blocked' && name === 'saveRecipe' && result.changes?.recipes) {
      previousBlocker.status = 'resolved';
      previousBlocker.resolvedAt = new Date().toISOString();
      previousBlocker.verifiedRequestId = requestId;
      await saveJson(blockerPath, previousBlocker);
      delete ledger.serviceBlocker;
    }
    baseline.revision = result.revision;
    if (result.snapshot) baseline.recipes = result.snapshot.recipes;
    else if (result.changes?.recipes) baseline.recipes = result.changes.recipes;
    return result;
  };
  const cleanup = async (record, normalized) => {
    if (!record.createdForBatch || record.privateRemoved) return;
    await refresh();
    const saved = baseline.recipes.find(item => item.id === record.recipeId);
    if (saved) {
      if (!canRemoveImportedRecipe(saved, record, baseline)) {
        record.privateRetainedReason = '菜品已被修改、被套餐或订单引用，或缺少创建快照；保留家庭菜品';
        await persist();
        return;
      }
      await command('removeFamilyEntry', [record.recipeId, 'dish'], record);
    }
    record.privateRemoved = true;
    await persist();
  };
  const upload = async (file, imageEvaluate) => {
    if (useLocalTransport) {
      try { return await uploadLocalImage(imageEvaluate, transport, file, baseline.familyId); }
      catch (error) {
        if (error.code !== 'IMAGE_TRANSPORT_UNREACHABLE') throw error;
        useLocalTransport = false;
        ledger.transport = 'ide-chunks';
        console.log('本机地址未列入开发者工具域名许可，保留安全配置，使用已验证的IDE分段传输。');
      }
    }
    return uploadArchivedImage(imageEvaluate, file, baseline.familyId);
  };
  try {
    await refresh();
    assert.ok(baseline.familyId, '请先加入家庭');
    if (receipt.familyId) assert.equal(receipt.familyId, baseline.familyId, '当前家庭与历史回执不一致');
    receipt.familyId = baseline.familyId;
    ledger.familyId = baseline.familyId;
    ledger.running = true;
    ledger.transport = useLocalTransport ? 'loopback' : 'ide-chunks';
    ledger.preflightCounts = plan.counts;
    await saveJson(path.join(root, 'batch-live-baseline.json'), { fetchedAt: new Date().toISOString(), ...baseline });
    const knownPosts = [];
    let cursor = '';
    do {
      const page = await invoke('feed', { cursor, compact: false });
      knownPosts.push(...page.posts);
      cursor = page.cursor;
      assert.ok(knownPosts.length <= 10000, '广场过大，请使用服务端来源索引');
    } while (cursor);
    transport = await createImageTransport();
    for (const candidate of selected) {
      const sourceUrl = candidate.sourceUrl;
      ledger.currentSource = sourceUrl;
      ledger.records[sourceUrl] = { ...candidate, status: 'processing', startedAt: new Date().toISOString() };
      await persist();
      try {
        const source = await prepareSource(root, candidate.sourceId);
        const prior = receipt.recipes[sourceUrl];
        const projectionFingerprint = hash(JSON.stringify(source.normalized.recipe));
        if (prior?.projectionFingerprint) assert.equal(prior.projectionFingerprint, projectionFingerprint, '复核产物在导入期间变更，停止恢复并保留旧请求');
        if (prior?.createdForBatch || prior?.creationIntent) assert.equal(prior.sourceFingerprint, source.normalized.contentFingerprint, '续传期间来源内容已变更，需先核对已有记录');
        const publicPost = knownPosts.find(post => post.recipes?.length === 1 && post.recipes[0].provenance?.url === sourceUrl);
        if (publicPost && (!prior?.createdForBatch || prior?.privateRemoved)) {
          const assets = Object.fromEntries(Object.entries(source.assets).map(([url, asset]) => [url, { ...asset, fileId: receipt.uploads[asset.sha256]?.fileId }]));
          const expected = await materializePreparedSource(source, assets);
          assert.equal(expected.publicPublishingAllowed, true, '已有分享缺少可核验的图片映射，不冒充完整核验');
          assertSavedRecipe(publicPost.recipes[0], expected.recipe);
          assert.deepEqual(publicPost.categories, [source.review.category]);
          ledger.records[sourceUrl] = { ...candidate, status: 'already_published', postId: publicPost.id, verifiedAt: new Date().toISOString() };
          await persist();
          console.log(`已存在并核对类目：${candidate.title}`);
          continue;
        }
        const duplicate = knownPosts.find(post => post.recipes?.length === 1 && post.recipes[0].provenance?.url !== sourceUrl && sameRecipeMethod(post.recipes[0], source.normalized.recipe));
        if (duplicate) {
          ledger.records[sourceUrl] = { ...candidate, status: 'duplicate_cloud', duplicateOf: duplicate.id };
          await persist();
          continue;
        }
        const record = receipt.recipes[sourceUrl] = { ...prior, sourceUrl, title: candidate.title, sourceFingerprint: source.normalized.contentFingerprint, projectionFingerprint };
        if (!record.stage) record.stage = 'uploading';
        await persist();
        const uploadOne = async ([sourceHash, file], lane = 0) => {
          if (receipt.uploads[sourceHash]) return;
          receipt.uploadIntents ||= {};
          const previousUpload = receipt.uploadIntents[sourceHash];
          assert.ok(!previousUpload || !['cloud_requested', 'unknown'].includes(previousUpload.stage), '上次图片上传结果未知，必须先核对，不能重复上传');
          const intent = receipt.uploadIntents[sourceHash] = { sourceHash, uploadHash: file.uploadHash, sourceUrl, stage: 'transferring', startedAt: new Date().toISOString() };
          await persist();
          const imageEvaluate = async (source, args) => {
            if (/invokeCloud\(['"]mediaUpload['"]/.test(source)) { intent.stage = 'cloud_requested'; await persist(); }
            return imageEvaluators[lane](source, args);
          };
          await waitForUploadSlot();
          let uploaded;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            intent.attempts = attempt + 1;
            try { uploaded = await upload(file, imageEvaluate); break; }
            catch (error) {
              const storageTimeout = isRetryableUploadError(error);
              intent.stage = storageTimeout ? 'rejected_before_registration' : ['RATE_LIMIT', 'IMAGE_FORMAT', 'IMAGE_SIZE', 'INVALID', 'IMAGE_TRANSPORT_UNREACHABLE'].includes(error.code) ? 'rejected_before_write' : intent.stage === 'cloud_requested' ? 'unknown' : 'transfer_failed';
              intent.code = error.code;
              intent.failures = [...(intent.failures || []), { code: error.code, message: error.message, cloudResponse: error.cloudResponse === true, at: new Date().toISOString() }];
              if (storageTimeout) intent.possibleUnregisteredStorageObject = true;
              await persist();
              if (error.code !== 'RATE_LIMIT' && !storageTimeout) throw error;
              if (attempt === 2) throw Object.assign(new Error(`图片上传重试3次仍失败：${error.message}`), { code: 'IMAGE_RETRY_EXHAUSTED' });
              console.log(`图片暂时失败，稍后重试：${candidate.title} ${error.code}`);
              await delay(error.code === 'RATE_LIMIT' ? 61000 - Date.now() % 60000 : 5000 * (attempt + 1));
              await waitForUploadSlot();
            }
          }
          assert.match(uploaded.fileId, /^cloud:\/\//);
          receipt.uploads[sourceHash] = { fileId: uploaded.fileId, protected: uploaded.protected, uploadHash: file.uploadHash, sourceHash, uploadedAt: new Date().toISOString() };
          intent.stage = 'confirmed';
          await persist();
        };
        const pendingImages = [...source.files].filter(([sourceHash]) => !receipt.uploads[sourceHash]);
        if (useLocalTransport) { for (const file of pendingImages) await uploadOne(file); }
        else await runImageLanes(pendingImages, uploadOne);
        const assets = Object.fromEntries(Object.entries(source.assets).map(([url, asset]) => [url, { ...asset, fileId: receipt.uploads[asset.sha256].fileId }]));
        const normalized = await materializePreparedSource(source, assets);
        assert.equal(normalized.publicPublishingAllowed, true, JSON.stringify(normalized.issues));
        if (!publicPost) {
          await refresh();
          let saved = record.recipeId ? baseline.recipes.find(recipe => recipe.id === record.recipeId) : baseline.recipes.find(recipe => recipe.provenance?.url === sourceUrl);
          if (!record.recipeId && record.creationIntent) {
            const frozen = record.requestPayloads?.saveRecipe;
            assert.ok(frozen?.requestId && frozen.args, '上次创建缺少完整请求绑定，停止恢复');
            assert.deepEqual(frozen.args, [normalized.recipe], '不能更改未完成请求内容');
            const result = await command('saveRecipe', frozen.args, record);
            saved = resolveCreatedRecipe(baseline.recipes, record.creationIntent.recipeIdsBeforeCreation, sourceUrl);
            assertSavedRecipe(saved, normalized.recipe);
            record.recipeId = saved.id;
            record.createdForBatch = Boolean(result.changes?.recipes);
            if (record.createdForBatch) record.creationSnapshot = structuredClone(saved);
            else record.privateRetainedReason = '原请求已完成，但无法仅凭回放归属创建快照；保留家庭菜品';
            record.creationRecoveredAt = new Date().toISOString();
            await persist();
          }
          if (!record.recipeId && !saved) {
            const beforeCreationIds = baseline.recipes.map(recipe => recipe.id);
            record.creationIntent = { recipeIdsBeforeCreation: beforeCreationIds, startedAt: new Date().toISOString() };
            await persist();
            await command('saveRecipe', [normalized.recipe], record);
            saved = resolveCreatedRecipe(baseline.recipes, beforeCreationIds, sourceUrl);
            record.createdForBatch = true;
            record.creationSnapshot = structuredClone(saved);
          } else if (!record.recipeId) {
            record.createdForBatch = false;
          }
          assertSavedRecipe(saved, normalized.recipe);
          record.recipeId = saved.id;
          record.stage = 'saved_private';
          await persist();
        }
        const postId = publicPost?.id || (await command('publishToCommunity', [record.recipeId, 'dish'], record)).value;
        record.postId = postId;
        record.stage = 'published_pending_readback';
        await persist();
        const published = await invoke('readPost', { postId, paginateComments: true });
        assert.equal(published.post.status, 'published');
        assertSavedRecipe(published.post.recipes[0], normalized.recipe);
        assert.deepEqual(published.post.categories, [source.review.category]);
        Object.assign(record, { stage: 'published_verified', publishedAt: new Date().toISOString(), steps: normalized.recipe.steps.length, images: source.files.size });
        await saveJson(path.join(source.directory, 'cloud-readback.json'), published);
        if (!publicPost) knownPosts.push(published.post);
        const queue = await readJson(path.join(root, 'queue.json'));
        Object.assign(queue.entries.find(entry => entry.sourceUrl === sourceUrl), { status: 'published', publishedPostId: postId, familyRecipeId: record.recipeId });
        await saveJson(path.join(root, 'queue.json'), queue);
        ledger.records[sourceUrl] = { ...candidate, status: 'published_verified', postId, verifiedAt: new Date().toISOString() };
        await persist();
        await cleanup(record, normalized);
        console.log(`已发布并回读：${candidate.title} [${candidate.category}] ${source.files.size}图`);
      } catch (error) {
        const published = receipt.recipes[sourceUrl]?.stage === 'published_verified';
        ledger.records[sourceUrl] = { ...candidate, status: published ? 'published_cleanup_pending' : 'failed', ...(published ? { postId: receipt.recipes[sourceUrl].postId } : {}), reason: error.message, code: error.code, failedAt: new Date().toISOString() };
        await persist();
        console.error(`未完成：${candidate.title} ${error.code || ''} ${error.message}`);
        if (!['IMAGE_FORMAT', 'IMAGE_SIZE', 'INVALID', 'IMAGE_RETRY_EXHAUSTED', 'COMMAND_RETRY_EXHAUSTED'].includes(error.code)) throw error;
      }
    }
    await refresh();
    ledger.finalFamilyRecipeCount = baseline.recipes.length;
    const finalCards = [];
    let finalCursor = '';
    do {
      const page = await invoke('feed', { cursor: finalCursor, compact: true });
      finalCards.push(...page.posts);
      finalCursor = page.cursor;
      assert.ok(finalCards.length <= 10000, '最终回读超过核验范围');
    } while (finalCursor);
    for (const candidate of selected) {
      const result = ledger.records[candidate.sourceUrl];
      if (!['published_verified', 'already_published'].includes(result?.status)) continue;
      const matching = finalCards.filter(card => card.id === result.postId);
      assert.equal(matching.length, 1, `最终广场未找到唯一已发布菜谱：${candidate.title}`);
      assert.deepEqual(matching[0].categories, [candidate.category]);
    }
    await saveJson(path.join(root, 'batch-cloud-final.json'), { checkedAt: new Date().toISOString(), familyId: baseline.familyId, selectedCount: selected.length, totalReady: plan.records.filter(item => item.status === 'ready').length, publicCount: finalCards.length, privateRecipeCount: baseline.recipes.length, posts: finalCards });
    receipt.lastRunSucceeded = selected.every(candidate => ['published_verified', 'already_published', 'duplicate_cloud'].includes(ledger.records[candidate.sourceUrl]?.status));
    receipt.lastRunScope = { selectedCount: selected.length, totalReady: plan.records.filter(item => item.status === 'ready').length };
    if (receipt.lastRunSucceeded) delete receipt.lastError;
    else receipt.lastError = { code: 'BATCH_PARTIAL', message: '本批包含未完成项，详见逐条回执', at: new Date().toISOString() };
    console.log(JSON.stringify({ finished: true, selectedCompleted: receipt.lastRunSucceeded, allEligibleCompleted: receipt.lastRunSucceeded && selected.length === receipt.lastRunScope.totalReady, publicCount: finalCards.length, statuses: Object.fromEntries([...new Set(Object.values(ledger.records).map(item => item.status))].map(status => [status, Object.values(ledger.records).filter(item => item.status === status).length])) }, null, 2));
  } catch (error) {
    receipt.lastRunSucceeded = false;
    receipt.lastError = { message: error.message, code: error.code, ...(Number.isInteger(error.serviceCode) ? { serviceCode: error.serviceCode } : {}), at: new Date().toISOString() };
    throw error;
  } finally {
    ledger.running = false;
    delete ledger.currentSource;
    try { await persist(); await transport?.close(); await writeFile(path.join(root, 'cloud-operation-args.json'), '[]\n'); }
    finally { await lock.close(); await unlink(lockPath); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
