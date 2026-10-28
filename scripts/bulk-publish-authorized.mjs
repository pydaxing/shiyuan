import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, copyFile, rename, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv } from 'vite';
import { assertStagedRecipe, decodeDatabaseJson, materializeStagedRecipe, verifyInsertResult } from './admin-recipe-import.mjs';
import { prepareSource, sameRecipeMethod, assertSavedRecipe } from './import-authorized-community.mjs';
import { createIdeCaller } from './publish-authorized-batch.mjs';
import { createKitchenActions } from '../src/domain/actions.js';
import { emptySnapshot } from '../src/domain/empty.js';
import { imageReferences } from '../server/application.mjs';
import { OFFICIAL_PUBLISHER_ID, OFFICIAL_PUBLISHER_NAME } from '../src/domain/community-policy.js';

const execute = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const saveJson = async (file, value) => { await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`); await rename(`${file}.tmp`, file); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export const sourceDigest = documents => hash(JSON.stringify(documents.map(document => [document._id, document.contentDigest])));

export function buildImportedPost(document, files, family, userId, jobId, createdAt) {
  const recipe = { ...materializeStagedRecipe(document, files), id: `recipe-import-${hash(document.sourceUrl).slice(0, 32)}` };
  let snapshot = { ...emptySnapshot(), family, activeMemberId: userId, recipes: [recipe] };
  const postId = `post-import-${hash(document.sourceUrl).slice(0, 32)}`;
  const actions = createKitchenActions({ getState: () => snapshot, commit: value => { snapshot = value; }, newId: () => postId, today: () => new Date(createdAt).toISOString().slice(0, 10) });
  actions.publishToCommunity(recipe.id, 'dish');
  const post = { ...snapshot.posts[0], publishedAt: new Date(createdAt).toISOString(), publisherId: OFFICIAL_PUBLISHER_ID, publisherType: 'official', author: OFFICIAL_PUBLISHER_NAME };
  assertSavedRecipe(post.recipes[0], recipe);
  const card = { id: post.id, title: post.title, kind: post.kind, image: post.image, author: post.author, categories: post.categories, familyItemId: post.familyItemId, publisherId: post.publisherId, publisherType: post.publisherType, importedFamilyCount: 0, tall: false, recipes: post.recipes.map(item => ({ id: item.id, title: item.title, category: item.category, image: item.image, minutes: item.minutes })) };
  return { ...post, _id: postId, card, familyId: family.id, status: 'published', assetIds: imageReferences(post), importedFamilyCount: 0, search: JSON.stringify([post.title, ...post.recipes.map(item => [item.title, item.ingredients.map(ingredient => ingredient.name)])]).toLowerCase(), createdAt, importAudit: { jobId, sourceUrl: document.sourceUrl, sourceDigest: document.contentDigest } };
}

export function assertCompletedTasks(tasks, expected) {
  assert.equal(tasks.length, expected.length, '缺少导入处理回执');
  assert.equal(new Set(tasks.map(task => task._id)).size, tasks.length);
  for (const task of expected) {
    const actual = tasks.find(row => row._id === task._id);
    assert.equal(actual?.state, 'completed', `任务未完成：${task._id}`);
    assert.equal(actual.payloadHash, task.payloadHash);
    assert.deepEqual(actual.payload, task.payload);
    assert.equal(hash(JSON.stringify(actual.payload)), task.payloadHash);
  }
}

export function assertProcessAllowed(job, tasks, now = Date.now()) {
  assert.ok(job?.state === 'active' && job.expiresAt > now, '批量授权已失效，需先核对并重新授权，不能自动延期');
  assert.ok(tasks.every(task => task.expiresAt > now), '存在已过期的处理任务');
  assert.ok(!tasks.some(task => task.state === 'running' && task.leaseUntil > now), '仍有云端任务执行中，请先核对原任务');
}

export function insertBatches(collection, documents, maxBytes = 85000) {
  const command = rows => JSON.stringify([{ TableName: collection, CommandType: 'INSERT', Command: JSON.stringify({ insert: collection, documents: rows, ordered: true }) }]);
  const batches = [];
  let batch = [];
  for (const document of documents) {
    assert.ok(Buffer.byteLength(command([document])) <= maxBytes, '单条记录超出批量接口限制');
    if (batch.length && Buffer.byteLength(command([...batch, document])) > maxBytes) { batches.push(batch); batch = []; }
    batch.push(document);
  }
  if (batch.length) batches.push(batch);
  return batches.map(rows => ({ rows, command: command(rows) }));
}

async function run() {
  assert.ok(process.argv.includes('--live'), '此工具会写入云端，必须显式传入 --live');
  const phase = process.argv.find(arg => arg.startsWith('--phase='))?.slice(8) || 'prepare';
  assert.ok(['prepare', 'upload', 'process', 'publish', 'verify'].includes(phase));
  const root = path.resolve('artifacts/recipe-full');
  const output = path.join(root, 'bulk-publication-20260911');
  await mkdir(output, { recursive: true });
  const lockPath = path.join(output, 'run.lock');
  const lock = await open(lockPath, 'wx');
  await lock.writeFile(JSON.stringify({ pid: process.pid, phase, startedAt: new Date().toISOString() }));
  try {
    const config = loadEnv('production', process.cwd(), '');
    const cli = process.env.TCB_CLI;
    assert.ok(cli && path.isAbsolute(cli), '设置官方 TCB_CLI 绝对路径');
    const call = async command => {
      const { stdout } = await execute(cli, ['db', 'nosql', 'execute', '-e', config.VITE_CLOUD_ENV, '--command', command, '--json'], { encoding: 'utf8', maxBuffer: 16000000, timeout: 120000 });
      const response = JSON.parse(stdout.slice(stdout.indexOf('{')));
      assert.ok(!response.error && !response.Error && response.data?.results?.length === 1, JSON.stringify(response));
      return response;
    };
    const readAll = async (collection, filter = {}) => {
      const records = [];
      for (let skip = 0; skip < 10000; skip += 100) {
        const response = await call(JSON.stringify([{ TableName: collection, CommandType: 'QUERY', Command: JSON.stringify({ find: collection, filter, sort: { _id: 1 }, skip, limit: 100 }) }]));
        const rows = decodeDatabaseJson(response.data.results[0]);
        assert.ok(Array.isArray(rows));
        records.push(...rows);
        if (rows.length < 100) return records;
      }
      throw new Error('数据量超出本批检查上限');
    };
    const insert = async (collection, documents, label) => {
      for (const [index, batch] of insertBatches(collection, documents).entries()) {
        const intent = { collection, ids: batch.rows.map(row => row._id), digest: hash(batch.command), state: 'dispatching', at: new Date().toISOString() };
        const file = path.join(output, `${label}-${index}.json`);
        await saveJson(file, intent);
        const response = await call(batch.command);
        verifyInsertResult(response, batch.rows.length);
        await saveJson(file, { ...intent, state: 'returned', response });
        console.log(`${label}：${batch.rows.length} 条写入已返回`);
      }
    };
    const planFile = path.join(output, 'plan.json');
    if (phase === 'prepare') {
      const existingPlan = await readJson(planFile).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      assert.ok(!existingPlan, '已有计划，直接从下一阶段恢复，不创建重复任务');
      const [posts, documents, families] = await Promise.all([readAll('posts'), readAll('imports', { kind: 'authorized_recipe_staging_v1' }), readAll('families', { _id: (await readJson(path.join(root, 'publication-receipt.json'))).familyId })]);
      const family = families[0];
      assert.ok(family?.members.some(member => member.id === family.ownerId));
      const published = posts.filter(post => post.status === 'published');
      assert.equal(new Set(published.flatMap(post => post.recipes.map(recipe => recipe.provenance?.url).filter(Boolean))).size, published.flatMap(post => post.recipes.filter(recipe => recipe.provenance?.url)).length, '已有重复来源');
      const receipt = await readJson(path.join(root, 'publication-receipt.json'));
      const stamp = randomUUID().replaceAll('-', '');
      const jobId = `import-job-${stamp}`;
      const folder = path.join(output, 'raw-images');
      await mkdir(folder, { recursive: true });
      const selected = [];
      const reused = {};
      const assets = new Map();
      const projections = {};
      const known = published.flatMap(post => post.recipes);
      for (const document of documents) {
        if (known.some(recipe => recipe.provenance?.url === document.sourceUrl)) continue;
        assertStagedRecipe(document);
        assert.equal(document.target.env, config.VITE_CLOUD_ENV);
        assert.equal(document.target.appid, config.WEIXIN_APPID);
        if (known.some(recipe => sameRecipeMethod(recipe, document.recipeDraft))) continue;
        const sourceId = new URL(document.sourceUrl).pathname.split('/').filter(Boolean).at(-1);
        const prepared = await prepareSource(root, sourceId);
        assert.deepEqual(prepared.review, document.sourceReview);
        assert.equal(prepared.normalized.recipe.title, document.recipeDraft.title);
        assert.deepEqual(prepared.normalized.recipe.ingredients, document.recipeDraft.ingredients);
        assert.deepEqual(prepared.normalized.recipe.steps.map(({ title, text }) => ({ title, text })), document.recipeDraft.steps.map(({ title, text }) => ({ title, text })));
        projections[document.sourceUrl] = hash(JSON.stringify(prepared.normalized.recipe));
        for (const asset of document.assets) {
          const file = prepared.files.get(asset.sha256);
          assert.equal(file?.uploadHash, asset.uploadHash);
          const uploaded = receipt.uploads[asset.sha256];
          if (uploaded) {
            assert.equal(uploaded.uploadHash, asset.uploadHash);
            assert.equal(uploaded.protected, true);
            reused[asset.uploadHash] = { fileId: uploaded.fileId, uploadHash: asset.uploadHash, sourceHash: asset.sha256 };
          } else if (!assets.has(asset.uploadHash)) {
            await copyFile(file.path, path.join(folder, `${asset.uploadHash}.jpg`));
            assets.set(asset.uploadHash, { uploadHash: asset.uploadHash, sourceHash: asset.sha256 });
          }
        }
        selected.push(document);
        known.push(document.recipeDraft);
      }
      const confirmedMedia = await readAll('media', { familyId: family.id, confirmed: true });
      const mediaById = new Map(confirmedMedia.map(media => [media.fileId, media]));
      for (const item of Object.values(reused)) assert.ok(mediaById.get(item.fileId)?.encryptionKey, '复用媒体尚未确认');
      const example = Object.values(reused)[0]?.fileId || confirmedMedia[0]?.fileId;
      assert.ok(example?.startsWith(`cloud://${config.VITE_CLOUD_ENV}.`));
      const storageRoot = `${example.slice(0, example.indexOf('/', 8))}/authorized-import/${stamp}`;
      const payloads = [];
      const images = [...assets.values()].map(asset => ({ ...asset, rawFileId: `${storageRoot}/${asset.uploadHash}.jpg` }));
      for (let offset = 0; offset < images.length; offset += 8) payloads.push({ type: 'images', assets: images.slice(offset, offset + 8) });
      const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
      const job = { _id: jobId, kind: 'authorized_import_job_v1', state: 'active', userId: family.ownerId, familyId: family.id, expiresAt, storageRoot, sourceIds: selected.map(document => document._id), sourceDigest: sourceDigest(selected) };
      const tasks = payloads.map((payload, index) => ({ _id: `import-task-${stamp}-${index}`, kind: 'authorized_import_task_v1', jobId, payload, payloadHash: hash(JSON.stringify(payload)), state: 'queued', expiresAt }));
      const plan = { preparedAt: new Date().toISOString(), config: { env: config.VITE_CLOUD_ENV, appid: config.WEIXIN_APPID, functionName: config.VITE_CLOUD_FUNCTION }, family, job, tasks, documents: selected, reused, projections, existingCount: published.length };
      await saveJson(path.join(output, 'baseline.json'), { posts, documents, family });
      await saveJson(planFile, plan);
      await insert('imports', [job, ...tasks], 'prepare');
      console.log(JSON.stringify({ selected: selected.length, imageTasks: payloads.length, pendingImages: images.length, reusedImages: Object.keys(reused).length, existingCount: published.length, jobId }));
      return;
    }
    const plan = await readJson(planFile);
    assert.ok(plan.job.sourceDigest && plan.tasks.every(task => task.payload.type === 'images'), '旧版文本任务已停用，请使用 publish-owner-reviewed.mjs 导入，不复用旧处理计划');
    assert.equal(plan.config.env, config.VITE_CLOUD_ENV);
    assert.equal(plan.config.appid, config.WEIXIN_APPID);
    if (phase === 'upload') {
      const cloudPath = plan.job.storageRoot.slice(plan.job.storageRoot.indexOf('/', 8) + 1);
      const { stdout } = await execute(cli, ['storage', 'upload', path.join(output, 'raw-images'), cloudPath, '-e', config.VITE_CLOUD_ENV, '--times', '1', '--json'], { encoding: 'utf8', maxBuffer: 16000000, timeout: 1800000 });
      await writeFile(path.join(output, 'upload-output.txt'), stdout);
      const response = JSON.parse(stdout.slice(stdout.lastIndexOf('\n{') + 1));
      const expectedFiles = plan.tasks.filter(task => task.payload.type === 'images').reduce((count, task) => count + task.payload.assets.length, 0);
      assert.equal(response.data?.failedCount, 0, '存在未上传成功的文件');
      assert.equal(response.data?.successCount, expectedFiles, '上传成功数量不符');
      console.log(stdout.slice(-1600));
      return;
    }
    if (phase === 'process') {
      const [tasks, jobs] = await Promise.all([readAll('imports', { jobId: plan.job._id }), readAll('imports', { _id: plan.job._id })]);
      const expected = plan.tasks;
      assert.equal(tasks.length, expected.length);
      for (const task of tasks) assert.deepEqual(task.payload, expected.find(row => row._id === task._id)?.payload);
      assert.equal(jobs.length, 1, '批量授权不存在');
      assertProcessAllowed(jobs[0], tasks);
      const pending = tasks.filter(task => task.state !== 'completed');
      const callIde = createIdeCaller(process.cwd(), root);
      const status = await callIde('function(){return getApp().__bulkAuthorizedImport || null;}', []);
      assert.ok(!status || status.done, '已有批量任务运行中，请只读取进度');
      const source = `function(jobId,imageIds,target){
        const app=getApp();if(app.__communityFixture)throw new Error('存在测试夹具');
        const state=app.__bulkAuthorizedImport={jobId,done:false,completed:0,total:imageIds.length,phase:'images',failures:[],startedAt:new Date().toISOString()};
        const invoke=async taskId=>{const result=await wx.cloud.callFunction({name:target.functionName,config:{env:target.env},data:{action:'authorizedImport',jobId,taskId}});if(!result.result?.ok)throw Object.assign(new Error(result.result?.message||'导入响应异常'),{code:result.result?.code,serviceCode:result.result?.serviceCode});state.completed++;};
        const lanes=async(ids,count)=>{let index=0;let failed=false;await Promise.all(Array.from({length:count},async()=>{while(index<ids.length&&!failed){const taskId=ids[index++];try{await invoke(taskId);}catch(error){failed=true;state.failures.push({taskId,message:error.message,code:error.code,serviceCode:error.serviceCode});}}}));if(failed)throw new Error('批量处理停止，请核对错误后续传');};
        void(async()=>{try{await lanes(imageIds,2);state.ok=true;}catch(error){state.error=error.message;}finally{state.done=true;state.finishedAt=new Date().toISOString();}})();return {started:true,total:state.total};
      }`;
      await callIde(source, [plan.job._id, pending.map(task => task._id), plan.config]);
      while (true) {
        await delay(15000);
        const state = await callIde('function(){return getApp().__bulkAuthorizedImport;}', []);
        assert.equal(state.jobId, plan.job._id);
        await saveJson(path.join(output, 'processing.json'), state);
        console.log(JSON.stringify(state));
        if (state.done) { assert.equal(state.ok, true, JSON.stringify(state)); break; }
      }
      assertCompletedTasks(await readAll('imports', { jobId: plan.job._id }), expected);
      return;
    }
    const tasks = await readAll('imports', { jobId: plan.job._id });
    assertCompletedTasks(tasks, plan.tasks);
    assert.equal(sourceDigest(plan.documents), plan.job.sourceDigest);
    const allFiles = { ...plan.reused, ...Object.assign({}, ...tasks.map(task => task.results || {})) };
    const media = await readAll('media', { familyId: plan.family.id, confirmed: true });
    const mediaById = new Map(media.map(item => [item.fileId, item]));
    const currentSources = await readAll('imports', { kind: 'authorized_recipe_staging_v1' });
    const expected = plan.documents.map(document => {
      assertStagedRecipe(document);
      const currentSource = currentSources.find(source => source._id === document._id);
      assert.ok(currentSource, '来源草稿已不存在');
      assertStagedRecipe(currentSource);
      assert.equal(currentSource.contentDigest, document.contentDigest, '准备后来源发生变更');
      const files = Object.fromEntries(document.assets.map(asset => {
        const file = allFiles[asset.uploadHash];
        const record = mediaById.get(file?.fileId);
        assert.ok(record?.confirmed && record.encryptionKey, '缺少图片处理回执');
        if (!plan.reused[asset.uploadHash]) assert.ok(record.importJobId === plan.job._id && record.uploadHash === asset.uploadHash && record.variants?.card && record.variants?.detail, '图片缺少本批处理或展示版本');
        return [asset.id, { ...file, confirmed: true }];
      }));
      return buildImportedPost(document, files, plan.family, plan.family.ownerId, plan.job._id, Date.parse(plan.preparedAt));
    });
    const posts = await readAll('posts');
    const missing = [];
    for (const post of expected) {
      const matches = posts.filter(row => row.recipes?.some(recipe => recipe.provenance?.url === post.recipes[0].provenance.url));
      assert.ok(matches.length <= 1, '来源出现重复帖子');
      if (!matches.length) missing.push(post);
      else { assert.equal(matches[0].status, 'published'); assertSavedRecipe(matches[0].recipes[0], post.recipes[0]); }
    }
    if (phase === 'verify') assert.equal(missing.length, 0, '尚有菜品未发布');
    else {
      await saveJson(path.join(output, 'publish-intent.json'), { posts: missing, at: new Date().toISOString(), processedTaskIds: tasks.map(task => task._id) });
      await insert('posts', missing, 'publish');
    }
    const actual = await readAll('posts', { status: 'published' });
    for (const post of expected) {
      const matches = actual.filter(row => row.recipes?.some(recipe => recipe.provenance?.url === post.recipes[0].provenance.url));
      assert.equal(matches.length, 1, '发布后未找到唯一菜品');
      assertSavedRecipe(matches[0].recipes[0], post.recipes[0]);
      assert.deepEqual(matches[0].categories, post.categories);
      assert.deepEqual(matches[0].card, post.card);
      assert.deepEqual(matches[0].assetIds, post.assetIds);
    }
    const receiptPath = path.join(root, 'publication-receipt.json');
    const receipt = await readJson(receiptPath);
    await saveJson(path.join(output, 'publication-receipt-before.json'), receipt);
    for (const document of plan.documents) {
      for (const asset of document.assets) receipt.uploads[asset.sha256] ||= { ...allFiles[asset.uploadHash], sourceHash: asset.sha256, protected: true, uploadedAt: new Date().toISOString() };
      const post = actual.find(row => row.recipes?.some(recipe => recipe.provenance?.url === document.sourceUrl));
      receipt.recipes[document.sourceUrl] = { ...receipt.recipes[document.sourceUrl], sourceUrl: document.sourceUrl, title: post.title, stage: 'published_verified', postId: post.id, recipeId: post.recipes[0].id, method: 'admin_bulk', importJobId: plan.job._id, projectionFingerprint: plan.projections[document.sourceUrl], createdForBatch: false, publishedAt: post.publishedAt, verifiedAt: new Date().toISOString(), images: document.assets.length, steps: document.recipeDraft.steps.length };
    }
    receipt.updatedAt = new Date().toISOString();
    await saveJson(receiptPath, receipt);
    const verification = { verifiedAt: new Date().toISOString(), added: missing.length, verifiedBatch: expected.length, publicCount: actual.length, categories: Object.fromEntries([...new Set(actual.flatMap(post => post.categories))].map(category => [category, actual.filter(post => post.categories.includes(category)).length])), imageCount: Object.keys(allFiles).length, familyUntouched: true };
    await saveJson(path.join(output, 'verified.json'), verification);
    await saveJson(path.join(output, 'posts-after.json'), actual);
    const jobs = await readAll('imports', { _id: plan.job._id });
    assert.equal(jobs.length, 1);
    if (jobs[0].state === 'active') {
      const response = await call(JSON.stringify([{ TableName: 'imports', CommandType: 'UPDATE', Command: JSON.stringify({ update: 'imports', updates: [{ q: { _id: plan.job._id, state: 'active', userId: plan.family.ownerId }, u: { $set: { state: 'completed', completedAt: Date.now(), publishedIds: expected.map(post => post.id) } }, multi: false, upsert: false }], ordered: true }) }]));
      verifyInsertResult(response, 1);
      await saveJson(path.join(output, 'job-completed.json'), response);
    } else assert.equal(jobs[0].state, 'completed');
    console.log(JSON.stringify(verification, null, 2));
  } finally { await lock.close(); await unlink(lockPath); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
