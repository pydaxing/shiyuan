import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { readFile, writeFile, mkdir, rename, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv } from 'vite';
import { prepareSource, sameRecipeMethod } from './import-authorized-community.mjs';
import { CATEGORIES, validateRecipe } from '../src/domain/kitchen.js';
import { validateImage } from '../src/domain/presentation.js';

const execute = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const saveJson = async (file, value) => { await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`); await rename(`${file}.tmp`, file); };
export const IMPORT_KIND = 'authorized_recipe_staging_v1';

async function optionalJson(file) {
  try { return await readJson(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function documentDigest(document) {
  const { contentDigest, ...content } = document;
  return digest(stableJson(content));
}

export function buildStagedRecipe(prepared, uploads, target) {
  const { raw, review, assets, files, normalized } = prepared;
  assert.equal(normalized.ready, true);
  assert.equal(normalized.sourceReview.matched, true);
  assert.equal(normalized.completeness.imageBytesVerified, true);
  assert.ok(CATEGORIES.includes(review.category));
  const assetByUrl = new Map();
  const assetByValue = new Map();
  const imageAssets = new Map();
  for (const [sourceUrl, asset] of Object.entries(assets)) {
    const id = `sha256:${asset.sha256}`;
    assetByUrl.set(sourceUrl, id);
    assetByValue.set(asset.fileId, id);
    const uploaded = uploads[asset.sha256];
    const file = files.get(asset.sha256);
    assert.ok(file);
    if (uploaded) {
      assert.equal(uploaded.sourceHash, asset.sha256, '上传回执来源不一致');
      assert.equal(uploaded.uploadHash, file.uploadHash, '上传副本已变更，需要核对，不能复用旧 fileId');
      assert.equal(uploaded.protected, true);
      validateImage(uploaded.fileId);
      assert.ok(uploaded.fileId.startsWith(`cloud://${target.env}.`), '图片不属于目标云环境');
    }
    if (!imageAssets.has(id)) imageAssets.set(id, {
      id, sha256: asset.sha256, width: asset.width, height: asset.height, bytes: asset.bytes,
      sourceUrls: [], uploadHash: file.uploadHash, fileId: uploaded?.fileId || null,
      cloudReferenceStatus: uploaded ? 'receipt_available_not_reverified' : 'not_uploaded',
    });
    imageAssets.get(id).sourceUrls.push(sourceUrl);
  }
  const reference = value => {
    const id = assetByValue.get(value);
    assert.ok(id, '图片未映射到归档，不能构造草稿');
    return id;
  };
  const { image, steps, ...fields } = normalized.recipe;
  const recipeDraft = { ...fields, imageAssetId: reference(image), steps: steps.map(step => {
    const { images, ...text } = step;
    return { ...text, imageAssetIds: images.map(reference) };
  }) };
  assert.equal(recipeDraft.imageAssetId, assetByUrl.get(raw.cover.url));
  raw.steps.forEach((step, index) => assert.deepEqual(recipeDraft.steps[index].imageAssetIds, step.images.map(image => assetByUrl.get(image.url))));
  const { sourceHtml, ...source } = raw;
  const document = {
    _id: `recipe-stage-${digest(raw.sourceUrl)}`, kind: IMPORT_KIND, schemaVersion: 1,
    target: { appid: target.appid, env: target.env }, sourceUrl: raw.sourceUrl,
    status: 'awaiting_assets_and_platform_review', authorizationId: raw.authorizationId,
    source, sourceHtmlFingerprint: digest(sourceHtml), sourceReview: review,
    recipeDraft, assets: [...imageAssets.values()].sort((first, second) => first.id.localeCompare(second.id)),
    validation: { sourceHashMatched: true, imageBytesVerified: true, applicationSchemaPassed: true, category: review.category },
    moderation: { status: 'not_completed', sourceContentReviewIsPlatformApproval: false },
    publiclyPublished: false,
  };
  document.contentDigest = documentDigest(document);
  assert.ok(Buffer.byteLength(JSON.stringify(document)) < 900000, '单条导入记录过大，应单独处理');
  assertStagedRecipe(document);
  return document;
}

export function assertStagedRecipe(document) {
  assert.equal(document.kind, IMPORT_KIND);
  assert.equal(document.schemaVersion, 1);
  assert.equal(document._id, `recipe-stage-${digest(document.sourceUrl)}`);
  assert.equal(document.contentDigest, documentDigest(document), '导入数据摘要不一致');
  assert.equal(document.publiclyPublished, false);
  assert.equal(document.status, 'awaiting_assets_and_platform_review');
  assert.equal(document.moderation.status, 'not_completed');
  assert.equal(document.moderation.sourceContentReviewIsPlatformApproval, false);
  assert.equal(document.sourceReview.approved, true);
  assert.equal(document.sourceReview.sourceUrl, document.sourceUrl);
  assert.equal(document.source.sourceUrl, document.sourceUrl);
  assert.equal(document.sourceReview.sourceHtmlFingerprint, document.sourceHtmlFingerprint);
  assert.equal(document.source.authorizationId, document.authorizationId);
  assert.equal(document.sourceReview.category, document.recipeDraft.category);
  assert.ok(CATEGORIES.includes(document.recipeDraft.category));
  assert.ok(document.recipeDraft.ingredients.length && document.recipeDraft.steps.length);
  const assets = new Map(document.assets.map(asset => [asset.id, asset]));
  assert.equal(assets.size, document.assets.length, '重复的图片标识');
  for (const asset of assets.values()) {
    assert.equal(asset.id, `sha256:${asset.sha256}`);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    if (asset.fileId) {
      validateImage(asset.fileId);
      assert.ok(asset.fileId.startsWith(`cloud://${document.target.env}.`));
    }
  }
  for (const id of [document.recipeDraft.imageAssetId, ...document.recipeDraft.steps.flatMap(step => step.imageAssetIds)]) assert.ok(assets.has(id), '草稿引用缺失的图片');
}

export function materializeStagedRecipe(document, verifiedFiles) {
  assertStagedRecipe(document);
  const resolveImage = id => {
    const asset = document.assets.find(entry => entry.id === id);
    const verified = verifiedFiles[id];
    assert.ok(verified?.confirmed && verified?.fileId && verified?.uploadHash === asset.uploadHash, '图片须上传并回读核对后才能生成应用菜谱');
    validateImage(verified.fileId);
    assert.ok(verified.fileId.startsWith(`cloud://${document.target.env}.`));
    return verified.fileId;
  };
  const { imageAssetId, steps, ...fields } = document.recipeDraft;
  const recipe = { ...structuredClone(fields), image: resolveImage(imageAssetId), steps: steps.map(step => {
    const { imageAssetIds, ...text } = step;
    return { ...text, images: imageAssetIds.map(resolveImage) };
  }) };
  validateRecipe(recipe);
  return recipe;
}

export function selectMissingDocuments(documents, existing) {
  const existingById = new Map(existing.map(document => [document._id, document]));
  assert.equal(new Set(documents.map(document => document._id)).size, documents.length, '批次包含重复来源');
  return documents.filter(document => {
    assertStagedRecipe(document);
    const previous = existingById.get(document._id);
    if (!previous) return true;
    for (const key of Object.keys(document)) assert.ok(isDeepStrictEqual(previous[key], document[key]), `已有记录 ${document._id} 内容不同，停止而不覆盖`);
    return false;
  });
}

export async function prepareAdminBatch(root, target, posts) {
  const queue = await readJson(path.join(root, 'queue.json'));
  const receipt = await readJson(path.join(root, 'publication-receipt.json'));
  const published = new Map();
  for (const post of posts.filter(post => post.status === 'published')) for (const recipe of post.recipes || []) {
    const url = recipe.provenance?.url;
    if (!url) continue;
    assert.ok(!published.has(url), `云端存在重复来源 ${url}`);
    published.set(url, post);
  }
  const records = [];
  const documents = [];
  const methods = [];
  for (const entry of queue.entries.filter(entry => entry.archiveDirectory)) {
    const sourceId = new URL(entry.sourceUrl).pathname.split('/').filter(Boolean).at(-1);
    const review = await optionalJson(path.join(root, 'recipes', sourceId, 'review.json'));
    const record = { sourceId, sourceUrl: entry.sourceUrl, title: review?.importOverrides?.displayTitle || entry.title, category: review?.category || null };
    if (!entry.fullContentCollected) Object.assign(record, { status: 'incomplete_source', reason: '原文不含完整图文步骤' });
    else if (entry.duplicateOf) Object.assign(record, { status: 'duplicate_source', reason: entry.duplicateOf });
    else if (!review?.approved) Object.assign(record, { status: 'review_rejected', reason: review?.notes || '尚未复核' });
    else {
      try {
        const prepared = await prepareSource(root, sourceId);
        const duplicate = methods.find(previous => sameRecipeMethod(previous.recipe, prepared.normalized.recipe));
        if (duplicate) Object.assign(record, { status: 'duplicate_method', reason: duplicate.sourceUrl });
        else {
          methods.push({ sourceUrl: entry.sourceUrl, recipe: { ingredients: prepared.normalized.recipe.ingredients, steps: prepared.normalized.recipe.steps.map(step => ({ text: step.text })) } });
          if (published.has(entry.sourceUrl)) Object.assign(record, { status: 'already_published', postId: published.get(entry.sourceUrl).id });
          else {
            const document = buildStagedRecipe(prepared, receipt.uploads, target);
            documents.push(document);
            Object.assign(record, { status: 'ready_to_stage', documentId: document._id, steps: document.recipeDraft.steps.length, images: document.assets.length, missingUploads: document.assets.filter(asset => !asset.fileId).length });
          }
        }
      } catch (error) { Object.assign(record, { status: 'validation_failed', reason: error.message }); }
    }
    records.push(record);
  }
  return { documents, report: {
    checkedAt: new Date().toISOString(), target, records,
    counts: Object.fromEntries([...new Set(records.map(record => record.status))].map(status => [status, records.filter(record => record.status === status).length])),
    categories: Object.fromEntries(CATEGORIES.map(category => [category, documents.filter(document => document.recipeDraft.category === category).length])),
    totalBytes: Buffer.byteLength(JSON.stringify(documents)), databaseWrites: 0, publiclyPublished: false,
  } };
}

export function unwrapIdeResult(response) {
  if (response.pending || response.taskId || response.result?.pending || response.result?.taskId) throw Object.assign(new Error('开发者工具返回待确认任务，不自动重试或轮询'), { code: 'IDE_CONFIRMATION', taskId: response.taskId || response.result?.taskId });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.result?.success, true, JSON.stringify(response));
  return response.result;
}

export function insertCommand(documents) {
  return JSON.stringify([{ TableName: 'imports', CommandType: 'INSERT', Command: JSON.stringify({ insert: 'imports', documents, ordered: true }) }]);
}

export function splitInsertBatches(documents, maxBytes = 90000) {
  const batches = [];
  let batch = [];
  for (const document of documents) {
    assert.ok(Buffer.byteLength(insertCommand([document])) <= maxBytes, '单条记录超出批量传输限制');
    if (batch.length && Buffer.byteLength(insertCommand([...batch, document])) > maxBytes) { batches.push(batch); batch = []; }
    batch.push(document);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function verifyInsertResult(response, expectedCount) {
  const rows = response.data?.results?.flat();
  assert.equal(rows?.length, 1, '云端未返回单个插入回执');
  const result = rows[0];
  const numeric = value => Number(value?.$numberInt ?? value?.$numberLong ?? value?.$numberDouble ?? value);
  assert.equal(numeric(result.ok), 1, '云端插入失败');
  assert.ok(!result.writeErrors?.length && !result.writeConcernError, '云端部分插入失败，需要回读核对');
  assert.equal(numeric(result.n), expectedCount, '插入回执数量不一致，需要回读核对');
  return response.data.requestId;
}

export function decodeDatabaseJson(value) {
  if (Array.isArray(value)) return value.map(decodeDatabaseJson);
  if (!value || typeof value !== 'object') return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && ['$numberInt', '$numberLong', '$numberDouble'].includes(keys[0])) {
    const numeric = Number(value[keys[0]]);
    assert.ok(Number.isFinite(numeric));
    if (keys[0] !== '$numberDouble') assert.ok(Number.isSafeInteger(numeric));
    return numeric;
  }
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, decodeDatabaseJson(field)]));
}

async function run() {
  const projectRoot = process.cwd();
  const root = path.join(projectRoot, 'artifacts/recipe-full');
  const output = path.join(root, 'admin-import');
  await mkdir(output, { recursive: true });
  const config = loadEnv('production', projectRoot, '');
  const target = { appid: config.WEIXIN_APPID, env: config.VITE_CLOUD_ENV };
  assert.ok(target.appid && target.env);
  assert.equal((await readJson(path.join(projectRoot, 'dist/release/project.config.json'))).appid, target.appid);
  const cliIndex = process.argv.indexOf('--cloudbase-cli');
  const cloudbaseCli = cliIndex === -1 ? null : process.argv[cliIndex + 1];
  if (cliIndex !== -1) assert.ok(cloudbaseCli && path.isAbsolute(cloudbaseCli), '需要腾讯云官方 CLI 的绝对路径');
  const call = async (tool, args) => {
    await new Promise(resolve => setTimeout(resolve, 1250));
    let stdout;
    try { ({ stdout } = await execute('/usr/local/bin/wechatide', ['-c', 'Codex', tool, '--appid', target.appid, '--env', target.env, ...args], { encoding: 'utf8', maxBuffer: 16000000, timeout: 90000 })); }
    catch (error) {
      if (!error.stdout?.includes('{')) throw error;
      stdout = error.stdout;
    }
    const response = JSON.parse(stdout.slice(stdout.indexOf('{')));
    await saveJson(path.join(output, 'last-ide-response.json'), response);
    try { return unwrapIdeResult(response); }
    catch (error) {
      if (error.code === 'IDE_CONFIRMATION') await saveJson(path.join(output, 'pending-task.json'), { tool, target, args, taskId: error.taskId, at: new Date().toISOString(), status: 'pending' });
      throw error;
    }
  };
  const readAll = async (collection, query, projection) => {
    const documents = [];
    const pageSize = cloudbaseCli || projection ? 20 : 1;
    for (let offset = 0; offset < 10000; offset += pageSize) {
      let result;
      if (cloudbaseCli) {
        const command = JSON.stringify([{ TableName: collection, CommandType: 'QUERY', Command: JSON.stringify({ find: collection, filter: query, sort: { _id: 1 }, skip: offset, limit: pageSize, ...(projection ? { projection } : {}) }) }]);
        const { stdout } = await execute(cloudbaseCli, ['db', 'nosql', 'execute', '-e', target.env, '--command', command, '--json'], { encoding: 'utf8', maxBuffer: 16000000, timeout: 90000 });
        const response = JSON.parse(stdout.slice(stdout.indexOf('{')));
        await saveJson(path.join(output, `readback-${collection}-${offset}.json`), response);
        assert.equal(response.data?.results?.length, 1);
        result = { data: decodeDatabaseJson(response.data.results[0]) };
      } else {
        result = await call('cloud_db_read_doc', ['--collection-name', collection, '--query', JSON.stringify(query), '--sort', '[{"key":"_id","direction":1}]', '--limit', String(pageSize), '--offset', String(offset), ...(projection ? ['--projection', JSON.stringify(projection)] : [])]);
      }
      assert.ok(Array.isArray(result.data));
      documents.push(...result.data);
      if (result.data.length < pageSize) return documents;
    }
    throw new Error('超出当前批次容量，停止');
  };
  if (!process.argv.includes('--live')) {
    const posts = await readAll('posts', {}, { id: 1, status: 1, 'recipes.provenance': 1 });
    await saveJson(path.join(output, 'cloud-baseline.json'), { checkedAt: new Date().toISOString(), target, posts });
    const batch = await prepareAdminBatch(root, target, posts);
    await saveJson(path.join(output, 'documents.json'), batch.documents);
    await saveJson(path.join(output, 'inspection.json'), batch.report);
    console.log(JSON.stringify({ ...batch.report, records: undefined }, null, 2));
    return;
  }
  const pending = await optionalJson(path.join(output, 'pending-task.json'));
  assert.ok(!pending || pending.status === 'resolved', `存在待核对确认任务 ${pending?.taskId}，请先查询原任务，不重发写入`);
  const lockPath = path.join(output, 'write.lock');
  const lock = await open(lockPath, 'wx');
  await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  try {
    const documents = await readJson(path.join(output, 'documents.json'));
    assert.ok(documents.length, '没有可导入记录');
    documents.forEach(document => { assertStagedRecipe(document); assert.deepEqual(document.target, target); });
    await call('cloud_db_read_struct', ['--action', 'describeCollection', '--collection-name', 'imports']);
    const posts = await readAll('posts', { status: 'published' }, { 'recipes.provenance': 1 });
    const published = new Set(posts.flatMap(post => post.recipes || []).map(recipe => recipe.provenance?.url));
    const selected = documents.filter(document => !published.has(document.sourceUrl));
    const existing = await readAll('imports', { kind: IMPORT_KIND });
    const missing = selectMissingDocuments(selected, existing);
    if (process.argv.includes('--verify-only')) {
      assert.equal(missing.length, 0, '云端缺少预期记录，核验模式不会补写');
      const receiptPath = path.join(output, 'database-receipt.json');
      const receipt = await readJson(receiptPath);
      assert.deepEqual(receipt.target, target);
      Object.assign(receipt, { state: 'staged_verified', verifiedAt: new Date().toISOString(), verified: selected.length, writesDuringVerification: 0 });
      await saveJson(receiptPath, receipt);
      console.log(JSON.stringify({ state: receipt.state, verified: receipt.verified, writesDuringVerification: 0, publiclyPublished: false }, null, 2));
      return;
    }
    const insertFile = path.join(output, 'insert-documents.json');
    await saveJson(insertFile, missing);
    const receipt = { target, collection: 'imports', kind: IMPORT_KIND, at: new Date().toISOString(), state: 'prepared', selected: selected.length, skippedExisting: selected.length - missing.length, skippedPublished: documents.length - selected.length, intendedIds: missing.map(document => document._id), payloadHash: digest(JSON.stringify(missing)), publiclyPublished: false };
    const receiptPath = path.join(output, 'database-receipt.json');
    await saveJson(receiptPath, receipt);
    if (missing.length) {
      if (cloudbaseCli) {
        const batches = splitInsertBatches(missing);
        receipt.chunks = [];
        for (const [index, batch] of batches.entries()) {
          const chunk = { index, ids: batch.map(document => document._id), state: 'dispatched_outcome_not_yet_verified', payloadHash: digest(insertCommand(batch)) };
          receipt.chunks.push(chunk);
          receipt.state = 'write_dispatched_outcome_not_yet_verified';
          await saveJson(receiptPath, receipt);
          const responseFile = path.join(output, `insert-result-${index}.json`);
          let stdout;
          try { ({ stdout } = await execute(cloudbaseCli, ['db', 'nosql', 'execute', '-e', target.env, '--command', insertCommand(batch), '--json'], { encoding: 'utf8', maxBuffer: 16000000, timeout: 90000 })); }
          catch (error) {
            await saveJson(responseFile, { outcome: 'unknown', message: error.message, stdout: error.stdout || '', stderr: error.stderr || '' });
            throw error;
          }
          const response = JSON.parse(stdout.slice(stdout.indexOf('{')));
          await saveJson(responseFile, response);
          chunk.requestId = verifyInsertResult(response, batch.length);
          chunk.state = 'insert_returned';
          await saveJson(receiptPath, receipt);
          console.log(`批次 ${index + 1}/${batches.length} 已写入 ${batch.length} 条，等待最终回读`);
        }
      } else {
        receipt.state = 'write_dispatched_outcome_not_yet_verified';
        await saveJson(receiptPath, receipt);
        receipt.writeResult = await call('cloud_db_write_doc', ['--action', 'insert', '--collection-name', 'imports', '--documents-file', insertFile]);
      }
      receipt.state = 'write_returned';
      await saveJson(receiptPath, receipt);
    }
    const actual = await readAll('imports', { kind: IMPORT_KIND });
    assert.equal(selectMissingDocuments(selected, actual).length, 0, '云端缺少预期记录');
    Object.assign(receipt, { state: 'staged_verified', verifiedAt: new Date().toISOString(), verified: selected.length, insertedThisRun: missing.length });
    await saveJson(receiptPath, receipt);
    console.log(JSON.stringify({ ...receipt, intendedIds: undefined, chunks: undefined }, null, 2));
  } finally { await lock.close(); await unlink(lockPath); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
