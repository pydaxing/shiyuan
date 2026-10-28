import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, rename, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { normalizeAuthorizedRecipe } from './normalize-authorized-recipes.mjs';
import { normalizeRecipeText } from './recipe-content-dedupe.mjs';
import { applyReviewedIngredients } from './reviewed-ingredient-imports.mjs';
import { validateRecipe } from '../src/domain/kitchen.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const saveJson = async (file, value) => { await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`); await rename(`${file}.tmp`, file); };
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));

export function sameRecipeMethod(first, second) {
  if (!first?.ingredients?.length || !first?.steps?.length || !second?.ingredients?.length || !second?.steps?.length) return false;
  if (![...first.steps, ...second.steps].every(step => typeof step.text === 'string' && step.text.trim())) return false;
  const content = recipe => ({
    ingredients: recipe.ingredients.map(item => ({ name: normalizeRecipeText(item.name), quantity: item.quantity, unit: item.unit, ...(item.amountText === undefined ? {} : { amountText: normalizeRecipeText(item.amountText) }) })),
    steps: recipe.steps.map(step => normalizeRecipeText(step.text)),
  });
  return JSON.stringify(content(first)) === JSON.stringify(content(second));
}

export function assertSavedRecipe(saved, recipe) {
  assert.ok(saved, '云端未返回菜谱');
  for (const key of ['title', 'category', 'minutes', 'image', 'ingredients', 'steps', 'provenance']) assert.deepEqual(saved[key], recipe[key], `云端回读 ${key} 不一致`);
}

export async function materializePreparedSource(source, assets) {
  const normalized = await normalizeAuthorizedRecipe(source.raw, { category: source.review.category, authorizationId: source.raw.authorizationId, assets, review: source.review });
  if (normalized.ready) {
    normalized.recipe.ingredients = structuredClone(source.normalized.recipe.ingredients);
    validateRecipe(normalized.recipe);
  }
  return normalized;
}

export async function uploadArchivedImage(evaluate, file, familyId) {
  const transferId = `${familyId}:${file.uploadHash}`;
  for (let offset = 0; offset < file.base64.length; offset += 48000) {
    const chunk = file.base64.slice(offset, offset + 48000);
    const received = await evaluate('function(transferId,familyId,offset,chunk){const cloud=require("services/cloud.js");if(cloud.cloudStatus.value.familyId!==familyId)throw new Error("家庭已变更");const app=getApp();const transfers=app.__authorizedRecipeImages||(app.__authorizedRecipeImages={});if(offset===0)transfers[transferId]={transferId,base64:""};const transfer=transfers[transferId];if(!transfer||transfer.transferId!==transferId||transfer.base64.length!==offset)throw new Error("图片分段顺序不一致");transfer.base64+=chunk;return transfer.base64.length;}', [transferId, familyId, offset, chunk]);
    assert.equal(received, offset + chunk.length, '图片分段传输不完整');
  }
  return evaluate('async function(transferId,familyId,length){const cloud=require("services/cloud.js");const app=getApp();const transfer=app.__authorizedRecipeImages?.[transferId];if(transfer)delete app.__authorizedRecipeImages[transferId];if(cloud.cloudStatus.value.familyId!==familyId)throw new Error("家庭已变更");if(!transfer||transfer.transferId!==transferId||transfer.base64.length!==length)throw new Error("图片传输不完整");try{return await cloud.invokeCloud("mediaUpload",{base64:transfer.base64});}catch(error){return {error:error.message,code:error.code};}}', [transferId, familyId, file.base64.length]);
}

export async function prepareSource(root, sourceId) {
  assert.match(sourceId, /^\d+$/);
  const directory = path.join(root, 'recipes', sourceId);
  const [raw, manifest, review, authorization] = await Promise.all(['source.json', 'manifest.json', 'review.json'].map(file => readJson(path.join(directory, file))).concat(readJson(path.join(root, 'authorization.json'))));
  assert.equal(manifest.fullContentCollected, true, '图文尚未完整归档');
  assert.equal(manifest.duplicateOf, null, '此菜谱已被内容去重');
  assert.equal(raw.authorizationId, authorization.id, '授权记录不匹配');
  assert.equal(review.sourceUrl, raw.sourceUrl);
  assert.equal(review.sourceHtmlFingerprint, sha256(raw.sourceHtml));
  assert.equal(review.approved, true, '尚未核对原文完整性');
  const assets = structuredClone(manifest.assets);
  const files = new Map();
  await mkdir(path.join(directory, 'upload'), { recursive: true });
  for (const asset of Object.values(assets)) {
    const bytes = await readFile(asset.path);
    assert.equal(sha256(bytes), asset.sha256, '归档图片摘要不符');
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.width, asset.width);
    assert.equal(metadata.height, asset.height);
    assert.ok(!metadata.pages || metadata.pages === 1, '动态图片应先核对完整动作，不擅自转换为静态首帧');
    if (!files.has(asset.sha256)) {
      const upload = metadata.format === 'jpeg' && bytes.length <= 350000 ? bytes : await sharp(bytes).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
      assert.ok(upload.length <= 350000, '压缩图片仍偏大，请单独核对');
      const filePath = path.join(directory, 'upload', `${asset.sha256}.jpg`);
      await writeFile(filePath, upload);
      files.set(asset.sha256, { sourceHash: asset.sha256, uploadHash: sha256(upload), path: filePath, bytes: upload.length, base64: upload.toString('base64') });
    }
    asset.fileId = `data:image/jpeg;base64,${files.get(asset.sha256).base64}`;
  }
  const normalized = await normalizeAuthorizedRecipe(raw, { category: review.category, authorizationId: raw.authorizationId, assets, review });
  assert.equal(normalized.ready, true, `归一化尚未通过: ${JSON.stringify(normalized.issues)}`);
  let ingredientOverrides;
  try { ingredientOverrides = await readJson(path.join(root, 'ingredient-standardization.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  normalized.recipe = applyReviewedIngredients(raw, normalized.recipe, ingredientOverrides);
  validateRecipe(normalized.recipe);
  return { raw, manifest, review, assets, files, directory, normalized };
}

async function run() {
  const sourceIds = process.argv.slice(2).filter(value => /^\d+$/.test(value));
  assert.ok(sourceIds.length, '请指定已审核的来源数字 ID，--live 才会上传与发布');
  const projectRoot = process.cwd();
  const root = path.join(projectRoot, 'artifacts/recipe-full');
  const prepared = [];
  for (const sourceId of sourceIds) prepared.push(await prepareSource(root, sourceId));
  if (!process.argv.includes('--live')) { console.log(JSON.stringify(prepared.map(entry => ({ title: entry.raw.title, ready: entry.normalized.ready, images: entry.files.size, sourceUrl: entry.raw.sourceUrl })), null, 2)); return; }
  const receiptPath = path.join(root, 'publication-receipt.json');
  const lockPath = path.join(root, 'publication.lock');
  let receipt;
  try { receipt = await readJson(receiptPath); } catch (error) { if (error.code !== 'ENOENT') throw error; receipt = { createdAt: new Date().toISOString(), familyId: '', uploads: {}, recipes: {} }; }
  const evaluate = (source, args = []) => {
    const argsFile = path.join(root, 'cloud-operation-args.json');
    return saveJson(argsFile, args).then(() => {
      const output = execFileSync('/usr/local/bin/wechatide', ['-c', 'Codex', 'automation_evaluate', '--project', path.join(projectRoot, 'dist/release'), '--fn-source', source, '--args-file', argsFile], { encoding: 'utf8', timeout: 90000, maxBuffer: 5000000 });
      const result = JSON.parse(output.slice(output.indexOf('{')));
      if (result.pending || result.taskId || result.result?.pending || result.result?.taskId) throw new Error(`等待开发者工具确认，不重发操作: ${JSON.stringify(result)}`);
      assert.equal(result.ok, true, output);
      assert.equal(result.result?.success, true, output);
      const value = result.result?.result?.result;
      if (value?.error) throw Object.assign(new Error(value.error), { code: value.code });
      return value;
    });
  };
  const lock = await open(lockPath, 'wx');
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), sourceIds }));
  try {
    const baseline = await evaluate('async function(){const cloud=require("services/cloud.js");if(getApp().__communityFixture)throw new Error("存在测试夹具");await cloud.refreshCloud();const snapshot=await cloud.invokeCloud("bootstrap",{includeFeed:false});const cards=[];let cursor="";do{const page=await cloud.invokeCloud("feed",{cursor,compact:true});cards.push(...page.posts);cursor=page.cursor;if(cards.length>10000)throw new Error("广场较大，需服务端去重索引");}while(cursor);return {familyId:snapshot.familyId,revision:snapshot.revision,recipes:snapshot.snapshot.recipes,posts:cards};}');
    await saveJson(path.join(root, 'live-baseline.json'), { fetchedAt: new Date().toISOString(), ...baseline });
    assert.ok(baseline.familyId, '当前没有家庭');
    if (receipt.familyId) assert.equal(receipt.familyId, baseline.familyId, '当前家庭与上次导入不一致');
    receipt.familyId = baseline.familyId;
    for (const source of prepared) {
      const sourceUrl = source.raw.sourceUrl;
      const previous = receipt.recipes[sourceUrl];
      if (previous?.postId) {
        const published = await evaluate('async function(postId){return await require("services/cloud.js").invokeCloud("readPost",{postId,paginateComments:true});}', [previous.postId]);
        assert.equal(published.post.recipes[0].provenance.url, sourceUrl);
        console.log(`已发布，跳过：${source.raw.title}`);
        continue;
      }
      const existing = baseline.recipes.find(recipe => recipe.provenance?.url === sourceUrl);
      const existingPost = previous?.recipeId && baseline.posts.find(post => post.familyItemId === previous.recipeId);
      const sameMethod = baseline.recipes.find(item => item.id !== existing?.id && sameRecipeMethod(item, source.normalized.recipe));
      assert.ok(!sameMethod, `云端已有相同食材和做法 ${sameMethod?.title}，停止避免重复`);
      if (existing) assert.ok(previous?.recipeId === existing.id || previous?.stage === 'uploading' && previous.sourceFingerprint === source.normalized.contentFingerprint, '来源已在家庭中，不覆盖用户现有菜品');
      receipt.recipes[sourceUrl] = { ...previous, title: source.raw.title, sourceFingerprint: source.normalized.contentFingerprint, stage: 'uploading' };
      await saveJson(receiptPath, receipt);
      for (const [sourceHash, file] of source.files) {
        if (!receipt.uploads[sourceHash]) {
          await new Promise(resolve => setTimeout(resolve, 1600));
          const uploaded = await uploadArchivedImage(evaluate, file, baseline.familyId);
          assert.match(uploaded.fileId, /^cloud:\/\//);
          receipt.uploads[sourceHash] = { fileId: uploaded.fileId, protected: uploaded.protected, uploadHash: file.uploadHash, sourceHash, uploadedAt: new Date().toISOString() };
          await saveJson(receiptPath, receipt);
        }
      }
      const cloudAssets = Object.fromEntries(Object.entries(source.assets).map(([url, asset]) => [url, { ...asset, fileId: receipt.uploads[asset.sha256].fileId }]));
      const normalized = await materializePreparedSource(source, cloudAssets);
      assert.equal(normalized.ready, true, JSON.stringify(normalized.issues));
      assert.equal(normalized.publicPublishingAllowed, true, '正式发布必须使用核验过的云端图片');
      if (!existing) {
        const saved = await evaluate('async function(recipe,familyId){const cloud=require("services/cloud.js");if(cloud.cloudStatus.value.familyId!==familyId)throw new Error("家庭已变更");try{await cloud.remoteAction("saveRecipe",[recipe]);const result=await cloud.invokeCloud("bootstrap",{includeFeed:false});return result.snapshot.recipes.find(item=>item.provenance?.url===recipe.provenance.url);}catch(error){return {error:error.message,code:error.code};}}', [normalized.recipe, baseline.familyId]);
        assert.ok(saved?.id, '云端未返回已保存菜谱ID');
        receipt.recipes[sourceUrl].recipeId = saved.id;
        receipt.recipes[sourceUrl].stage = 'saved_private';
        await saveJson(receiptPath, receipt);
        assertSavedRecipe(saved, normalized.recipe);
        baseline.recipes.push(saved);
      } else {
        assertSavedRecipe(existing, normalized.recipe);
        receipt.recipes[sourceUrl].recipeId = existing.id;
        receipt.recipes[sourceUrl].stage = 'saved_private';
        await saveJson(receiptPath, receipt);
      }
      const record = receipt.recipes[sourceUrl];
      const published = existingPost
        ? await evaluate('async function(postId){return await require("services/cloud.js").invokeCloud("readPost",{postId,paginateComments:true});}', [existingPost.id])
        : await evaluate('async function(recipeId,familyId){const cloud=require("services/cloud.js");if(cloud.cloudStatus.value.familyId!==familyId)throw new Error("家庭已变更");try{const postId=await cloud.remoteAction("publishToCommunity",[recipeId,"dish"]);return await cloud.invokeCloud("readPost",{postId,paginateComments:true});}catch(error){return {error:error.message,code:error.code};}}', [record.recipeId, baseline.familyId]);
      assert.equal(published.post.status, 'published');
      assertSavedRecipe(published.post.recipes[0], normalized.recipe);
      Object.assign(record, { stage: 'published_verified', postId: published.post.id, publishedAt: new Date().toISOString(), steps: normalized.recipe.steps.length, images: source.files.size });
      await saveJson(path.join(source.directory, 'cloud-readback.json'), published);
      await saveJson(receiptPath, receipt);
      const queue = await readJson(path.join(root, 'queue.json'));
      Object.assign(queue.entries.find(entry => entry.sourceUrl === sourceUrl), { status: 'published', publishedPostId: record.postId, familyRecipeId: record.recipeId });
      await saveJson(path.join(root, 'queue.json'), queue);
      console.log(`已发布并回读：${source.raw.title}，${record.images} 张图`);
    }
    receipt.lastRunSucceeded = true;
    delete receipt.lastError;
  } catch (error) {
    receipt.lastRunSucceeded = false;
    receipt.lastError = { message: error.message, code: error.code, at: new Date().toISOString() };
    throw error;
  } finally {
    receipt.updatedAt = new Date().toISOString();
    try {
      await saveJson(receiptPath, receipt);
      await writeFile(path.join(root, 'cloud-operation-args.json'), '[]\n');
    } finally { await lock.close(); await unlink(lockPath); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
