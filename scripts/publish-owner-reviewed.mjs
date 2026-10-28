import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, rename, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv } from 'vite';
import { assertStagedRecipe, decodeDatabaseJson, verifyInsertResult } from './admin-recipe-import.mjs';
import { insertBatches, buildImportedPost } from './bulk-publish-authorized.mjs';
import { assertSavedRecipe, sameRecipeMethod } from './import-authorized-community.mjs';
import { encryptImage, decryptImage } from '../server/media-encryption.mjs';
import { createDisplayImage } from '../server/image-processing.mjs';

const execute = promisify(execFile);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const md5 = value => createHash('md5').update(value).digest('hex');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const optionalJson = async file => readJson(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
const saveJson = async (file, value) => { await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await rename(`${file}.tmp`, file); };
const parseOutput = stdout => JSON.parse(stdout.slice(stdout.indexOf('{')));

export function sourceDigest(documents) {
  return sha256(JSON.stringify(documents.map(document => [document._id, document.contentDigest]).sort((first, second) => first[0].localeCompare(second[0]))));
}

export function assertOwnerReview(review, documents, target) {
  assert.equal(review.kind, 'owner_reviewed_import_v1');
  assert.equal(review.method, 'user_confirmation');
  assert.equal(review.platformCheck, 'not_performed_for_this_import');
  assert.equal(review.env, target.env);
  assert.equal(review.appid, target.appid);
  assert.equal(review.sourceCount, documents.length);
  assert.equal(review.sourceDigest, sourceDigest(documents), '复核确认与本批数据不匹配');
  assert.ok(review.confirmation && review.recordedAt && review.authorizationId);
  assert.equal(new Set(documents.map(document => document.sourceUrl)).size, documents.length);
  documents.forEach(document => { assertStagedRecipe(document); assert.equal(document.target.env, target.env); assert.equal(document.target.appid, target.appid); });
}

export function missingExactRecords(expected, existing) {
  const indexed = new Map(existing.map(record => [record._id, record]));
  assert.equal(new Set(expected.map(record => record._id)).size, expected.length, '批次包含重复 ID');
  return expected.filter(record => {
    const previous = indexed.get(record._id);
    if (!previous) return true;
    for (const key of Object.keys(record)) assert.deepEqual(previous[key], record[key], `已有记录不一致，不覆盖：${record._id}.${key}`);
    return false;
  });
}

export function verifyStoredFiles(files, objects) {
  const indexed = new Map(objects.map(object => [object.key, object]));
  for (const file of files) {
    const actual = indexed.get(file.cloudPath);
    assert.ok(actual, `云端缺少图片：${file.cloudPath}`);
    assert.equal(Number(actual.size), file.size, `图片大小不符：${file.cloudPath}`);
    assert.equal(actual.eTag.replaceAll('"', '').toLowerCase(), file.md5, `图片字节不符：${file.cloudPath}`);
  }
}

export async function prepareEncryptedMedia(bytes, asset, context) {
  assert.equal(sha256(bytes), asset.uploadHash, '原图片摘要不符');
  const files = [];
  const save = (content, variant) => {
    const encrypted = encryptImage(content);
    assert.deepEqual(decryptImage(encrypted.bytes, encrypted.key), content);
    const name = `${asset.uploadHash}.${variant}.bin`;
    const cloudPath = `${context.cloudPrefix}/${name}`;
    files.push({ name, cloudPath, size: encrypted.bytes.length, sha256: sha256(encrypted.bytes), md5: md5(encrypted.bytes), bytes: encrypted.bytes });
    return { fileId: `${context.storageOrigin}/${cloudPath}`, encryptionKey: encrypted.key };
  };
  const original = save(bytes, 'original');
  const variants = {};
  for (const variant of ['card', 'detail']) {
    const display = await createDisplayImage(bytes, variant);
    variants[variant] = { ...save(display.bytes, variant), width: display.width, height: display.height, bytes: display.size, formatVersion: 1 };
  }
  const record = { _id: sha256(original.fileId), ...original, variants, userId: context.userId, familyId: context.familyId, confirmed: true, createdAt: context.createdAt, uploadHash: asset.uploadHash, importJobId: context.reviewId, contentReview: { method: 'user_confirmation', reviewId: context.reviewId, platformCheck: 'not_performed_for_this_import' } };
  return { record, files };
}

export function ownerReviewedPost(document, files, plan) {
  assertOwnerReview(plan.review, plan.documents, plan.config);
  assert.ok(plan.documents.some(source => source._id === document._id && source.contentDigest === document.contentDigest), '菜品不属于已确认批次');
  const post = buildImportedPost(document, files, plan.family, plan.family.ownerId, plan.review._id, plan.createdAt);
  return { ...post, contentReview: { method: 'user_confirmation', reviewId: plan.review._id, sourceDigest: document.contentDigest, platformCheck: 'not_performed_for_this_import' } };
}

async function run() {
  assert.ok(process.argv.includes('--live') && process.argv.includes('--owner-reviewed'), '须显式提供 --live --owner-reviewed；仅适用于用户已确认的本批内容');
  const batchId = process.argv.find(value => value.startsWith('--batch='))?.slice(8);
  assert.match(batchId || '', /^import-job-[a-f0-9]{32}$/);
  const phase = process.argv.find(value => value.startsWith('--phase='))?.slice(8) || 'prepare';
  assert.ok(['prepare', 'images', 'upload', 'publish', 'verify'].includes(phase));
  const root = path.resolve('artifacts/recipe-full');
  const previousRoot = path.join(root, 'bulk-publication-20260911');
  const output = path.join(root, `owner-reviewed-${batchId.slice(11)}`);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const lockPath = path.join(output, 'run.lock');
  const lock = await open(lockPath, 'wx');
  await lock.writeFile(JSON.stringify({ pid: process.pid, phase, at: new Date().toISOString() }));
  try {
    const cli = process.env.TCB_CLI;
    assert.ok(cli && path.isAbsolute(cli), '请指定官方 TCB_CLI 路径');
    const configuration = loadEnv('production', process.cwd(), '');
    const config = { env: configuration.VITE_CLOUD_ENV, appid: configuration.WEIXIN_APPID };
    const call = async command => {
      const { stdout } = await execute(cli, ['db', 'nosql', 'execute', '-e', config.env, '--command', command, '--json'], { maxBuffer: 24000000, timeout: 120000 });
      const response = parseOutput(stdout);
      assert.ok(!response.error && !response.Error && response.data?.results?.length === 1, '数据库响应异常');
      return response;
    };
    const readAll = async (collection, filter = {}) => {
      const rows = [];
      for (let skip = 0; skip < 20000; skip += 100) {
        const response = await call(JSON.stringify([{ TableName: collection, CommandType: 'QUERY', Command: JSON.stringify({ find: collection, filter, sort: { _id: 1 }, skip, limit: 100 }) }]));
        const page = decodeDatabaseJson(response.data.results[0]);
        assert.ok(Array.isArray(page));
        rows.push(...page);
        if (page.length < 100) return rows;
      }
      throw new Error('超出本批查询上限');
    };
    const insert = async (collection, records) => {
      for (const batch of insertBatches(collection, records)) {
        const file = path.join(output, `write-${collection}-${randomUUID()}.json`);
        const intent = { collection, ids: batch.rows.map(row => row._id), digest: sha256(batch.command), at: new Date().toISOString(), state: 'dispatching' };
        await saveJson(file, intent);
        const response = await call(batch.command);
        verifyInsertResult(response, batch.rows.length);
        await saveJson(file, { ...intent, state: 'returned', response });
        console.log(`${collection} 批量写入 ${batch.rows.length} 条`);
      }
    };
    const planFile = path.join(output, 'plan.json');
    if (phase === 'prepare') {
      assert.equal(await optionalJson(planFile), null, '已有计划，请从下一阶段续传');
      const previous = await readJson(path.join(previousRoot, 'plan.json'));
      assert.equal(previous.job._id, batchId);
      assert.equal(previous.config.env, config.env);
      assert.equal(previous.config.appid, config.appid);
      const [documents, posts, families, familyRecipes, jobs, tasks, media] = await Promise.all([
        readAll('imports', { kind: 'authorized_recipe_staging_v1' }), readAll('posts'), readAll('families', { _id: previous.family.id }),
        readAll('recipes', { familyId: previous.family.id }), readAll('imports', { _id: batchId }), readAll('imports', { jobId: batchId }), readAll('media', { familyId: previous.family.id, confirmed: true }),
      ]);
      assert.equal(jobs.length, 1);
      assert.ok(!tasks.some(task => task.state === 'running' && task.leaseUntil > Date.now()), '原处理任务仍在运行');
      assert.equal(families.length, 1);
      const family = families[0];
      assert.equal(family.ownerId, previous.family.ownerId);
      assert.equal(sourceDigest(documents), sourceDigest(previous.documents), '云端来源已发生变化');
      const known = posts.flatMap(post => post.recipes || []);
      for (const document of documents) {
        assertStagedRecipe(document);
        assert.ok(!known.some(recipe => recipe.provenance?.url === document.sourceUrl), '该来源已发布，先核对已有导入结果');
        assert.ok(!known.some(recipe => sameRecipeMethod(recipe, document.recipeDraft)), '存在相同食材和做法');
        known.push(document.recipeDraft);
      }
      const review = { _id: `owner-review-${batchId.slice(11)}`, kind: 'owner_reviewed_import_v1', method: 'user_confirmation', platformCheck: 'not_performed_for_this_import', confirmation: '不检查不能插入吗，不要检查了大哥，所有的数据我都看过，没有问题的', recordedAt: new Date().toISOString(), authorizationId: (await readJson(path.join(root, 'authorization.json'))).id, ...config, sourceCount: documents.length, sourceDigest: sourceDigest(documents), previousJobId: batchId };
      assertOwnerReview(review, documents, config);
      const mediaById = new Map(media.map(record => [record.fileId, record]));
      const reused = {};
      for (const [uploadHash, file] of Object.entries(previous.reused)) {
        const record = mediaById.get(file.fileId);
        assert.ok(record?.confirmed && record.encryptionKey, '复用图片缺少有效存储记录');
        if (record.variants?.card?.formatVersion === 1 && record.variants?.detail?.formatVersion === 1) reused[uploadHash] = record;
      }
      const assets = [...new Map(documents.flatMap(document => document.assets).map(asset => [asset.uploadHash, asset])).values()].filter(asset => !reused[asset.uploadHash]).map(asset => ({ ...asset }));
      for (const asset of assets) {
        asset.rawPath = path.join(previousRoot, 'raw-images', `${asset.uploadHash}.jpg`);
        const bytes = await readFile(asset.rawPath).catch(async error => {
          if (error.code !== 'ENOENT') throw error;
          const document = documents.find(entry => entry.assets.some(image => image.sha256 === asset.sha256));
          const sourceId = new URL(document.sourceUrl).pathname.split('/').filter(Boolean).at(-1);
          assert.match(sourceId, /^\d+$/);
          asset.rawPath = path.join(root, 'recipes', sourceId, 'upload', `${asset.sha256}.jpg`);
          return readFile(asset.rawPath);
        });
        assert.equal(sha256(bytes), asset.uploadHash);
      }
      const storageOrigin = previous.job.storageRoot.slice(0, previous.job.storageRoot.indexOf('/', 8));
      const plan = { config, review, documents, family, assets, reused, projections: previous.projections, storageOrigin, cloudPrefix: `approved/${family.id}/${review._id}`, createdAt: Date.now() };
      await saveJson(path.join(output, 'baseline.json'), { posts, family, familyRecipes });
      await saveJson(planFile, plan);
      await insert('imports', [review]);
      if (jobs[0].state === 'active') {
        const response = await call(JSON.stringify([{ TableName: 'imports', CommandType: 'UPDATE', Command: JSON.stringify({ update: 'imports', updates: [{ q: { _id: batchId, state: 'active', userId: family.ownerId }, u: { $set: { state: 'superseded', supersededBy: review._id, supersededAt: Date.now() } }, multi: false, upsert: false }], ordered: true }) }]));
        verifyInsertResult(response, 1);
        await saveJson(path.join(output, 'previous-job-superseded.json'), response);
      }
      console.log(JSON.stringify({ recipes: documents.length, newImages: assets.length, reusedImages: Object.keys(reused).length, reviewId: review._id }));
      return;
    }
    const plan = await readJson(planFile);
    assert.equal(plan.review.previousJobId, batchId);
    assertOwnerReview(plan.review, plan.documents, config);
    const reviews = await readAll('imports', { _id: plan.review._id });
    assert.equal(missingExactRecords([plan.review], reviews).length, 0, '缺少本批复核授权记录');
    const filesDirectory = path.join(output, 'files');
    const mediaDirectory = path.join(output, 'media');
    if (phase === 'images') {
      await mkdir(filesDirectory, { recursive: true });
      await mkdir(mediaDirectory, { recursive: true, mode: 0o700 });
      for (const [index, asset] of plan.assets.entries()) {
        const recordPath = path.join(mediaDirectory, `${asset.uploadHash}.json`);
        const previous = await optionalJson(recordPath);
        if (previous) {
          assert.equal(previous.record.uploadHash, asset.uploadHash);
          assert.equal(previous.record.importJobId, plan.review._id);
          for (const file of previous.files) assert.equal(sha256(await readFile(path.join(filesDirectory, file.name))), file.sha256);
        } else {
          const prepared = await prepareEncryptedMedia(await readFile(asset.rawPath), asset, { ...plan, userId: plan.family.ownerId, familyId: plan.family.id, reviewId: plan.review._id });
          for (const file of prepared.files) await writeFile(path.join(filesDirectory, file.name), file.bytes, { mode: 0o600 });
          await saveJson(recordPath, { record: prepared.record, files: prepared.files.map(({ bytes, ...file }) => file) });
        }
        if ((index + 1) % 100 === 0 || index + 1 === plan.assets.length) console.log(`图片处理 ${index + 1}/${plan.assets.length}`);
      }
      return;
    }
    const prepared = await Promise.all(plan.assets.map(asset => readJson(path.join(mediaDirectory, `${asset.uploadHash}.json`))));
    const files = prepared.flatMap(item => item.files);
    const records = prepared.map(item => item.record);
    for (const file of files) assert.equal(sha256(await readFile(path.join(filesDirectory, file.name))), file.sha256);
    const listStorage = async () => {
      const { stdout } = await execute(cli, ['storage', 'list', `${plan.cloudPrefix}/`, '-e', config.env, '--json'], { timeout: 120000, maxBuffer: 16000000 });
      const response = parseOutput(stdout);
      assert.ok(Array.isArray(response.data));
      return response.data;
    };
    if (phase === 'upload') {
      const objects = await listStorage();
      const indexed = new Map(objects.map(object => [object.key, object]));
      const present = files.filter(file => indexed.has(file.cloudPath));
      verifyStoredFiles(present, objects);
      if (present.length !== files.length) {
        const { stdout } = await execute(cli, ['storage', 'upload', filesDirectory, plan.cloudPrefix, '-e', config.env, '--times', '1', '--json'], { timeout: 1800000, maxBuffer: 24000000 });
        await writeFile(path.join(output, 'upload-output.txt'), stdout);
        const response = JSON.parse(stdout.slice(stdout.lastIndexOf('\n{') + 1));
        assert.equal(response.data?.failedCount, 0);
        assert.equal(response.data?.successCount, files.length);
      }
      const actual = await listStorage();
      verifyStoredFiles(files, actual);
      await saveJson(path.join(output, 'storage-verified.json'), { verifiedAt: new Date().toISOString(), files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0), sha256: sha256(JSON.stringify(files)), objects: actual });
      console.log(`已上传并逐文件核对 ${files.length} 个加密图片文件`);
      return;
    }
    const storage = await readJson(path.join(output, 'storage-verified.json'));
    assert.equal(storage.sha256, sha256(JSON.stringify(files)));
    verifyStoredFiles(files, await listStorage());
    const sources = await readAll('imports', { kind: 'authorized_recipe_staging_v1' });
    assert.equal(missingExactRecords(plan.documents, sources).length, 0, '来源已丢失或发生变化');
    const mediaBefore = await readAll('media', { familyId: plan.family.id, confirmed: true });
    const missingMedia = missingExactRecords(records, mediaBefore);
    if (phase === 'verify') assert.equal(missingMedia.length, 0, '图片记录尚未入库');
    else await insert('media', missingMedia);
    const media = await readAll('media', { familyId: plan.family.id, confirmed: true });
    assert.equal(missingExactRecords(records, media).length, 0);
    assert.equal(missingExactRecords(Object.values(plan.reused), media).length, 0, '复用图片记录已变化');
    const byHash = new Map([...Object.entries(plan.reused), ...records.map(record => [record.uploadHash, record])]);
    const posts = plan.documents.map(document => ownerReviewedPost(document, Object.fromEntries(document.assets.map(asset => {
      const record = byHash.get(asset.uploadHash);
      assert.ok(record?.confirmed && record.encryptionKey);
      return [asset.id, { fileId: record.fileId, uploadHash: asset.uploadHash, confirmed: true }];
    })), plan));
    const before = await readAll('posts');
    for (const post of posts) {
      const matches = before.filter(item => item.recipes?.some(recipe => recipe.provenance?.url === post.recipes[0].provenance.url));
      assert.ok(matches.length === 0 || (matches.length === 1 && matches[0]._id === post._id), '已有同来源帖子，不能重复或覆盖');
    }
    const missingPosts = missingExactRecords(posts, before);
    if (phase === 'verify') assert.equal(missingPosts.length, 0, '菜品尚未全部入库');
    else { await saveJson(path.join(output, 'posts-intent.json'), posts); await insert('posts', missingPosts); }
    const [actual, families, familyRecipes] = await Promise.all([readAll('posts'), readAll('families', { _id: plan.family.id }), readAll('recipes', { familyId: plan.family.id })]);
    assert.equal(missingExactRecords(posts, actual).length, 0);
    for (const post of posts) assertSavedRecipe(actual.find(item => item._id === post._id).recipes[0], post.recipes[0]);
    const published = actual.filter(post => post.status === 'published');
    const urls = published.flatMap(post => post.recipes.map(recipe => recipe.provenance?.url).filter(Boolean));
    assert.equal(new Set(urls).size, urls.length, '公开来源重复');
    const baseline = await readJson(path.join(output, 'baseline.json'));
    assert.equal(missingExactRecords(baseline.posts, actual).length, 0, '原有帖子被修改');
    assert.deepEqual(families[0], baseline.family, '家庭信息与批次前不同，请核对');
    assert.deepEqual(familyRecipes, baseline.familyRecipes, '家庭菜单与批次前不同，请核对');
    const receiptFile = path.join(root, 'publication-receipt.json');
    const receipt = await readJson(receiptFile);
    if (!await optionalJson(path.join(output, 'receipt-before.json'))) await saveJson(path.join(output, 'receipt-before.json'), receipt);
    for (const document of plan.documents) {
      const post = posts.find(item => item.recipes[0].provenance.url === document.sourceUrl);
      for (const asset of document.assets) receipt.uploads[asset.sha256] ||= { fileId: byHash.get(asset.uploadHash).fileId, uploadHash: asset.uploadHash, sourceHash: asset.sha256, protected: true, uploadedAt: new Date().toISOString(), contentReview: post.contentReview };
      receipt.recipes[document.sourceUrl] = { ...receipt.recipes[document.sourceUrl], sourceUrl: document.sourceUrl, title: post.title, stage: 'published_verified', postId: post.id, recipeId: post.recipes[0].id, method: 'owner_reviewed_admin_bulk', contentReview: post.contentReview, projectionFingerprint: plan.projections[document.sourceUrl], createdForBatch: false, publishedAt: post.publishedAt, verifiedAt: new Date().toISOString(), images: document.assets.length, steps: document.recipeDraft.steps.length };
    }
    receipt.updatedAt = new Date().toISOString();
    await saveJson(receiptFile, receipt);
    const verification = { verifiedAt: new Date().toISOString(), reviewId: plan.review._id, method: 'owner_reviewed_admin_bulk', batchPublished: posts.length, publicPosts: published.length, publicRecipes: published.reduce((count, post) => count + post.recipes.length, 0), categories: Object.fromEntries([...new Set(published.flatMap(post => post.categories))].sort().map(category => [category, published.filter(post => post.categories.includes(category)).length])), newMediaRecords: records.length, encryptedFiles: files.length, uniqueSources: urls.length, oldPostsUnchanged: true, familyUnchanged: true, familyMenuUnchanged: true, platformChecksInvoked: 0 };
    await saveJson(path.join(output, 'posts-after.json'), actual);
    await saveJson(path.join(output, 'verified.json'), verification);
    console.log(JSON.stringify(verification, null, 2));
  } finally { await lock.close(); await unlink(lockPath); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
